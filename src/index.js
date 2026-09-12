/**
 * MCP <-> PenguinMod Bridge — Cloudflare Worker + Durable Object
 * ----------------------------------------------------------------
 * One file, on purpose (external constraint).
 *
 * SHAPE
 * -----
 * The `export default { fetch }` at the bottom IS the MCP server: it parses
 * JSON-RPC and answers initialize / tools/list / tools/call directly, the way
 * any Worker-only MCP server would. It is not a proxy into the Durable Object.
 *
 * The Durable Object (`McpBridge`) exists only to hold the three things a
 * stateless Worker cannot: the live WebSocket to the PenguinMod extension, the
 * map of in-flight tool calls, and the cached tool manifest. The Worker reaches
 * it two ways:
 *   - WebSocket upgrades are forwarded to the DO's own fetch(), because the
 *     handshake must complete on whichever object will hold the socket. This is
 *     the one unavoidable request forward.
 *   - Everything MCP-shaped uses plain RPC method calls on the stub
 *     (stub.getManifest(), stub.callTool(...)).
 *
 * WIRE PROTOCOL (JSON text frames, both directions — no empty frames, ever)
 * ------------------------------------------------------------------------
 * Worker -> Extension
 *   {t:"hello", server, version, tools}       sent once, immediately after open
 *   {t:"ping", ts}                            keepalive; extension replies "pong"
 *   {t:"manifest_req"}                        (re)send your tool list
 *   {t:"call", id, tool, arguments, raw}      run this tools/call
 *
 * Extension -> Worker
 *   {t:"pong", ts}                            keepalive reply (optional)
 *   {t:"manifest", tools:[...]}               here is my tool list
 *   {t:"refresh_manifest"}                    please re-issue manifest_req
 *   {t:"result", id, ok, value|error}         normal tool response
 *   {t:"raw_result", id, payload}             payload used verbatim as CallToolResult
 *
 * WHY THE 1006s HAPPENED (and what changed)
 * -----------------------------------------
 * A WebSocket client reports close code 1006 whenever the connection dies
 * without a protocol-level close frame. That covers every way the HTTP upgrade
 * can fail, and the client never gets to see the status code or body. The
 * previous revision had five separate routes to a 1006:
 *
 *   1. Only `/ws` upgraded, and the check was duplicated in the DO. Pointing a
 *      tester at `/`, `/mcp`, or `/ws/` produced an HTTP error, i.e. 1006.
 *      -> Now: ANY path upgrades when the request is a WebSocket upgrade.
 *   2. With MCP_AUTH_TOKEN set, a URL missing `?token=` got a bare 401, i.e.
 *      1006 with no explanation.
 *      -> Now: the token may also arrive via Authorization or the
 *         `Sec-WebSocket-Protocol` header, and the 401 body says exactly what
 *         is wrong for anyone who looks at it over plain https://.
 *   3. The DO sent a `manifest_req` on the server socket BEFORE returning the
 *      101 response. A throw there aborts the whole handshake -> 1006.
 *      -> Now: nothing is sent until after the 101 is returned, and the
 *         manifest is fetched lazily on the first tools/list instead.
 *   4. The keepalive was a zero-length text frame. Plenty of WebSocket testers
 *      and intermediaries treat an empty frame as malformed and hang up -> a
 *      1006 roughly 55 seconds into an otherwise healthy connection.
 *      -> Now: keepalives are real JSON `{t:"ping"}` frames.
 *   5. Any uncaught throw inside the DO's fetch() tears down the handshake with
 *      no close code -> 1006.
 *      -> Now: the whole upgrade path is wrapped, and failures return a real
 *         HTTP response instead of taking the object down.
 *
 * Two Cloudflare-specific numbers below:
 *   - 100_000ms is the non-configurable WebSocket idle timeout on Free/Pro
 *     (a socket with zero bytes either direction for 100s is closed). We ping
 *     at 100s/1.8 so there is always slack, even with scheduling jitter.
 *   - We use the Hibernatable WebSockets API (ctx.acceptWebSocket plus the
 *     webSocketMessage/webSocketClose handlers, with Alarms for the keepalive)
 *     so the object sleeps — and stops billing duration — between messages.
 */

