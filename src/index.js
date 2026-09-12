/**

* MCP <-> PenguinMod Bridge — Cloudflare Worker + Durable Object

* ----------------------------------------------------------------

* One file, on purpose (external constraint).

*

* IMPORTANT SHAPE: the plain Worker's fetch() handler below (the

* `export default { fetch(...) }` at the bottom of this file) IS the MCP

* server — it parses JSON-RPC directly and answers initialize/tools/list/

* tools/call right there, the same way any plain Worker-only MCP server

* would. It is not a thin proxy into the Durable Object.

*

* The Durable Object (`McpBridge`) exists ONLY because something has to

* hold a few things across requests that a stateless Worker fundamentally

* can't: the live WebSocket to the PenguinMod extension, the map of

* in-flight tool calls waiting on a response, and a cached copy of the

* current tool manifest. The Worker reaches it two ways:

*

* - For the WebSocket upgrade at /ws: forwards the raw request to the

* DO's own fetch(), because completing a WS handshake has to happen on

* whichever object will actually hold the socket. This is the one

* unavoidable exception.

* - For everything MCP-related: plain RPC method calls on the DO stub

* (stub.getManifest(), stub.callTool(...)) — normal JS method calls,

* not HTTP requests being forwarded through.

*

* A Durable Object *binding* (the [[durable_objects.bindings]] entry in

* wrangler.toml) is still required to reach the object at all — that's a

* fixed Cloudflare mechanism, not something specific to MCP or removable.

*

* Wire protocol between Worker <-> Extension (JSON text frames over the

* one WebSocket, except the keepalive which is a literal empty frame):

*

* Worker -> Extension

* "" (empty frame, pure keepalive, ignored by extension)

* {t:"manifest_req"} (asks the extension to (re)send its tool list)

* {t:"call", id, tool, arguments, raw} (a tools/call that needs to be run)

*

* Extension -> Worker

* {t:"manifest", tools:[{name, description, arguments:[{name,type,description,required}]}]}

* {t:"refresh_manifest"} (rare; extension asking worker to re-issue manifest_req)

* {t:"result", id, ok, value|error} (normal tool response)

* {t:"raw_result", id, payload} (payload is used verbatim as the MCP CallToolResult —

* total escape hatch for full control over the response shape)

*

* Notes on the two big Cloudflare-specific numbers below:

* - 100_000ms is Cloudflare's non-configurable WebSocket idle timeout on

* Free/Pro plans (closes a socket after 100s with zero bytes either

* direction). We ping at 100s/1.8 so there's always slack before the edge

* would consider the pipe idle, even accounting for jitter/scheduling delay.

* - We use the Hibernatable WebSockets API (ctx.acceptWebSocket +

* webSocketMessage/webSocketClose handlers, plus the Alarms API for the

* keepalive) so the Object can go to sleep — and stop being billed for

* duration — between messages instead of holding a live event loop open.

*/


import { DurableObject } from "cloudflare:workers";


const IDLE_TIMEOUT_MS = 100_000; // Cloudflare's fixed WebSocket idle timeout (Free/Pro)

const KEEPALIVE_MS = Math.floor(IDLE_TIMEOUT_MS / 1.8); // ~55.5s

const DEFAULT_CALL_TIMEOUT_MS = 55_000; // how long a tools/call will wait on the extension

const DEFAULT_MANIFEST_TIMEOUT_MS = 5_000; // how long to wait for a manifest_req round trip

const PROTOCOL_VERSION_FALLBACK = "2025-06-18";


// HTTP header field values used as protocol tokens are case-insensitive. Some
// WebSocket testers send `Upgrade: WebSocket`, while browsers generally send
// lowercase `websocket`; accept both before attempting the handshake.
function isWebSocketUpgrade(request) {

const upgrade = request.headers.get("Upgrade");

return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";

}


// =====================================================================

// Durable Object: holds the live WebSocket + pending calls + manifest

// cache. Nothing MCP-shaped lives in here — just the stateful plumbing

// the plain Worker below needs because it can't hold a socket itself.

// =====================================================================


