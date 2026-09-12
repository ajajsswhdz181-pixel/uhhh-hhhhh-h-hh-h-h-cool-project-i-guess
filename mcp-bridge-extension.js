// MCP Bridge — PenguinMod / TurboWarp extension
// -----------------------------------------------------------------------------
// The project-side half of the MCP Bridge. Connects a project-defined set of MCP
// tools to the Cloudflare Worker over a single WebSocket.
//
// Wire protocol (JSON text frames both directions — no empty frames):
//   Worker -> here   {t:"hello"} {t:"ping"} {t:"manifest_req"} {t:"call", ...}
//   here -> Worker   {t:"pong"} {t:"manifest"} {t:"refresh_manifest"}
//                    {t:"result", ...} {t:"raw_result", ...}
//
// Tool definitions live in a hidden Stage variable, so they save with the
// project rather than with the browser.
(function (Scratch) {
  "use strict";

  const EXT_ID = "mcpBridge";
  const STORAGE_VAR_NAME = "☣ MCP Bridge Tool Definitions (do not edit)";
  const ARG_TYPES = ["string", "number", "boolean", "array", "object", "any"];
  const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

  // ---------------------------------------------------------------------------
  // Tool storage (hidden Stage variable)
  // ---------------------------------------------------------------------------

  function stage() {
    return Scratch.vm && Scratch.vm.runtime ? Scratch.vm.runtime.getTargetForStage() : null;
  }

  function storageVariable(target) {
    if (!target || !target.variables) return null;
    return Object.entries(target.variables).find(([, variable]) => variable.name === STORAGE_VAR_NAME) || null;
  }

  function loadTools() {
    const found = storageVariable(stage());
    if (!found) return [];
    try {
      const tools = JSON.parse(found[1].value);
      return Array.isArray(tools) ? tools.filter((tool) => tool && tool.name) : [];
    } catch (e) {
      return [];
    }
  }

  function saveTools(tools) {
    const target = stage();
    if (!target) return;
    let found = storageVariable(target);
    if (!found) {
      const id = `mcpbridge_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
      target.createVariable(id, STORAGE_VAR_NAME, "");
      found = [id, target.variables[id]];
    }
    found[1].value = JSON.stringify(tools);
  }

  // ---------------------------------------------------------------------------
  // URL handling
  // ---------------------------------------------------------------------------

  // Almost every "it just won't connect / code 1006" report comes down to the
  // URL, so take whatever the user typed and turn it into something valid:
  //   your-worker.workers.dev          -> wss://your-worker.workers.dev/ws
  //   https://your-worker.workers.dev  -> wss://your-worker.workers.dev/ws
  //   wss://your-worker.workers.dev/ws -> unchanged
  // A path that is already present is left alone — the Worker upgrades on any
  // path, so only a completely bare URL gets /ws appended.
  function normalizeUrl(raw) {
    let text = String(raw == null ? "" : raw).trim();
    if (!text) return { url: "", error: "The URL is empty." };

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `wss://${text}`;
    text = text.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");

    let parsed;
    try {
      parsed = new URL(text);
    } catch (e) {
      return { url: "", error: `"${raw}" is not a valid URL.` };
    }

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return { url: "", error: `The URL must use ws:// or wss://, not ${parsed.protocol}` };
    }
    if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/ws";

    return { url: parsed.toString(), error: null };
  }

  // TurboWarp/PenguinMod gate outbound connections behind a permission prompt.
  // The check speaks http(s), so ask about the equivalent https:// origin.
  async function permitted(wsUrl) {
    if (!Scratch.canFetch) return true;
    try {
      const probe = wsUrl.replace(/^ws:\/\//i, "http://").replace(/^wss:\/\//i, "https://");
      return await Scratch.canFetch(probe);
    } catch (e) {
      return true; // no permission layer available; let the WebSocket decide
    }
  }

  function stringify(value) {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  function closeCodeHelp(code) {
    switch (code) {
      case 1000:
        return "closed normally";
      case 1006:
        return "closed abnormally (1006) — the connection never completed, or died without a close frame. " +
          "Check the URL, and if the Worker has MCP_AUTH_TOKEN set, that ?token=... is on the URL. " +
          "Opening the same URL as https:// in a browser tab shows the Worker's status page and the real reason.";
      case 1011:
        return "the server hit an internal error (1011)";
      case 1015:
        return "TLS failed (1015) — check the certificate on the Worker's domain";
      default:
        return `closed with code ${code}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool definition dialog
  // ---------------------------------------------------------------------------

  function escapeAttribute(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function showToolDialog(existing) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:99999;background:#0008;display:grid;place-items:center;font:14px sans-serif";

      const dialog = document.createElement("form");
      dialog.style.cssText =
        "background:white;color:#111;border-radius:10px;padding:18px;width:min(560px,92vw);max-height:82vh;overflow:auto";
      dialog.innerHTML =
        `<h2 style="margin-top:0">${existing && existing.name ? "Edit" : "Define"} MCP tool</h2>` +
        `<label>Tool name <input required name="name" value="${escapeAttribute(existing && existing.name)}"></label><br>` +
        `<label>Description <textarea name="description" rows="2" style="width:100%">${escapeAttribute(existing && existing.description)}</textarea></label>` +
        `<h3>Arguments</h3><div data-args></div>` +
        `<button type="button" data-add>Add argument</button>` +
        `<p><button type="button" data-cancel>Cancel</button> <button>Save</button></p>`;

      const args = dialog.querySelector("[data-args]");
      const addArgument = (argument) => {
        const a = argument || {};
        const row = document.createElement("p");
        row.innerHTML =
          `<input data-name placeholder="name" value="${escapeAttribute(a.name)}">` +
          `<select data-type>${ARG_TYPES.map((type) => `<option ${a.type === type ? "selected" : ""}>${type}</option>`).join("")}</select>` +
          `<input data-description placeholder="description" value="${escapeAttribute(a.description)}">` +
          `<label><input data-required type="checkbox" ${a.required ? "checked" : ""}> required</label> ` +
          `<button type="button" data-remove>Remove</button>`;
        row.querySelector("[data-remove]").onclick = () => row.remove();
        args.append(row);
      };

      ((existing && existing.arguments) || []).forEach(addArgument);
      dialog.querySelector("[data-add]").onclick = () => addArgument();

      const finish = (value) => {
        overlay.remove();
        resolve(value);
      };

      dialog.querySelector("[data-cancel]").onclick = () => finish(null);
      dialog.onsubmit = (event) => {
        event.preventDefault();
        const name = dialog.elements.name.value.trim();
        if (!name) return;
        const argumentsList = [...args.children]
          .map((row) => ({
            name: row.querySelector("[data-name]").value.trim(),
            type: row.querySelector("[data-type]").value,
            description: row.querySelector("[data-description]").value.trim(),
            required: row.querySelector("[data-required]").checked,
          }))
          .filter((argument) => argument.name);
        finish({ name, description: dialog.elements.description.value.trim(), arguments: argumentsList });
      };

      overlay.onclick = (event) => {
        if (event.target === overlay) finish(null);
      };

      overlay.append(dialog);
      document.body.append(overlay);
      dialog.elements.name.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Extension
  // ---------------------------------------------------------------------------

  class McpBridgeExtension {
    constructor() {
      this.tools = [];
      this.loaded = false;

      this.ws = null;
      this.url = "";
      this.status = "disconnected"; // disconnected | connecting | connected
      this.lastError = "";
      this.autoReconnect = true;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.intentionalClose = false;
      this.lastCall = null; // fallback for respond blocks used outside the hat

      if (Scratch.vm && Scratch.vm.runtime) {
        Scratch.vm.runtime.on("PROJECT_LOADED", () => {
          this.tools = loadTools();
          this.loaded = true;
        });
        // Stopping the project should not leave a socket dangling.
        Scratch.vm.runtime.on("PROJECT_STOP_ALL", () => this.cancelReconnect());
      }
      queueMicrotask(() => this._load());
    }

    _load() {
      if (!this.loaded) {
        this.tools = loadTools();
        this.loaded = true;
      }
    }

    // ---- socket plumbing ----

    _send(message) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify(message));
          return true;
        } catch (e) {
          this.lastError = `Send failed: ${(e && e.message) || e}`;
        }
      }
      return false;
    }

    _sendManifest() {
      this._load();
      return this._send({ t: "manifest", tools: this.tools });
    }

    _handleMessage(raw) {
      if (raw === "" || raw == null) return; // legacy keepalive from older Workers
      let message;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : String(raw));
      } catch (e) {
        return;
      }
      if (!message || typeof message !== "object") return;

      switch (message.t) {
        case "hello":
          // The Worker greets us as soon as the handshake really completed, so
          // this is the point where the manifest is worth pushing.
          this._sendManifest();
          return;

        case "ping":
          this._send({ t: "pong", ts: message.ts });
          return;

        case "manifest_req":
          this._sendManifest();
          return;

        case "call": {
          this.lastCall = message;
          const threads = (Scratch.vm.runtime.startHats(`${EXT_ID}_whenToolCalled`) || []);
          if (!threads.length) {
            // Nothing is listening; answering now beats making the Worker wait
            // out its full call timeout.
            this._send({
              t: "result",
              id: message.id,
              ok: false,
              error: `The project has no "when a tool is called" script running, so "${message.tool}" went unhandled.`,
            });
            return;
          }
          for (const thread of threads) thread.mcpCall = message;
          return;
        }

        default:
          return;
      }
    }

    cancelReconnect() {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }

    scheduleReconnect() {
      if (!this.autoReconnect || this.intentionalClose || !this.url) return;
      this.cancelReconnect();
      const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._open(this.url).catch(() => {});
      }, delay);
    }

    // Resolves once the socket is open or has definitively failed. It never
    // rejects: a Scratch block that throws just stalls the script silently, so
    // failures are reported through the "last connection error" reporter.
    async _open(url) {
      this.cancelReconnect();
      this.intentionalClose = false;

      if (this.ws) {
        const stale = this.ws;
        this.ws = null;
        try {
          stale.onopen = stale.onmessage = stale.onclose = stale.onerror = null;
          stale.close(1000, "reconnecting");
        } catch (e) {
          /* already gone */
        }
      }

      if (!(await permitted(url))) {
        this.status = "disconnected";
        this.lastError = `Permission to connect to ${url} was denied by the editor.`;
        return;
      }

      this.status = "connecting";
      this.lastError = "";

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        let ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          this.status = "disconnected";
          this.lastError = `Could not open a WebSocket to ${url}: ${(e && e.message) || e}`;
          finish();
          return;
        }

        ws.onopen = () => {
          this.ws = ws;
          this.status = "connected";
          this.lastError = "";
          this.reconnectAttempt = 0;
          this._sendManifest();
          finish();
        };

        ws.onmessage = (event) => this._handleMessage(event.data);

        ws.onerror = () => {
          // Browsers deliberately withhold the details here; onclose carries
          // the only code we ever get.
          if (this.status !== "connected") {
            this.lastError = `Connection to ${url} failed before it opened.`;
          }
        };

        ws.onclose = (event) => {
          if (this.ws === ws) this.ws = null;
          this.status = "disconnected";
          if (!this.intentionalClose) {
            this.lastError = `${url} ${closeCodeHelp(event.code)}${event.reason ? ` — ${event.reason}` : ""}`;
            this.scheduleReconnect();
          }
          finish();
        };
      });
    }

    // ---- block definitions ----

    getInfo() {
      const string = Scratch.ArgumentType.STRING;
      const command = Scratch.BlockType.COMMAND;
      const reporter = Scratch.BlockType.REPORTER;
      const boolean = Scratch.BlockType.BOOLEAN;

      return {
        id: EXT_ID,
        name: "MCP Bridge",
        color1: "#4c3d99",
        color2: "#3b2f7a",
        blocks: [
          {
            opcode: "connectServer",
            blockType: command,
            text: "connect to MCP server [URL]",
            arguments: { URL: { type: string, defaultValue: "wss://your-worker.workers.dev/ws" } },
          },
          { opcode: "disconnectServer", blockType: command, text: "disconnect from MCP server" },
          { opcode: "isConnected", blockType: boolean, text: "connected to server?" },
          { opcode: "connectionStatus", blockType: reporter, text: "connection status" },
          { opcode: "lastConnectionError", blockType: reporter, text: "last connection error" },
          {
            opcode: "setAutoReconnect",
            blockType: command,
            text: "set auto-reconnect to [ON]",
            arguments: { ON: { type: string, menu: "onOff" } },
          },
          "---",
          { opcode: "defineTool", blockType: command, text: "define a new tool..." },
          {
            opcode: "editTool",
            blockType: command,
            text: "edit tool [NAME]...",
            arguments: { NAME: { type: string, menu: "toolNames" } },
          },
          {
            opcode: "removeTool",
            blockType: command,
            text: "remove tool [NAME]",
            arguments: { NAME: { type: string, menu: "toolNames" } },
          },
          { opcode: "refreshManifest", blockType: command, text: "push current tool list to server now" },
          { opcode: "toolNamesJson", blockType: reporter, text: "defined tool names (JSON)" },
          "---",
          {
            opcode: "whenToolCalled",
            blockType: Scratch.BlockType.EVENT,
            text: "when a tool is called",
            isEdgeActivated: false,
            shouldRestartExistingThreads: false,
          },
          { opcode: "calledToolName", blockType: reporter, text: "called tool name" },
          { opcode: "currentCallId", blockType: reporter, text: "current call ID" },
          {
            opcode: "callArgument",
            blockType: reporter,
            text: "argument [ARG]",
            arguments: { ARG: { type: string, defaultValue: "name" } },
          },
          { opcode: "allArgumentsJson", blockType: reporter, text: "all arguments (JSON)" },
          { opcode: "rawRequestJson", blockType: reporter, text: "raw MCP request (JSON)" },
          "---",
          {
            opcode: "respond",
            blockType: command,
            text: "respond with [VALUE]",
            arguments: { VALUE: { type: string, defaultValue: "ok" } },
          },
          {
            opcode: "respondError",
            blockType: command,
            text: "respond with error [VALUE]",
            arguments: { VALUE: { type: string, defaultValue: "something went wrong" } },
          },
          {
            opcode: "respondToId",
            blockType: command,
            text: "respond to call [ID] with [VALUE]",
            arguments: { ID: { type: string }, VALUE: { type: string, defaultValue: "ok" } },
          },
          {
            opcode: "respondErrorToId",
            blockType: command,
            text: "respond to call [ID] with error [VALUE]",
            arguments: { ID: { type: string }, VALUE: { type: string, defaultValue: "something went wrong" } },
          },
          {
            opcode: "respondRawToId",
            blockType: command,
            text: "respond to call [ID] with raw MCP result JSON [JSON]",
            arguments: {
              ID: { type: string },
              JSON: { type: string, defaultValue: '{"content":[{"type":"text","text":"hi"}]}' },
            },
          },
        ],
        menus: {
          toolNames: { acceptReporters: true, items: "_getToolNamesMenu" },
          onOff: { acceptReporters: true, items: ["on", "off"] },
        },
      };
    }

    _getToolNamesMenu() {
      this._load();
      return this.tools.length ? this.tools.map((tool) => tool.name) : ["(no tools defined yet)"];
    }

    // ---- connection blocks ----

    async connectServer(args) {
      this._load();
      const { url, error } = normalizeUrl(Scratch.Cast.toString(args.URL));
      if (error) {
        this.status = "disconnected";
        this.lastError = error;
        return;
      }
      this.url = url;
      this.reconnectAttempt = 0;
      await this._open(url);
    }

    disconnectServer() {
      this.intentionalClose = true;
      this.cancelReconnect();
      if (this.ws) {
        try {
          this.ws.close(1000, "disconnected by the project");
        } catch (e) {
          /* already gone */
        }
      }
      this.ws = null;
      this.status = "disconnected";
    }

    isConnected() {
      return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
    }

    connectionStatus() {
      return this.status;
    }

    lastConnectionError() {
      return this.lastError;
    }

    setAutoReconnect(args) {
      const value = Scratch.Cast.toString(args.ON).toLowerCase();
      this.autoReconnect = value === "on" || value === "true" || value === "yes";
      if (!this.autoReconnect) this.cancelReconnect();
    }

    // ---- tool definition blocks ----

    defineTool() {
      this._load();
      return showToolDialog(null).then((tool) => this._replaceTool(tool));
    }

    editTool(args) {
      this._load();
      const name = Scratch.Cast.toString(args.NAME);
      const existing = this.tools.find((tool) => tool.name === name) || { name };
      return showToolDialog(existing).then((tool) => this._replaceTool(tool, name));
    }

    removeTool(args) {
      this._load();
      const name = Scratch.Cast.toString(args.NAME);
      this.tools = this.tools.filter((tool) => tool.name !== name);
      saveTools(this.tools);
      this._sendManifest();
    }

    refreshManifest() {
      this._sendManifest();
    }

    toolNamesJson() {
      this._load();
      return JSON.stringify(this.tools.map((tool) => tool.name));
    }

    // `previousName` lets a rename replace the old entry instead of leaving a
    // stale duplicate behind.
    _replaceTool(tool, previousName) {
      if (!tool || !tool.name) return;
      this.tools = [
        ...this.tools.filter((candidate) => candidate.name !== tool.name && candidate.name !== previousName),
        tool,
      ];
      saveTools(this.tools);
      this._sendManifest();
    }

    // ---- call inspection blocks ----

    _currentCall(util) {
      return (util && util.thread && util.thread.mcpCall) || this.lastCall || null;
    }

    calledToolName(_args, util) {
      const call = this._currentCall(util);
      return call ? call.tool || "" : "";
    }

    currentCallId(_args, util) {
      const call = this._currentCall(util);
      return call ? call.id || "" : "";
    }

    callArgument(args, util) {
      const call = this._currentCall(util);
      const values = (call && call.arguments) || {};
      const value = values[Scratch.Cast.toString(args.ARG)];
      return value === undefined ? "" : stringify(value);
    }

    allArgumentsJson(_args, util) {
      const call = this._currentCall(util);
      return JSON.stringify((call && call.arguments) || {});
    }

    rawRequestJson(_args, util) {
      const call = this._currentCall(util);
      return JSON.stringify((call && call.raw) || {});
    }

    // ---- response blocks ----

    respond(args, util) {
      const call = this._currentCall(util);
      if (call) this._send({ t: "result", id: call.id, ok: true, value: Scratch.Cast.toString(args.VALUE) });
    }

    respondError(args, util) {
      const call = this._currentCall(util);
      if (call) this._send({ t: "result", id: call.id, ok: false, error: Scratch.Cast.toString(args.VALUE) });
    }

    respondToId(args) {
      this._send({ t: "result", id: Scratch.Cast.toString(args.ID), ok: true, value: Scratch.Cast.toString(args.VALUE) });
    }

    respondErrorToId(args) {
      this._send({ t: "result", id: Scratch.Cast.toString(args.ID), ok: false, error: Scratch.Cast.toString(args.VALUE) });
    }

    respondRawToId(args) {
      const text = Scratch.Cast.toString(args.JSON);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (e) {
        payload = { content: [{ type: "text", text }] };
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        payload = { content: [{ type: "text", text }] };
      }
      this._send({ t: "raw_result", id: Scratch.Cast.toString(args.ID), payload });
    }
  }

  Scratch.extensions.register(new McpBridgeExtension());
})(Scratch);