import { DurableObject } from "cloudflare:workers";

const SERVER_NAME = "mcp-penguinmod-bridge";
const SERVER_VERSION = "1.0.0";

const IDLE_TIMEOUT_MS = 100_000; // Cloudflare's fixed WebSocket idle timeout (Free/Pro)
const KEEPALIVE_MS = Math.floor(IDLE_TIMEOUT_MS / 1.8); // ~55.5s
const DEFAULT_CALL_TIMEOUT_MS = 55_000; // how long a tools/call waits on the extension
const DEFAULT_MANIFEST_TIMEOUT_MS = 5_000; // how long a manifest_req round trip waits

// Protocol versions we can speak, newest first. `initialize` echoes the
// client's version when we know it, and otherwise pins the newest we support
// rather than parroting back something we don't implement.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROTOCOL_VERSION_FALLBACK = SUPPORTED_PROTOCOL_VERSIONS[0];

const DO_SINGLETON_NAME = "singleton";

// =====================================================================
// Request sniffing
// =====================================================================

// HTTP header field values used as protocol tokens are case-insensitive, and
// `Connection` is a comma-separated list that may carry other tokens alongside
// "Upgrade". Some testers send `Upgrade: WebSocket`; browsers send lowercase.
// Cloudflare also normalises HTTP/2 CONNECT-style upgrades into this shape, so
// checking `Upgrade` alone is the reliable signal — `Connection` is accepted in
// whatever form it arrives.
function isWebSocketUpgrade(request) {
  const upgrade = request.headers.get("Upgrade");
  return typeof upgrade === "string" && upgrade.trim().toLowerCase() === "websocket";
}

// Browser WebSocket clients cannot set request headers, so the shared secret
// has three accepted carriers. The subprotocol form is what well-behaved
// non-browser clients use; `?token=` is what a browser or a tester can do.
function extractToken(request, url) {
  const auth = request.headers.get("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();

  const queryToken = url.searchParams.get("token") || url.searchParams.get("access_token");
  if (queryToken) return queryToken.trim();

  const protocols = request.headers.get("Sec-WebSocket-Protocol");
  if (protocols) {
    for (const entry of protocols.split(",")) {
      const value = entry.trim();
      if (value.startsWith("bearer.")) return value.slice("bearer.".length);
      if (value.startsWith("mcp-token.")) return value.slice("mcp-token.".length);
    }
  }
  return null;
}

// Returns null when the request is authorised, or a human-readable reason.
function authFailureReason(request, url, env) {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return null; // auth disabled
  const provided = extractToken(request, url);
  if (!provided) {
    return "This server has MCP_AUTH_TOKEN set, but the request carried no token. " +
      "Append ?token=<MCP_AUTH_TOKEN> to the URL, or send an Authorization: Bearer header.";
  }
  if (provided !== expected) return "The token supplied does not match MCP_AUTH_TOKEN.";
  return null;
}

// If the client offered subprotocols, we must echo back exactly one of the
// ones it offered — echoing an unrequested protocol makes a browser client
// abort the connection, and echoing nothing is always legal.
function negotiateSubprotocol(request) {
  const offered = request.headers.get("Sec-WebSocket-Protocol");
  if (!offered) return null;
  const list = offered.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!list.length) return null;
  const preferred = list.find((entry) => entry === "mcp" || entry === "mcp-bridge");
  return preferred || list[0];
}

// =====================================================================
// Durable Object: the live WebSocket, the pending calls, the manifest
// cache. Nothing MCP-shaped lives here — just the stateful plumbing the
// plain Worker below cannot hold on its own.
// =====================================================================