export class McpBridge extends DurableObject {

constructor(ctx, env) {

super(ctx, env);

/** @type {Map<string, {resolve: (v:any)=>void, timer: any}>} */

this.pending = new Map();

this.pendingManifestReq = null;

this.manifest = null; // lazily loaded from durable storage; array of tool defs

}


// ---- the one exception: WebSocket upgrades must land here directly ----


async fetch(request) {

const url = new URL(request.url);

if (!isWebSocketUpgrade(request) || url.pathname !== "/ws") {

return new Response("This endpoint only accepts WebSocket upgrades.", { status: 400 });

}

const pair = new WebSocketPair();

const [client, server] = Object.values(pair);

this.ctx.acceptWebSocket(server);

this.scheduleAlarm();

// Ask immediately for the current tool manifest so a tools/list right

// after connecting has something fresh without a separate round trip.

this.requestManifest(server).catch(() => {});

return new Response(null, { status: 101, webSocket: client });

}


// ---- RPC methods the plain Worker calls directly on the stub ----


async getManifest() {

await this.ensureManifestLoaded();

return this.manifest;

}


async callTool(name, args, rawRequest) {

const ws = this.getSocket();

if (!ws) {

return {

content: [{ type: "text", text: "The PenguinMod extension isn't connected to the server right now." }],

isError: true,

};

}


const id = crypto.randomUUID();

const payload = { t: "call", id, tool: name, arguments: args, raw: rawRequest };

const timeoutMs = Number(this.env.CALL_TIMEOUT_MS) || DEFAULT_CALL_TIMEOUT_MS;


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

this.pending.delete(id);

return {

content: [{ type: "text", text: "Failed to reach the extension (the socket errored while sending)." }],

isError: true,

};

}


const res = await resultPromise;


if (res.__timedOut) {

return {

content: [{ type: "text", text: `The extension didn't respond within ${Math.round(timeoutMs / 1000)}s.` }],

isError: true,

};

}


if (res.t === "raw_result") {

// Total escape hatch: whatever the extension sent becomes the

// CallToolResult verbatim, no shaping applied.

return res.payload;

}


if (res.ok) {

const text = typeof res.value === "string" ? res.value : JSON.stringify(res.value);

return { content: [{ type: "text", text }] };

}

const errText = typeof res.error === "string" ? res.error : JSON.stringify(res.error);

return { content: [{ type: "text", text: errText }], isError: true };

}


// ---- internals ----


getSocket() {

const sockets = this.ctx.getWebSockets();

return sockets.length ? sockets[0] : null; // single-user bridge: first/only connection wins

}


async scheduleAlarm() {

const existing = await this.ctx.storage.getAlarm();

if (existing === null) {

await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);

}

}


async alarm() {

const sockets = this.ctx.getWebSockets();

for (const ws of sockets) {

try {

ws.send(""); // literally empty frame — pure keepalive, nothing to parse

} catch (e) {

/* socket already gone; ignore */

}

}

if (sockets.length) {

await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);

}

}


webSocketMessage(ws, msg) {

if (msg === "" || msg === undefined || msg === null) return; // keepalive / noise

let data;

try {

data = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg));

} catch (e) {

return; // not JSON, ignore rather than crash the Object

}

if (!data || typeof data !== "object") return;


if (data.t === "manifest") {

this.manifest = Array.isArray(data.tools) ? data.tools : [];

this.ctx.storage.put("manifest", this.manifest).catch(() => {});

if (this.pendingManifestReq) {

clearTimeout(this.pendingManifestReq.timer);

this.pendingManifestReq.resolve(this.manifest);

this.pendingManifestReq = null;

}

return;

}


if (data.t === "refresh_manifest") {

// Extension asking us to re-issue the request (belt-and-suspenders;

// the extension can also just push a fresh "manifest" message directly).

this.requestManifest(ws).catch(() => {});

return;

}


if (data.t === "result" || data.t === "raw_result") {

const pending = this.pending.get(data.id);

if (pending) {

clearTimeout(pending.timer);

this.pending.delete(data.id);

pending.resolve(data);

}

return;

}

}


webSocketClose(_ws, _code, _reason, _wasClean) {

// Pending calls, if any, will simply time out on their own.

}


