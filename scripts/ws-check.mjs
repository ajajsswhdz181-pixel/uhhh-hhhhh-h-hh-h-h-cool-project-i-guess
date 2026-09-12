#!/usr/bin/env node
/**
 * ws-check — find out what a WebSocket close code 1006 is hiding.
 *
 *   node scripts/ws-check.mjs wss://your-worker.workers.dev/ws
 *   node scripts/ws-check.mjs wss://your-worker.workers.dev/ws --token=secret
 *
 * A browser (and most WebSocket testers) report 1006 for every way a
 * connection can fail before a close frame is possible, and deliberately hide
 * the HTTP response that explains it. This performs the upgrade by hand with
 * Node's raw http/https client, so the real status line, headers and body are
 * visible. It then completes the handshake, reads the server's greeting, and
 * replies to a ping, which exercises the whole keepalive path.
 *
 * No dependencies — Node 18+ only.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPEN_TIMEOUT_MS = 10_000;
const LISTEN_MS = 8_000;

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node scripts/ws-check.mjs <ws(s)://host/path> [--token=TOKEN] [--listen=SECONDS]");
  process.exit(message ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("-h") || argv.includes("--help")) usage();

let target = null;
let token = null;
let listenMs = LISTEN_MS;

for (const arg of argv) {
  if (arg.startsWith("--token=")) token = arg.slice("--token=".length);
  else if (arg.startsWith("--listen=")) listenMs = Number(arg.slice("--listen=".length)) * 1000;
  else if (arg.startsWith("-")) usage(`unknown option ${arg}`);
  else target = arg;
}

if (!target) usage("no URL given");

let url;
try {
  let text = target.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `wss://${text}`;
  text = text.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  url = new URL(text);
} catch (e) {
  usage(`"${target}" is not a valid URL`);
}

if (url.protocol !== "ws:" && url.protocol !== "wss:") usage(`expected ws:// or wss://, got ${url.protocol}`);
if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
if (token) url.searchParams.set("token", token);

const secure = url.protocol === "wss:";
const httpUrl = `${secure ? "https" : "http"}://${url.host}${url.pathname}${url.search}`;

console.log(`WebSocket URL : ${url.toString()}`);
console.log(`Plain HTTP    : ${httpUrl}`);
console.log("");

// ---------------------------------------------------------------------------
// Step 1: the status page. If this fails, nothing else can work.
// ---------------------------------------------------------------------------

console.log("[1/2] GET the same URL over plain HTTP (the Worker's status page)");
try {
  const response = await fetch(httpUrl, { headers: { Accept: "application/json" } });
  const body = await response.text();
  console.log(`      HTTP ${response.status} ${response.statusText}`);
  console.log(
    body
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n")
  );
  if (response.status === 401) {
    console.log("\n      ^ This is your 1006. The server wants a token; pass --token=... and put");
    console.log("        ?token=... on the URL you give the extension or the tester.");
  }
} catch (e) {
  console.log(`      request failed: ${e.message}`);
  console.log("      ^ The Worker is not reachable at all — check the hostname and that");
  console.log("        `wrangler deploy` actually succeeded.");
}
console.log("");

// ---------------------------------------------------------------------------
// Step 2: the handshake, done by hand so the HTTP response stays visible.
// ---------------------------------------------------------------------------

console.log("[2/2] Perform the WebSocket upgrade by hand");

const key = randomBytes(16).toString("base64");
const expectedAccept = createHash("sha1").update(key + GUID).digest("base64");

const request = (secure ? https : http).request({
  host: url.hostname,
  port: url.port || (secure ? 443 : 80),
  path: `${url.pathname}${url.search}`,
  method: "GET",
  headers: {
    Host: url.host,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
});

let finished = false;
const done = (code) => {
  if (finished) return;
  finished = true;
  process.exit(code);
};

const openTimer = setTimeout(() => {
  console.log("      timed out waiting for a response — the host accepted the TCP connection");
  console.log("      but never answered the upgrade.");
  done(1);
}, OPEN_TIMEOUT_MS);

// The server rejected the upgrade: this is the response a WebSocket client
// throws away before reporting 1006.
request.on("response", (response) => {
  clearTimeout(openTimer);
  console.log(`      HTTP ${response.statusCode} ${response.statusMessage}  <- upgrade REJECTED`);
  for (const [name, value] of Object.entries(response.headers)) {
    console.log(`      ${name}: ${value}`);
  }
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    body += chunk;
  });
  response.on("end", () => {
    if (body.trim()) {
      console.log("");
      console.log(
        body
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n")
      );
    }
    console.log("");
    console.log("      ^ THIS is what your tester reports as 1006. The text above is the reason.");
    done(1);
  });
});

request.on("upgrade", (response, socket, head) => {
  clearTimeout(openTimer);
  console.log(`      HTTP ${response.statusCode} ${response.statusMessage}  <- upgrade ACCEPTED`);

  const accept = response.headers["sec-websocket-accept"];
  const accepted = accept === expectedAccept;
  console.log(`      Sec-WebSocket-Accept: ${accept} ${accepted ? "(valid)" : `(INVALID, expected ${expectedAccept})`}`);
  if (response.headers["sec-websocket-protocol"]) {
    console.log(`      Sec-WebSocket-Protocol: ${response.headers["sec-websocket-protocol"]}`);
  }
  console.log("");
  console.log(`      Connected. Listening for ${Math.round(listenMs / 1000)}s...`);

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame;
    while ((frame = readFrame(buffer))) {
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        console.log(`      <- CLOSE ${code} ${frame.payload.subarray(2).toString("utf8")}`);
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        console.log("      <- PING (replying with PONG)");
        socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) {
        console.log("      <- PONG");
        continue;
      }
      if (frame.opcode === 0x1) {
        const text = frame.payload.toString("utf8");
        console.log(`      <- ${text.length === 0 ? "(EMPTY TEXT FRAME — some clients abort on these)" : text}`);
        // Answer the bridge's application-level keepalive so the server sees
        // traffic in both directions, exactly as the extension would.
        try {
          const message = JSON.parse(text);
          if (message && message.t === "ping") {
            socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ t: "pong", ts: message.ts }))));
            console.log("      -> {\"t\":\"pong\"}");
          }
          if (message && message.t === "manifest_req") {
            socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ t: "manifest", tools: [] }))));
            console.log("      -> {\"t\":\"manifest\",\"tools\":[]}  (ws-check defines no tools)");
          }
        } catch (e) {
          /* not JSON; nothing to answer */
        }
      }
    }
  });

  socket.on("close", () => {
    console.log("      socket closed.");
    done(0);
  });
  socket.on("error", (e) => {
    console.log(`      socket error: ${e.message}`);
    done(1);
  });

  setTimeout(() => {
    console.log("");
    console.log("      Listen window over — the connection stayed up. The server side is healthy.");
    socket.write(encodeFrame(0x8, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("ws-check done")])));
    socket.end();
    setTimeout(() => done(0), 500);
  }, listenMs);
});

request.on("error", (e) => {
  clearTimeout(openTimer);
  console.log(`      connection failed: ${e.message}`);
  console.log("      ^ Reported as 1006 by a WebSocket client. DNS or TLS, not the Worker's code.");
  done(1);
});

request.end();

// ---------------------------------------------------------------------------
// Minimal RFC 6455 frame codec — enough to read server frames and write
// masked client frames. Server-to-client frames are never masked.
// ---------------------------------------------------------------------------

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  let payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = randomBytes(4);
  const header = [];

  header.push(0x80 | opcode);
  if (data.length < 126) {
    header.push(0x80 | data.length);
  } else if (data.length < 65536) {
    header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    header.push(0x80 | 127, 0, 0, 0, 0, (data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff);
  }

  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from(header), mask, masked]);
}