export class McpBridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {Map<string, {resolve: (v:any)=>void, timer: any}>} */
    this.pending = new Map();
    this.pendingManifestReq = null;
    this.manifest = null; // lazily loaded from storage; array of tool defs
  }

  // ---- the one exception: WebSocket upgrades must land here directly ----

  async fetch(request) {
    if (!isWebSocketUpgrade(request)) {
      return new Response("This Durable Object endpoint only accepts WebSocket upgrades.", {
        status: 426,
        headers: { "Content-Type": "text/plain; charset=utf-8", Upgrade: "websocket" },
      });
    }

    try {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // acceptWebSocket hands the socket to the hibernation manager. Nothing is
      // sent on it here: a throw before the 101 is returned aborts the upgrade
      // and the client sees only a 1006. The greeting goes out on the alarm
      // below instead, and the manifest is fetched lazily by getManifest().
      this.ctx.acceptWebSocket(server);
      await this.armKeepalive(0); // fires promptly: sends hello, then pings

      const headers = {};
      const subprotocol = negotiateSubprotocol(request);
      if (subprotocol) headers["Sec-WebSocket-Protocol"] = subprotocol;

      return new Response(null, { status: 101, webSocket: client, headers });
    } catch (e) {
      // Returning a real response keeps the object alive and gives anyone
      // inspecting the handshake over https:// something better than a 1006.
      return new Response(`WebSocket upgrade failed inside the Durable Object: ${String((e && e.message) || e)}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  // ---- RPC methods the plain Worker calls directly on the stub ----

  async getStatus() {
    await this.ensureManifestLoaded();
    return {
      connected: this.getSocket() !== null,
      socketCount: this.ctx.getWebSockets().length,
      toolCount: (this.manifest || []).length,
      toolNames: (this.manifest || []).map((tool) => tool && tool.name).filter(Boolean),
      pendingCalls: this.pending.size,
    };
  }

  async getManifest() {
    await this.ensureManifestLoaded();
    // An empty cache with a live socket usually means the extension connected
    // but has not pushed its tool list yet. Ask once rather than reporting the
    // server has no tools.
    const ws = this.getSocket();
    if (ws && (!this.manifest || this.manifest.length === 0)) {
      await this.requestManifest(ws);
    }
    return this.manifest || [];
  }

  async callTool(name, args, rawRequest) {
    if (typeof name !== "string" || !name) {
      return errorResult("No tool name was supplied in the tools/call request.");
    }

    await this.ensureManifestLoaded();

    const ws = this.getSocket();
    if (!ws) {
      return errorResult(
        "The PenguinMod extension isn't connected to the bridge right now. " +
          "Run the \"connect to MCP server\" block in the project, then try again."
      );
    }

    const known = (this.manifest || []).some((tool) => tool && tool.name === name);
    if (!known && (this.manifest || []).length > 0) {
      const available = (this.manifest || []).map((tool) => tool.name).join(", ");
      return errorResult(`Unknown tool "${name}". Tools currently defined: ${available || "(none)"}.`);
    }

    const id = crypto.randomUUID();
    const payload = { t: "call", id, tool: name, arguments: args || {}, raw: rawRequest };
    const timeoutMs = positiveNumber(this.env.CALL_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS);

    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ __timedOut: true });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });

    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      const entry = this.pending.get(id);
      if (entry) clearTimeout(entry.timer);
      this.pending.delete(id);
      return errorResult(`Failed to reach the extension: ${String((e && e.message) || e)}`);
    }

    const res = await resultPromise;

    if (res.__timedOut) {
      return errorResult(
        `The extension didn't respond within ${Math.round(timeoutMs / 1000)}s. ` +
          "Check that the project has a \"when a tool is called\" script that ends in a respond block."
      );
    }

    // Total escape hatch: whatever the extension sent becomes the
    // CallToolResult verbatim, with no shaping applied.
    if (res.t === "raw_result") {
      return res.payload && typeof res.payload === "object"
        ? res.payload
        : errorResult("The extension sent a raw_result whose payload was not an object.");
    }

    if (res.ok) {
      return { content: [{ type: "text", text: asText(res.value) }] };
    }
    return errorResult(asText(res.error));
  }

  // ---- internals ----

  getSocket() {
    // Single-user bridge: the most recent connection wins, so reconnecting
    // after a dropped socket takes over instead of talking to a stale one.
    const sockets = this.ctx.getWebSockets();
    return sockets.length ? sockets[sockets.length - 1] : null;
  }

  async armKeepalive(delayMs = KEEPALIVE_MS) {
    const existing = await this.ctx.storage.getAlarm();
    const target = Date.now() + delayMs;
    if (existing === null || existing > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return; // nothing to keep alive; let the object sleep

    await this.ensureManifestLoaded();

    for (const ws of sockets) {
      try {
        // A socket that has not been greeted yet gets the hello frame; every
        // other pass is a plain ping. Both are real JSON — never empty frames,
        // which some clients and intermediaries treat as malformed.
        const attachment = safeAttachment(ws);
        if (!attachment.greeted) {
          ws.send(JSON.stringify({
            t: "hello",
            server: SERVER_NAME,
            version: SERVER_VERSION,
            tools: (this.manifest || []).length,
          }));
          ws.serializeAttachment({ ...attachment, greeted: true });
          // Ask for the tool list right away now that the handshake is complete.
          ws.send(JSON.stringify({ t: "manifest_req" }));
        } else {
          ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
        }
      } catch (e) {
        /* socket already gone; the close handler will tidy up */
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  webSocketMessage(ws, msg) {
    if (msg === "" || msg === undefined || msg === null) return; // noise

    let data;
    try {
      data = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    } catch (e) {
      return; // not JSON; ignore rather than crash the object
    }
    if (!data || typeof data !== "object") return;

    switch (data.t) {
      case "pong":
        return; // keepalive reply; the frame itself is the point

      case "manifest": {
        this.manifest = Array.isArray(data.tools) ? data.tools.filter(isUsableTool) : [];
        this.ctx.storage.put("manifest", this.manifest).catch(() => {});
        if (this.pendingManifestReq) {
          clearTimeout(this.pendingManifestReq.timer);
          this.pendingManifestReq.resolve(this.manifest);
          this.pendingManifestReq = null;
        }
        return;
      }

      case "refresh_manifest":
        // Belt-and-suspenders: the extension can also just push a fresh
        // "manifest" frame without asking.
        this.requestManifest(ws).catch(() => {});
        return;

      case "result":
      case "raw_result": {
        const pending = this.pending.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(data.id);
          pending.resolve(data);
        }
        return;
      }

      default:
        return;
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    void code;
    void reason;
    void wasClean;
    try {
      ws.close(1000, "closing");
    } catch (e) {
      /* already closed */
    }
    // In-flight calls resolve via their own timeouts; failing them now would
    // race a client that is reconnecting mid-call.
  }

  webSocketError(_ws, _error) {}

  requestManifest(ws) {
    return new Promise((resolve) => {
      if (this.pendingManifestReq) {
        resolve(this.manifest || []);
        return;
      }
      const timeoutMs = positiveNumber(this.env.MANIFEST_TIMEOUT_MS, DEFAULT_MANIFEST_TIMEOUT_MS);
      const timer = setTimeout(() => {
        this.pendingManifestReq = null;
        resolve(this.manifest || []);
      }, timeoutMs);
      this.pendingManifestReq = { resolve, timer };
      try {
        ws.send(JSON.stringify({ t: "manifest_req" }));
      } catch (e) {
        clearTimeout(timer);
        this.pendingManifestReq = null;
        resolve(this.manifest || []);
      }
    });
  }

  async ensureManifestLoaded() {
    if (this.manifest === null) {
      const stored = await this.ctx.storage.get("manifest");
      this.manifest = Array.isArray(stored) ? stored.filter(isUsableTool) : [];
    }
  }
}

function safeAttachment(ws) {
  try {
    const attachment = ws.deserializeAttachment();
    return attachment && typeof attachment === "object" ? attachment : {};
  } catch (e) {
    return {};
  }
}

function isUsableTool(tool) {
  return Boolean(tool && typeof tool === "object" && typeof tool.name === "string" && tool.name);
}

function positiveNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function asText(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// =====================================================================
// Plain helpers for the MCP JSON-RPC shapes and CORS. Nothing here
// touches the Durable Object — it is just JSON-RPC bookkeeping.
// =====================================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders(), ...extraHeaders },
  });
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

// Map our simplified argument "type" strings onto JSON Schema.
function argToSchema(arg) {
  const t = (arg && arg.type) || "string";
  const schema = {};
  switch (t) {
    case "number":
      schema.type = "number";
      break;
    case "integer":
      schema.type = "integer";
      break;
    case "boolean":
      schema.type = "boolean";
      break;
    case "array":
      schema.type = "array";
      schema.items = {};
      break;
    case "object":
      schema.type = "object";
      break;
    case "any":
      break; // no "type" constraint at all — accept anything
    default:
      schema.type = "string";
  }
  if (arg && arg.description) schema.description = arg.description;
  return schema;
}

function toolToMcpSchema(tool) {
  const args = Array.isArray(tool.arguments) ? tool.arguments : [];
  const properties = {};
  const required = [];
  for (const a of args) {
    if (!a || !a.name) continue;
    properties[a.name] = argToSchema(a);
    if (a.required) required.push(a.name);
  }
  const inputSchema = { type: "object", properties };
  if (required.length) inputSchema.required = required;
  return { name: tool.name, description: tool.description || "", inputSchema };
}

function negotiateProtocolVersion(params) {
  const asked = params && params.protocolVersion;
  if (typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) return asked;
  return PROTOCOL_VERSION_FALLBACK;
}

// Handles exactly one JSON-RPC message. `stub` is the DO stub, used only for
// the two things that genuinely need state (manifest, tool calls).
async function dispatch(msg, stub) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return jsonRpcError(null, -32600, "Invalid Request: expected a JSON-RPC object.");
  }
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return jsonRpcError(msg.id, -32600, "Invalid Request: missing jsonrpc:\"2.0\" or method.");
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case "initialize": {
        const result = {
          protocolVersion: negotiateProtocolVersion(params),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        return isNotification ? undefined : jsonRpcResult(id, result);
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;

      case "ping":
        return isNotification ? undefined : jsonRpcResult(id, {});

      case "tools/list": {
        if (isNotification) return undefined;
        const manifest = await stub.getManifest();
        return jsonRpcResult(id, { tools: (manifest || []).map(toolToMcpSchema) });
      }

      // A handful of MCP clients probe these even on tools-only servers.
      case "resources/list":
        return isNotification ? undefined : jsonRpcResult(id, { resources: [] });
      case "resources/templates/list":
        return isNotification ? undefined : jsonRpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return isNotification ? undefined : jsonRpcResult(id, { prompts: [] });

      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const result = await stub.callTool(name, args, msg);
        return isNotification ? undefined : jsonRpcResult(id, result);
      }

      default:
        return isNotification ? undefined : jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return isNotification
      ? undefined
      : jsonRpcError(id, -32603, "Internal error", String((e && e.message) || e));
  }
}