webSocketError(_ws, _error) {}


requestManifest(ws) {

return new Promise((resolve) => {

if (this.pendingManifestReq) {

resolve(this.manifest || []);

return;

}

const timeoutMs = Number(this.env.MANIFEST_TIMEOUT_MS) || DEFAULT_MANIFEST_TIMEOUT_MS;

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

this.manifest = Array.isArray(stored) ? stored : [];

}

}

}


// =====================================================================

// Plain helpers for the MCP JSON-RPC shapes and CORS. Nothing here

// touches the Durable Object — it's just JSON-RPC bookkeeping.

// =====================================================================


function corsHeaders() {

return {

"Access-Control-Allow-Origin": "*",

"Access-Control-Allow-Methods": "POST, GET, OPTIONS",

"Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",

"Access-Control-Expose-Headers": "Mcp-Session-Id",

};

}


function jsonResponse(body, status = 200, extraHeaders = {}) {

return new Response(JSON.stringify(body), {

status,

headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },

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


// Handles exactly one JSON-RPC message. `stub` is the DO stub, used only

// for the two things that genuinely need state (manifest, tool calls).

async function dispatch(msg, stub) {

if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {

return jsonRpcError(msg && msg.id, -32600, "Invalid Request");

}


const { id, method, params } = msg;

const isNotification = id === undefined;


try {

switch (method) {

case "initialize": {

const result = {

protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION_FALLBACK,

capabilities: { tools: { listChanged: true } },

serverInfo: { name: "mcp-penguinmod-bridge", version: "0.2.0" },

};

return isNotification ? undefined : jsonRpcResult(id, result);

}


case "notifications/initialized":

return undefined;


case "ping":

return isNotification ? undefined : jsonRpcResult(id, {});


case "tools/list": {

if (isNotification) return undefined;

const manifest = await stub.getManifest();

return jsonRpcResult(id, { tools: (manifest || []).map(toolToMcpSchema) });

}


// A handful of MCP clients probe these even for tools-only servers.

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

return isNotification ? undefined : jsonRpcError(id, -32603, "Internal error", String((e && e.message) || e));

}

}


function checkAuth(request, url, env) {

const token = env.MCP_AUTH_TOKEN;

if (!token) return true; // auth disabled (fine for local testing)

const header = request.headers.get("Authorization") || "";

if (header === `Bearer ${token}`) return true;

if (url.searchParams.get("token") === token) return true; // WS clients can't set headers easily

return false;

}


// =====================================================================

// The plain Worker. This IS the MCP server: it parses JSON-RPC and

// answers directly, the same shape as any Worker-only MCP server would,

// reaching into the Durable Object only for the WS upgrade and the two

// stateful RPC calls (getManifest / callTool).

// =====================================================================


export default {

async fetch(request, env) {

const url = new URL(request.url);


// WebSocket upgrade for the extension — the one request that has to

// go straight to the object holding the socket.

if (isWebSocketUpgrade(request) && url.pathname === "/ws") {

if (!checkAuth(request, url, env)) return new Response("Unauthorized", { status: 401 });

const id = env.MCP_BRIDGE.idFromName("singleton");

const stub = env.MCP_BRIDGE.get(id);

return stub.fetch(request);

}


if (request.method === "OPTIONS") {

return new Response(null, { status: 204, headers: corsHeaders() });

}


// Everything else (whether hit at "/", "/mcp", or anywhere) is the MCP

// JSON-RPC endpoint, handled right here.

if (request.method !== "POST") {

return new Response(

"This MCP server only implements Streamable HTTP in JSON-response mode: send a POST with a JSON-RPC body.",

{ status: 405, headers: corsHeaders() }

);

}


if (!checkAuth(request, url, env)) {

return jsonResponse(jsonRpcError(null, -32001, "Unauthorized"), 401);

}


let body;

try {

body = await request.json();

} catch (e) {

return jsonResponse(jsonRpcError(null, -32700, "Parse error"), 400);

}


const doId = env.MCP_BRIDGE.idFromName("singleton");

const stub = env.MCP_BRIDGE.get(doId);


const isBatch = Array.isArray(body);

const messages = isBatch ? body : [body];

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
