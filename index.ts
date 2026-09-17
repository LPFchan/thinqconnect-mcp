// thinqconnect Worker: MCP server on Cloudflare Workers, port of the
// Python thinqconnect-mcp (LG ThinQ Connect OpenAPI). Authenticates machine
// tokens and OAuth tokens directly against Common Auth instead of the
// loopback gateway.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface Env {
  AUTH_URL: string;
  TOKEN_SCOPE: string;
  THINQ_PAT: string; // wrangler secret
  THINQ_COUNTRY: string; // e.g. "KR"
}

// --- auth (same pattern as tweet-fetch-mcp Worker) ---------------------------

interface Identity {
  sub: string;
  email: string;
  name: string;
  role: string;
  services?: string[];
}

// Validate a credential against Common Auth. Two token types:
//   - machine tokens: GET /api/whoami?service=<scope>
//   - OAuth access tokens: GET /api/oauth/introspect?resource=<resource>&scope=<scope>
async function validateToken(env: Env, token: string, requestUrl: string): Promise<Identity | null> {
  const resource = new URL(requestUrl).origin + "/mcp";

  try {
    const url = new URL("/api/whoami", env.AUTH_URL);
    url.searchParams.set("service", env.TOKEN_SCOPE);
    const resp = await fetch(url.toString(), {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const identity = (await resp.json()) as Identity;
      if (identity.sub && identity.email && identity.name &&
          (identity.role === "administrator" || identity.role === "user")) {
        return identity;
      }
    }
  } catch { /* fall through to introspect */ }

  try {
    const url = new URL("/api/oauth/introspect", env.AUTH_URL);
    url.searchParams.set("resource", resource);
    url.searchParams.set("scope", env.TOKEN_SCOPE);
    const resp = await fetch(url.toString(), {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const identity = (await resp.json()) as Identity;
      if (identity.sub && identity.email && identity.name &&
          (identity.role === "administrator" || identity.role === "user")) {
        return identity;
      }
    }
  } catch { /* reject */ }

  return null;
}

function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  return null;
}

// MCP OAuth 2.0 Protected Resource Metadata discovery header.
function wwwAuthenticate(request: Request, scope: string): string {
  const url = new URL(request.url);
  const metadata = url.origin + "/.well-known/oauth-protected-resource/mcp";
  return 'Bearer realm="auth.lost.plus", resource_metadata="' + metadata + '", scope="' + scope + '", error="invalid_token"';
}

// --- ThinQ Connect OpenAPI ----------------------------------------------------
// Reimplementation of the thinqconnect Python library's HTTP layer.
// Base URL: https://api-<region>.lgthinq.com, region derived from country.
// Regions: kic (Korea + others), aic (Americas), eic (Europe). KR -> kic.

const COUNTRY_TO_REGION: Record<string, string> = {
  KR: "kic", JP: "kic", US: "aic", CA: "aic", MX: "aic",
  GB: "eic", DE: "eic", FR: "eic", IT: "eic", ES: "eic",
};

function thinqBaseUrl(country: string): string {
  const region = COUNTRY_TO_REGION[country.toUpperCase()] ?? "kic";
  return "https://api-" + region + ".lgthinq.com";
}

function messageId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function thinqRequest(env: Env, method: string, endpoint: string, body?: unknown): Promise<any> {
  const url = thinqBaseUrl(env.THINQ_COUNTRY) + "/" + endpoint;
  const resp = await fetch(url, {
    method,
    headers: {
      authorization: "Bearer " + env.THINQ_PAT,
      "x-country": env.THINQ_COUNTRY,
      "x-message-id": messageId(),
      "x-service-phase": "OP",
      "x-conditional-control": "true",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error("ThinQ API HTTP " + resp.status + " for " + endpoint);
  const data = (await resp.json()) as any;
  // ThinQ wraps responses in { response: ... } for most endpoints.
  return data && typeof data === "object" && "response" in data ? data.response : data;
}

const getDeviceList = (env: Env) => thinqRequest(env, "GET", "devices");
const getDeviceProfile = (env: Env, id: string) => thinqRequest(env, "GET", "devices/" + id + "/profile");
const getDeviceStatus = (env: Env, id: string) => thinqRequest(env, "GET", "devices/" + id + "/state");
const postDeviceControl = (env: Env, id: string, payload: unknown) =>
  thinqRequest(env, "POST", "devices/" + id + "/control", payload);

// snake_case -> camelCase (ThinQ control payload keys are camelCase).
function toCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// --- MCP server ---------------------------------------------------------------

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

const WELCOME_PROMPT = [
  "# Welcome to ThinQ Connect MCP Server",
  "",
  "Through the ThinQ Connect MCP server, you can manage and query ThinQ devices",
  "using natural language via the ThinQ Connect Open API platform.",
  "",
  "## Available Operations",
  "1. Device List Query — query all registered devices",
  "2. Device Information Query — query device status and available controls",
  "3. Device Control — turn devices on/off, change settings",
  "",
  "## Usage Examples:",
  "- Please provide a list of all devices",
  "- Please check the status of the robot vacuum device",
  "- Please set the temperature of the air conditioner device to 24 degrees",
].join("\n");

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "thinqconnect-mcp", version: "0.2.0" });

  server.tool(
    "get_device_list",
    "Get the list of all ThinQ devices registered to the account, with device ID, name, type, and model.",
    {},
    async () => {
      try {
        const devices = (await getDeviceList(env)) as any[];
        const list = Array.isArray(devices) ? devices : [];
        const info = list.map((d: any) =>
          "Device ID: " + d.deviceId + "\n" +
          "Device Name: " + d.deviceInfo?.alias + "\n" +
          "Device Type: " + d.deviceInfo?.deviceType + "\n" +
          "Model Name: " + d.deviceInfo?.modelName + "\n"
        );
        return text("Found " + list.length + " devices:\n\n" + info.join("\n"));
      } catch (e) {
        return text("An error occurred while retrieving device list: " + String(e));
      }
    },
  );

  server.tool(
    "get_device_available_controls",
    "Get the profile and controllable (writable) properties of a device. Use this before post_device_control to learn which properties exist.",
    { device_type: z.string().describe("Device type, e.g. DEVICE_AIR_CONDITIONER"),
      device_id: z.string().describe("Device ID from get_device_list") },
    async ({ device_type, device_id }) => {
      try {
        const profile = await getDeviceProfile(env, device_id);
        return text(
          "# Device Profile for " + device_type + " (" + device_id + ")\n\n" +
          "The profile below lists this device's properties. Writable properties are the ones " +
          "you may pass to post_device_control (convert snake_case to camelCase).\n\n" +
          JSON.stringify(profile, null, 2)
        );
      } catch (e) {
        return text("An error occurred while retrieving device details: " + String(e));
      }
    },
  );

  server.tool(
    "post_device_control",
    "Control a device by setting properties. control_params keys are property names (snake_case or camelCase); they are sent to the ThinQ API as camelCase.",
    { device_type: z.string().describe("Device type, e.g. DEVICE_AIR_CONDITIONER"),
      device_id: z.string().describe("Device ID from get_device_list"),
      control_method: z.string().describe("Informative name of the control, e.g. set_air_con_operation_mode"),
      control_params: z.record(z.any()).describe("Property key/value pairs to set") },
    async ({ device_type, device_id, control_method, control_params }) => {
      try {
        const camel: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(control_params ?? {})) camel[toCamel(k)] = v;
        await postDeviceControl(env, device_id, camel);
        return text("Device control completed. Command: " + control_method +
          ", Parameters: " + JSON.stringify(control_params));
      } catch (e) {
        return text("An error occurred during device control: " + String(e) +
          ", Command: " + control_method + ", Parameters: " + JSON.stringify(control_params));
      }
    },
  );

  server.tool(
    "get_device_status",
    "Retrieve the current status of a specific device.",
    { device_id: z.string().describe("Device ID from get_device_list") },
    async ({ device_id }) => {
      try {
        const status = await getDeviceStatus(env, device_id);
        return text("Device status information is as follows.\n## Status Information\n" +
          JSON.stringify(status, null, 2));
      } catch (e) {
        return text("An error occurred while retrieving device status: " + String(e));
      }
    },
  );

  server.prompt(
    "welcome",
    "I want to know how to use the ThinQ Connect MCP Server",
    () => ({ messages: [{ role: "user", content: { type: "text", text: WELCOME_PROMPT } }] }),
  );

  return server;
}