function bridgeStub(env) {
  const id = env.MCP_BRIDGE.idFromName(DO_SINGLETON_NAME);
  return env.MCP_BRIDGE.get(id);
}

// A GET on any non-upgrade route returns this. It is the fastest way to tell a
// deployment problem apart from a client problem: if this renders, the Worker
// and the Durable Object are both live and the WebSocket URL it prints is
// exactly the one to paste into the extension or a tester.
async function statusPage(request, url, env) {
  const wsUrl = `${url.protocol === "http:" ? "ws" : "wss"}://${url.host}/ws`;
  let bridge = { connected: false, toolCount: 0, toolNames: [], pendingCalls: 0, socketCount: 0 };
  let bridgeError = null;
  try {
    bridge = await bridgeStub(env).getStatus();
  } catch (e) {
    bridgeError = String((e && e.message) || e);
  }

  return jsonResponse({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    ok: bridgeError === null,
    durableObjectError: bridgeError,
    authRequired: Boolean(env.MCP_AUTH_TOKEN),
    endpoints: {
      websocket: env.MCP_AUTH_TOKEN ? `${wsUrl}?token=<MCP_AUTH_TOKEN>` : wsUrl,
      mcp: `${url.protocol}//${url.host}/mcp`,
      note: "Any path accepts a WebSocket upgrade; /ws is just the conventional one. " +
        "Every non-upgrade GET returns this page, and MCP JSON-RPC is POST to any path.",
    },
    extension: bridge,
    yourRequest: {
      method: request.method,
      path: url.pathname,
      upgradeHeader: request.headers.get("Upgrade"),
      connectionHeader: request.headers.get("Connection"),
      tokenSupplied: extractToken(request, url) !== null,
    },
  });
}

