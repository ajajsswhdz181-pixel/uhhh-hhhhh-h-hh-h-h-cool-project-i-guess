# MCP Bridge — PenguinMod / TurboWarp extension

`mcp-bridge-extension.js` is the project-side half of the MCP Bridge. It
connects a PenguinMod or TurboWarp project to the Cloudflare Worker via
WebSocket and lets the project define MCP tools.

## Quick start

1. Deploy the Worker and Durable Object using `wrangler.toml`.
2. Load `mcp-bridge-extension.js` as a custom extension in PenguinMod or
   TurboWarp.
3. In the project, use **connect to MCP server** with the exact URL:
   ```text
   wss://<your-worker-domain>/ws
   ```
   When `MCP_AUTH_TOKEN` is set on the Worker, append
   `?token=<MCP_AUTH_TOKEN>`.
4. Use **define a new tool...** to create tools and write scripts under the
   **when a tool is called** hat. Reply with **respond with [...]** or the
   explicit call-ID response blocks.
5. Ask the MCP client for `tools/list` after the extension has connected.

Tool definitions are stored in a hidden Stage variable, so they are saved in
the project rather than browser storage. The extension deliberately does not
reconnect automatically after a WebSocket close; run the connect block again.

## Protocol

The extension and Worker use JSON text frames:

* Worker → extension: `manifest_req` and `call`.
* Extension → Worker: `manifest`, `result`, and `raw_result`.
* Empty text frames are Worker keepalives and are ignored by the extension.

The Worker accepts WebSocket upgrade header token casing case-insensitively,
but it only upgrades the `/ws` route. Connecting a WebSocket tester to `/` or
`/mcp` is an HTTP handshake rejection, which many testers display as `1006`.
