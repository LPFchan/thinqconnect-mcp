import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

// thinqconnect Worker: MCP server on Cloudflare Workers, port of the
// Python thinqconnect-mcp (LG ThinQ Connect OpenAPI).
//
// A route-less backend behind the gateway Worker. It authenticates nobody:
// the gateway has already asked auth.lost.plus who the caller is, and hands
// the answer over in x-lost-plus-* headers. See identity.ts, and the routes
// comment in wrangler.toml for why this Worker holds no route of its own.
//
// THINQ_PAT is unaffected by the cutover. It is this service's credential to
// LG, not a caller's credential to this service, and it stays a secret on
// this Worker.
import { z } from "zod";
import { identityFrom } from "./identity";

export interface Env {
  THINQ_PAT: string; // wrangler secret
  THINQ_COUNTRY: string; // e.g. "KR"
}

// --- ThinQ Connect OpenAPI ----------------------------------------------------
// Reimplementation of the thinqconnect Python library's HTTP layer.
// Base URL: https://api-<region>.lgthinq.com, region derived from country.
// Regions: kic (Korea + others), aic (Americas), eic (Europe). KR -> kic.

const COUNTRY_TO_REGION: Record<string, string> = {
  KR: "kic", JP: "kic", US: "aic", CA: "aic", MX: "aic",
  GB: "eic", DE: "eic", FR: "eic", IT: "eic", ES: "eic",
};

// The ThinQ Open API requires this public x-api-key header on every call —
// it's hardcoded in the official thinqconnect SDK (const.py), not a secret.
const THINQ_API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";
const THINQ_CLIENT_ID = "thinqconnect-mcp-client";

export function thinqBaseUrl(country: string): string {
  const region = COUNTRY_TO_REGION[country.toUpperCase()] ?? "kic";
  return "https://api-" + region + ".lgthinq.com";
}

// ThinQ wraps most endpoints in { response: ... }; a few return the body bare.
export function unwrapThinqResponse(data: unknown): unknown {
  return data && typeof data === "object" && "response" in (data as object)
    ? (data as any).response
    : data;
}