// =====================================================================
// The plain Worker. This IS the MCP server: it parses JSON-RPC and answers
// directly, reaching into the Durable Object only for the WS upgrade and
// the stateful RPC calls (getStatus / getManifest / callTool).
// =====================================================================

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return textResponse("Malformed request URL.", 400);
    }

    // ---- WebSocket upgrade for the extension ----
    // Deliberately path-agnostic. The single most common cause of a client
    // reporting 1006 against this Worker was pointing it at a path that did
    // not upgrade; there is no reason to be picky about which path it is.
    if (isWebSocketUpgrade(request)) {
      const failure = authFailureReason(request, url, env);
      if (failure) {
        // A WebSocket client will surface this as 1006 no matter what we send
        // — the connection dies before a close frame is possible. The body is
        // for whoever repeats the request over plain https:// to find out why.
        return textResponse(`401 Unauthorized. ${failure}`, 401);
      }
      try {
        return await bridgeStub(env).fetch(request);
      } catch (e) {
        return textResponse(
          `Could not reach the Durable Object for the WebSocket upgrade: ${String((e && e.message) || e)}. ` +
            "This usually means the MCP_BRIDGE binding or the migration in wrangler.toml did not deploy.",
          500
        );
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---- Anything that isn't an upgrade or a POST gets the status page ----
    if (request.method === "GET" || request.method === "HEAD") {
      const response = await statusPage(request, url, env);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }

    if (request.method !== "POST") {
      return textResponse(
        "This MCP server implements Streamable HTTP in JSON-response mode: POST a JSON-RPC body, " +
          "or GET this URL for a status page.",
        405,
        { Allow: "GET, HEAD, POST, OPTIONS" }
      );
    }

    // ---- MCP JSON-RPC ----
    const failure = authFailureReason(request, url, env);
    if (failure) {
      return jsonResponse(jsonRpcError(null, -32001, `Unauthorized. ${failure}`), 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse(jsonRpcError(null, -32700, "Parse error: the request body was not valid JSON."), 400);
    }

    const stub = bridgeStub(env);
    const isBatch = Array.isArray(body);
    const messages = isBatch ? body : [body];

    if (isBatch && messages.length === 0) {
      return jsonResponse(jsonRpcError(null, -32600, "Invalid Request: empty batch."), 400);
    }

    const responses = [];
    for (const msg of messages) {
      const out = await dispatch(msg, stub);
      if (out !== undefined) responses.push(out);
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: corsHeaders() }); // pure notification(s)
    }

    const sessionId = request.headers.get("Mcp-Session-Id") || crypto.randomUUID();
    return jsonResponse(isBatch ? responses : responses[0], 200, { "Mcp-Session-Id": sessionId });
  },
};