// --- CORS ---------------------------------------------------------------------

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, x-api-key",
    "access-control-max-age": "86400",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, content-type",
  };
  if (origin) h["access-control-allow-origin"] = origin;
  return h;
}

// --- entry --------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true }, { headers: corsHeaders(origin) });
    }

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
        url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json(
        {
          authorization_servers: ["https://auth.lost.plus"],
          bearer_methods_supported: ["header"],
          resource: url.origin + "/mcp",
          scopes_supported: [env.TOKEN_SCOPE],
        },
        { headers: { ...corsHeaders(origin), "cache-control": "no-store" } },
      );
    }

    if (url.pathname === "/" || url.pathname === "") {
      return Response.json(
        {
          name: "thinqconnect-mcp",
          runtime: "cloudflare-workers",
          mcp_path: "/mcp",
          healthz: "/healthz",
          tools: ["get_device_list", "get_device_available_controls", "post_device_control", "get_device_status"],
        },
        { headers: corsHeaders(origin) },
      );
    }

    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
      return new Response("not found", { status: 404, headers: corsHeaders(origin) });
    }

    const token = extractToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "content-type": "application/json", "www-authenticate": wwwAuthenticate(request, env.TOKEN_SCOPE) },
      });
    }
    const identity = await validateToken(env, token, request.url);
    if (!identity) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "content-type": "application/json", "www-authenticate": wwwAuthenticate(request, env.TOKEN_SCOPE) },
      });
    }

    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  },
};