export function messageId(): string {
  // SDK format: url-safe base64 of 16 random bytes, padding stripped.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function thinqRequest(env: Env, method: string, endpoint: string, body?: unknown): Promise<any> {
  const url = thinqBaseUrl(env.THINQ_COUNTRY) + "/" + endpoint;
  const resp = await fetch(url, {
    method,
    headers: {
      authorization: "Bearer " + env.THINQ_PAT,
      "x-country": env.THINQ_COUNTRY,
      "x-message-id": messageId(),
      "x-client-id": THINQ_CLIENT_ID,
      "x-api-key": THINQ_API_KEY,
      "x-service-phase": "OP",
      "x-conditional-control": "true",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error("ThinQ API HTTP " + resp.status + " for " + endpoint);
  return unwrapThinqResponse(await resp.json());
}

const getDeviceList = (env: Env) => thinqRequest(env, "GET", "devices");
const getDeviceProfile = (env: Env, id: string) => thinqRequest(env, "GET", "devices/" + id + "/profile");
const getDeviceStatus = (env: Env, id: string) => thinqRequest(env, "GET", "devices/" + id + "/state");
const postDeviceControl = (env: Env, id: string, payload: unknown) =>
  thinqRequest(env, "POST", "devices/" + id + "/control", payload);

// snake_case -> camelCase (ThinQ control payload keys are camelCase).
export function toCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// --- output formatters --------------------------------------------------------
// These mirror python/thinqconnect_mcp/formatting.py byte for byte. Both sides
// are checked against the shared golden files in test/fixtures/expected/, so a
// change here without the matching change there fails both test suites.

export function formatDeviceList(devices: unknown): string {
  const list = Array.isArray(devices) ? devices : [];
  const info = list.map((d: any) =>
    "Device ID: " + d.deviceId + "\n" +
    "Device Name: " + d.deviceInfo?.alias + "\n" +
    "Device Type: " + d.deviceInfo?.deviceType + "\n" +
    "Model Name: " + d.deviceInfo?.modelName + "\n"
  );
  return "Found " + list.length + " devices:\n\n" + info.join("\n");
}

export function formatDeviceStatus(status: unknown): string {
  return (
    "Device status information is as follows.\n" +
    "Please relay appropriately to the user.\n" +
    "## Status Information\n" +
    JSON.stringify(status, null, 2) +
    "\n"
  );
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

  server.registerTool("get_device_list", { description: "Get the list of all ThinQ devices registered to the account, with device ID, name, type, and model.", inputSchema: z.object({}) }, async () => {
              try {
                const devices = await getDeviceList(env);
                return text(formatDeviceList(devices));
              } catch (e) {
                return text("An error occurred while retrieving device list: " + String(e));
              }
            });

  server.registerTool("get_device_available_controls", { description: "Get the profile and controllable (writable) properties of a device. Use this before post_device_control to learn which properties exist.", inputSchema: z.object({ device_type: z.string().describe("Device type, e.g. DEVICE_AIR_CONDITIONER"),
              device_id: z.string().describe("Device ID from get_device_list") }) }, async ({ device_type, device_id }) => {
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
            });

  server.registerTool("post_device_control", { description: "Control a device by setting properties. control_params keys are property names (snake_case or camelCase); they are sent to the ThinQ API as camelCase.", inputSchema: z.object({ device_type: z.string().describe("Device type, e.g. DEVICE_AIR_CONDITIONER"),
              device_id: z.string().describe("Device ID from get_device_list"),
              control_method: z.string().describe("Informative name of the control, e.g. set_air_con_operation_mode"),
              control_params: z.record(z.string(), z.any()).describe("Property key/value pairs to set") }) }, async ({ device_type, device_id, control_method, control_params }) => {
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
            });

  server.registerTool("get_device_status", { description: "Retrieve the current status of a specific device.", inputSchema: z.object({ device_id: z.string().describe("Device ID from get_device_list") }) }, async ({ device_id }) => {
              try {
                const status = await getDeviceStatus(env, device_id);
                return text(formatDeviceStatus(status));
              } catch (e) {
                return text("An error occurred while retrieving device status: " + String(e));
              }
            });

  server.registerPrompt("welcome", { description: "I want to know how to use the ThinQ Connect MCP Server" }, () => ({ messages: [{ role: "user", content: { type: "text", text: WELCOME_PROMPT } }] }));

  return server;
}

// --- entry --------------------------------------------------------------------

/**
 * No identity headers, so no service.
 *
 * The only way to reach this Worker is through a service binding declared by
 * another Worker in the account, and the only Worker that declares one is the
 * gateway, which never forwards a request it has not authorized. So arriving
 * here without an identity means the deployment is wrong -- the gateway's
 * route for this host lost its `mcp` policy, or something else in the account
 * bound to this Worker directly.
 *
 * 500 rather than 401, because it is true. A 401 would tell the caller to
 * authenticate, and the caller may well have done so correctly; the fault is
 * on this side of the binding. Serving the tools anyway is the specific
 * failure the whole gateway arrangement exists to prevent, so this refuses.
 *
 * It matters more here than on the other MCP backends: these tools actuate
 * physical appliances, so an unauthenticated request that reached the tools
 * would not merely read data.
 */
function refused(): Response {
  return Response.json(
    { error: "no gateway identity", detail: "this service is only reachable through the gateway" },
    { status: 500 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Before routing, not after. There is no path here that serves without an
    // identity, so there is no reason for one to be reachable before the check.
    const identity = identityFrom(request.headers);
    if (identity === null) return refused();

    const url = new URL(request.url);

    // /healthz and /.well-known/oauth-protected-resource are gone from here.
    // The gateway answers both now, which is why healthz changed shape: `ok`
    // as text/plain rather than `{"ok":true}` as JSON. Anything checking the
    // body rather than the status needs updating.
    if (url.pathname === "/" || url.pathname === "") {
      return Response.json({
        name: "thinqconnect-mcp",
        runtime: "cloudflare-workers",
        mcp_path: "/mcp",
        caller: { sub: identity.sub, email: identity.email, name: identity.name, role: identity.role },
        tools: ["get_device_list", "get_device_available_controls", "post_device_control", "get_device_status"],
      });
    }

    // `/mcp/*` as well as `/mcp`, which this service accepted before the
    // cutover and keeps accepting. The gateway's route for this host has no
    // path_prefix, so both arrive here.
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
      return new Response("not found", { status: 404 });
    }

    // CORS is the gateway's now: under the `mcp` policy it strips
    // access-control-allow-origin and -expose-headers from whatever the
    // backend returns and sets its own (gateway src/responseRewrite.ts).
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
