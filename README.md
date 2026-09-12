# MCP Bridge — PenguinMod / TurboWarp ⇄ Cloudflare Worker

An MCP (Model Context Protocol) server that lives on a Cloudflare Worker and
serves tools you define **inside a PenguinMod or TurboWarp project**. An MCP
client calls `tools/list` and `tools/call` over HTTP; the Worker relays each
call down a WebSocket to the running project, which answers with Scratch blocks.

```
MCP client ──HTTP POST──> Worker (the MCP server) ──WebSocket──> PenguinMod project
                              │
                              └─ Durable Object: holds the socket, the pending
                                 calls, and the cached tool manifest
```

| File | What it is |
| --- | --- |
| `src/index.js` | The Worker. Contains the MCP server *and* the `McpBridge` Durable Object. |
| `mcp-bridge-extension.js` | The custom extension you load into PenguinMod / TurboWarp. |
| `scripts/ws-check.mjs` | Diagnostic: performs the WebSocket handshake by hand and prints what a 1006 hides. |
| `wrangler.toml` | Worker config: the DO binding, the migration, the optional vars. |

## Quick start

```bash
npm install
npx wrangler deploy
```

1. **Check the deploy.** Open `https://<your-worker>.workers.dev/` in a browser.
   You should get a JSON status page listing the exact WebSocket URL to use and
   whether the extension is currently connected. If this page does not load,
   nothing else will work — fix that first.
2. **Load the extension.** In PenguinMod or TurboWarp, add a custom extension
   from the URL of (or the file) `mcp-bridge-extension.js`.
3. **Connect.** Use **connect to MCP server** with the URL the status page
   printed, e.g. `wss://<your-worker>.workers.dev/ws`. (A bare hostname works
   too — the block normalises it.)
4. **Define tools.** Use **define a new tool...**, then write a script under the
   **when a tool is called** hat ending in **respond with [...]**.
5. **Point your MCP client** at `https://<your-worker>.workers.dev/mcp` and ask
   for `tools/list`.

## If your WebSocket tester says 1006 — read this

**Close code 1006 never tells you anything.** It is the code a WebSocket client
reports whenever the connection died without a protocol-level close frame, which
includes *every possible way the HTTP upgrade can fail*. The server almost
always sent a perfectly clear HTTP response explaining the problem — the
WebSocket API just throws it away before handing you the 1006.

So don't debug 1006. Go get the response it discarded:

```bash
node scripts/ws-check.mjs wss://<your-worker>.workers.dev/ws
```

This does the handshake with a raw HTTP client instead of a WebSocket client, so
the real status line, headers and body stay visible. It prints the rejection
reason, or connects and exercises the keepalive for a few seconds. Add
`--token=<MCP_AUTH_TOKEN>` if you set that var.

The next-fastest check needs no tools at all: **take your `wss://` URL, change
it to `https://`, and open it in a browser tab.** That hits the same Worker on
the same path and renders the status page, including whether it thinks your
request carried a token.

### The causes, most common first

1. **`MCP_AUTH_TOKEN` is set and the URL has no `?token=`.** The Worker answers
   `401`, and every WebSocket client turns that into 1006. Either append
   `?token=<token>` to the URL or unset the var while testing.
2. **The Worker isn't actually deployed**, or is deployed under a different
   name/route than the hostname you're testing. The status page won't load
   either. `npx wrangler deploy` and use the URL it prints.
3. **The Durable Object binding or migration didn't apply.** `MCP_BRIDGE` and
   the `[[migrations]]` block in `wrangler.toml` are both required; without them
   the upgrade path 500s. The status page reports this as `durableObjectError`.
4. **Your tester can't do `wss://` through a proxy or a corporate network.**
   `ws-check` will show a connection or TLS failure rather than an HTTP status.
5. **The connection opens and then dies about a minute later.** That is
   Cloudflare's 100-second idle timeout, meaning keepalives aren't arriving.
   Check `npx wrangler tail` while connected.

