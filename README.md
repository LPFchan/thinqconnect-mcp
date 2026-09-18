![Local Image](https://www.lge.co.kr/kr/main/thinq/images/main/thinq_logo.png)


# ThinQ Connect MCP Server (Beta)
This MCP server controls LG ThinQ devices — status monitoring, device
control, and profile queries — via the LG ThinQ Connect Open API.

## Deployment: Cloudflare Worker (primary)

The primary deployment is a Cloudflare Worker (`index.ts`), so the MCP
endpoint stays up even when the OCI box is down. The Worker authenticates
machine tokens and OAuth tokens directly against Common Auth
(`https://auth.lost.plus`) with the `thinqconnect` scope, and calls the
ThinQ Open API over HTTPS — no Python SDK in the request path.

Deploy:

```bash
npm install
npx wrangler secret put THINQ_PAT   # LG ThinQ personal access token (secret, never in git)
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy \
  --route 'thinq.lost.plus/mcp' --route 'thinq.lost.plus/mcp/*' \
  --route 'thinq.lost.plus/healthz' \
  --route 'thinq.lost.plus/.well-known/oauth-protected-resource*'
```

(The explicit `--route` flags are deliberate: wrangler 3.x ignores the
`routes` table in `wrangler.toml` on deploy, so routes are passed on the
command line. The table stays in the file as documentation.)

Configuration in `wrangler.toml`: `AUTH_URL`, `TOKEN_SCOPE`,
`THINQ_COUNTRY` (e.g. `KR`). `THINQ_PAT` is a wrangler **secret** —
never commit it.

## Local development: Python server

The original Python server (built on the LG ThinQ API and Python Open SDK)
lives under `python/` and remains available for local development and as a
fallback. MCP connection method for the Python server is stdio or HTTP. See
`python/` for `pyproject.toml` and the server sources.

The HTTP deployment uses the official MCP Python SDK v2 and supports the
`2026-07-28` stateless protocol via `server/discover`, with a stateless legacy
fallback for clients that still use `initialize`. Stdio remains available for
local clients.

The production HTTP endpoint is `https://thinq.lost.plus/mcp`. The shared
Common Auth gateway protects it with the `thinqconnect` scope. Send a Common
Auth token as `Authorization: Bearer <token>` or `X-API-Key: <token>`. The HTTP
backend does not authenticate requests itself and must remain bound to localhost
behind the gateway. Stdio clients are unaffected.
Standalone HTTP runs default to loopback; the production container explicitly
binds `0.0.0.0` only inside its loopback-published Docker boundary.

![ThinQ Connect MCP Demo](demo.gif)

## Tests

Two suites, run separately, asserted against the same files:

```sh
npm test                                    # Worker  (vitest)
cd python && .venv/bin/python -m pytest      # Python  (pytest)
```

The fixtures in `test/fixtures/` and the expected output in
`test/fixtures/expected/` are shared by both suites. Each port formats the same
fixture and is compared to the same golden bytes, so a change to one
implementation's output fails that implementation's suite while the other keeps
passing — which is what tells you the two have drifted apart.

The Python suite imports only `thinqconnect_mcp.formatting`, which depends on
nothing outside the standard library, so it runs without the `thinqconnect` SDK
or any LG credentials. Create its environment with
`cd python && uv venv .venv && uv pip install --python .venv/bin/python pytest`.

## Worker/Python divergences

The Worker is not a behavioral clone of the Python server. Two of the four
tools produce matching output and are parity-tested; the other two were
deliberately redefined, because the Python versions depend on the
`thinqconnect` SDK's device classes, which have no equivalent on Workers.

| Tool | Status |
| --- | --- |
| `get_device_list` | **Identical.** Parity-tested against a shared golden. |
| `get_device_status` | **Identical.** Parity-tested. The status body is serialized as JSON on both sides — Python originally interpolated the dict with `str()`, which no JSON serializer can reproduce. |
| `get_device_available_controls` | **Different.** Python builds a control-instruction guide, deriving writable properties and method signatures by introspecting an SDK device object. The Worker returns the raw profile JSON with a short preamble. |
| `post_device_control` | **Different contract.** Python resolves `control_method` (e.g. `set_air_con_operation_mode`) to an SDK method and lets the SDK map it to the underlying property. The Worker ignores `control_method` and sends the camelCased `control_params` keys straight to the API, so those keys must already be real property names. A call that works against the Python server can send a different request against the Worker. |

Two smaller differences are asserted in both suites so they stay visible:

- **Whole-number floats.** Python renders `23.0`; `JSON.stringify` renders `23`.
- **Malformed device entries.** A device missing `deviceInfo` makes Python raise
  `AttributeError`, which its caller converts into an error string. The Worker
  uses optional chaining and prints the literal `undefined`.

Nothing here is covered by an end-to-end test against a live device. The
`post_device_control` difference in particular can only be confirmed against
real hardware.

## Table of Contents


- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Usage](#detailed-usage)
- [Tool Reference](#tool-reference)


## Features

- **Device List Query**  
  Retrieve a list of all registered LG ThinQ devices.

- **Device Status Monitoring**  
  Get real-time status information for specific devices.

- **Device Control**  
  Execute control commands defined in each device's profile.  
  (e.g., turn air conditioner on/off, set temperature, etc.)

- **Device Control Capabilities Query**  
  Provide detailed information about controllable properties, methods information for each device.

---

## Prerequisites
1. Prepare a [Personal Access Token](https://github.com/thinq-connect/pythinqconnect/blob/main/README.md#obtaining-and-using-a-personal-access-token) for ThinQ Open API calls
2. Verify your ThinQ account's country code. You can find it in the [Country Codes](https://github.com/thinq-connect/pythinqconnect/blob/main/README.md#country-codes) section.
3. Python 3.11 or higher
4. Install [uv](https://docs.astral.sh/uv/) - A fast Python package installer and resolver for Python projects
5. MCP client (Claude Desktop, etc.)


---


## Quick Start

### Claude Desktop
Open up the configuration file, and add ThinQ Connect MCP config.
* macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
* Windows: %APPDATA%\Claude\claude_desktop_config.json
```json
{
  "mcpServers": {
    "thinqconnect-mcp": {
      "command": "uvx",
      "args": [
        "thinqconnect-mcp"
      ],
      "env": {
          "THINQ_PAT": "your_personal_access_token_here",
          "THINQ_COUNTRY": "your_country_code_here"
      }
    }
  }
}
```

---

## Detailed Usage

After setting up the configuration file as shown in the Quick Start section, you can use the ThinQ Connect MCP Server directly in your conversations with Claude.

Examples of prompts you can use:

 * "Please provide a list of all devices"
 * "Please check the status of the robot vacuum device"
 * "Please set the temperature of the air conditioner device to 24 degrees"


---

## Tool Reference

### Available Tools

1. **get_device_list**
   - Description: Retrieves a list of all devices connected to the ThinQ Connect platform
   - Parameters: None
   - Returns: String containing connected device list information

2. **get_device_available_controls**
   - Description: Retrieves available control commands and parameter information for a specific device
   - Parameters: device_type (string), device_id (string)
   - Returns: String containing device control commands and parameter information

3. **get_device_status**
   - Description: Retrieves status information for a specific device
   - Parameters: device_id (string)
   - Returns: String containing device status information

4. **post_device_control**
   - Description: Send control commands to a specific device on the ThinQ Connect platform to change its settings or state
   - Parameters: device_type (string), device_id (string), control_method (string), control_params (dict)
   - Returns: String containing device control result message