The previous revision of this Worker had several of its own routes to a 1006,
all fixed here: it upgraded only on `/ws` (any other path was an HTTP error), it
sent a frame on the server socket *before* returning the 101 (a throw there
aborts the handshake), and its keepalive was a zero-length text frame that some
clients treat as malformed. `src/index.js` documents each one at the top.

## Endpoints

The Worker is deliberately permissive about paths, because being picky was
itself a source of 1006s.

| Request | Behaviour |
| --- | --- |
| Any WebSocket upgrade, **any path** | Upgraded and handed to the Durable Object. `/ws` is just the conventional URL. |
| `GET` / `HEAD` any path | JSON status page: server version, whether the extension is connected, the tool list, and what it saw in your request. |
| `POST` any path | MCP JSON-RPC (Streamable HTTP, JSON-response mode). Single messages and batches. |
| `OPTIONS` | CORS preflight. |

Auth, when `MCP_AUTH_TOKEN` is set, is accepted as `Authorization: Bearer
<token>`, `?token=<token>`, or a `bearer.<token>` WebSocket subprotocol.

Supported MCP methods: `initialize`, `notifications/initialized`, `ping`,
`tools/list`, `tools/call`, plus empty `resources/list`,
`resources/templates/list` and `prompts/list` for clients that probe them.

## Wire protocol

JSON text frames in both directions. There are no empty frames.

**Worker → extension**

| Frame | Meaning |
| --- | --- |
| `{t:"hello", server, version, tools}` | Sent once, after the handshake completes. |
| `{t:"ping", ts}` | Keepalive, every ~55s. The extension replies `pong`. |
| `{t:"manifest_req"}` | (Re)send your tool list. |
| `{t:"call", id, tool, arguments, raw}` | Run this `tools/call`. |

**Extension → Worker**

| Frame | Meaning |
| --- | --- |
| `{t:"pong", ts}` | Keepalive reply. |
| `{t:"manifest", tools:[...]}` | The current tool list. |
| `{t:"refresh_manifest"}` | Please re-issue `manifest_req`. |
| `{t:"result", id, ok, value\|error}` | Normal tool response. |
| `{t:"raw_result", id, payload}` | `payload` is used verbatim as the MCP `CallToolResult`. |

Each tool in a manifest is `{name, description, arguments:[{name, type,
description, required}]}`, where `type` is one of `string`, `number`,
`integer`, `boolean`, `array`, `object`, `any`. The Worker converts these to
JSON Schema for `tools/list`.

## Blocks

**Connection** — `connect to MCP server [URL]`, `disconnect from MCP server`,
`connected to server?`, `connection status`, `last connection error`,
`set auto-reconnect to [on/off]`.

> `last connection error` is the block to check when something isn't working:
> it carries the close code and a plain-English explanation.

**Tools** — `define a new tool...`, `edit tool [name]...`, `remove tool [name]`,
`push current tool list to server now`, `defined tool names (JSON)`.

**Handling a call** — `when a tool is called` (hat), `called tool name`,
`current call ID`, `argument [name]`, `all arguments (JSON)`,
`raw MCP request (JSON)`.

**Responding** — `respond with [value]`, `respond with error [value]`, and the
explicit-ID forms `respond to call [id] with [value]`,
`respond to call [id] with error [value]`, and
`respond to call [id] with raw MCP result JSON [json]`.

Use the plain `respond with` blocks inside the hat, where the call ID is
implicit. The `...to call [ID]` forms exist for when you answer later, from a
different script — stash `current call ID` in a variable first.

## Notes

- **Tool definitions save with the project**, in a hidden Stage variable named
  `☣ MCP Bridge Tool Definitions (do not edit)`. Don't edit it by hand.
- **One connection at a time.** The bridge is single-user; the most recent
  socket wins, so reconnecting takes over cleanly from a dropped one.
- **Auto-reconnect is on by default**, with backoff up to 30s. Turn it off with
  the `set auto-reconnect to [off]` block if you want manual control.
- **A `tools/call` waits up to 55s** for the project to respond. If no
  `when a tool is called` script is running, the extension says so immediately
  instead of making the client wait out the timeout.
- The Durable Object uses the Hibernatable WebSockets API, so it sleeps — and
  stops billing duration — between messages.
