// MCP Bridge — PenguinMod / TurboWarp extension
// Connects a project-defined set of MCP tools to the Cloudflare Worker.
(function (Scratch) {
  "use strict";

  const EXT_ID = "mcpBridge";
  const STORAGE_VAR_NAME = "☣ MCP Bridge Tool Definitions (do not edit)";

  function stage() {
    return Scratch.vm.runtime.getTargetForStage();
  }

  function storageVariable(target) {
    if (!target || !target.variables) return null;
    return Object.entries(target.variables).find(([, variable]) => variable.name === STORAGE_VAR_NAME);
  }

  function loadTools() {
    const found = storageVariable(stage());
    if (!found) return [];
    try {
      const tools = JSON.parse(found[1].value);
      return Array.isArray(tools) ? tools : [];
    } catch {
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

  function stringify(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function showToolDialog(existing) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0008;display:grid;place-items:center;font:14px sans-serif";
      const dialog = document.createElement("form");
      dialog.style.cssText = "background:white;color:#111;border-radius:10px;padding:18px;width:min(520px,90vw);max-height:80vh;overflow:auto";
      dialog.innerHTML = `<h2>${existing ? "Edit" : "Define"} MCP tool</h2>
        <label>Tool name <input required name="name" value="${existing?.name || ""}"></label><br>
        <label>Description <textarea name="description">${existing?.description || ""}</textarea></label>
        <h3>Arguments</h3><div data-args></div>
        <button type="button" data-add>Add argument</button>
        <p><button type="button" data-cancel>Cancel</button> <button>Save</button></p>`;
      const args = dialog.querySelector("[data-args]");
      const addArgument = (argument = {}) => {
        const row = document.createElement("p");
        row.innerHTML = `<input data-name placeholder="name" value="${argument.name || ""}">
          <select data-type>${["string", "number", "boolean", "array", "object", "any"].map((type) => `<option ${argument.type === type ? "selected" : ""}>${type}</option>`).join("")}</select>
          <input data-description placeholder="description" value="${argument.description || ""}">
          <label><input data-required type="checkbox" ${argument.required ? "checked" : ""}> required</label>
          <button type="button" data-remove>Remove</button>`;
        row.querySelector("[data-remove]").onclick = () => row.remove();
        args.append(row);
      };
      (existing?.arguments || []).forEach(addArgument);
      dialog.querySelector("[data-add]").onclick = () => addArgument();
      dialog.querySelector("[data-cancel]").onclick = () => finish(null);
      dialog.onsubmit = (event) => {
        event.preventDefault();
        const argumentsList = [...args.children].map((row) => ({
          name: row.querySelector("[data-name]").value.trim(),
          type: row.querySelector("[data-type]").value,
          description: row.querySelector("[data-description]").value.trim(),
          required: row.querySelector("[data-required]").checked,
        })).filter((argument) => argument.name);
        finish({ name: dialog.elements.name.value.trim(), description: dialog.elements.description.value.trim(), arguments: argumentsList });
      };
      const finish = (value) => { overlay.remove(); resolve(value); };
      overlay.append(dialog);
      document.body.append(overlay);
      dialog.elements.name.focus();
    });
  }

  class McpBridgeExtension {
    constructor() {
      this.tools = [];
      this.ws = null;
      this.loaded = false;
      Scratch.vm.runtime.on("PROJECT_LOADED", () => {
        this.tools = loadTools();
        this.loaded = true;
      });
      queueMicrotask(() => this._load());
    }

    _load() {
      if (!this.loaded) {
        this.tools = loadTools();
        this.loaded = true;
      }
    }

    _send(message) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    }

    _sendManifest() {
      this._send({ t: "manifest", tools: this.tools });
    }

    _currentCall(util) {
      return util?.thread?.mcpCall || null;
    }

    _handleMessage(raw) {
      if (!raw) return; // Worker keepalive frame.
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message?.t === "manifest_req") this._sendManifest();
      if (message?.t === "call") {
        const threads = Scratch.vm.runtime.startHats(`${EXT_ID}_whenToolCalled`) || [];
        for (const thread of threads) thread.mcpCall = message;
      }
    }

    getInfo() {
      const string = Scratch.ArgumentType.STRING;
      const command = Scratch.BlockType.COMMAND;
      const reporter = Scratch.BlockType.REPORTER;
      return {
        id: EXT_ID, name: "MCP Bridge", color1: "#4c3d99", color2: "#3b2f7a",
        blocks: [
          { opcode: "connectServer", blockType: command, text: "connect to MCP server [URL]", arguments: { URL: { type: string, defaultValue: "wss://your-worker.workers.dev/ws" } } },
          { opcode: "disconnectServer", blockType: command, text: "disconnect from MCP server" },
          { opcode: "isConnected", blockType: Scratch.BlockType.BOOLEAN, text: "connected to server?" }, "---",
          { opcode: "defineTool", blockType: command, text: "define a new tool..." },
          { opcode: "editTool", blockType: command, text: "edit tool [NAME]...", arguments: { NAME: { type: string, menu: "toolNames" } } },
          { opcode: "removeTool", blockType: command, text: "remove tool [NAME]", arguments: { NAME: { type: string, menu: "toolNames" } } },
          { opcode: "refreshManifest", blockType: command, text: "push current tool list to server now" },
          { opcode: "toolNamesJson", blockType: reporter, text: "defined tool names (JSON)" }, "---",
          { opcode: "whenToolCalled", blockType: Scratch.BlockType.EVENT, text: "when a tool is called", isEdgeActivated: false, shouldRestartExistingThreads: false },
          { opcode: "calledToolName", blockType: reporter, text: "called tool name" },
          { opcode: "currentCallId", blockType: reporter, text: "current call ID" },
          { opcode: "callArgument", blockType: reporter, text: "argument [ARG]", arguments: { ARG: { type: string, defaultValue: "name" } } },
          { opcode: "allArgumentsJson", blockType: reporter, text: "all arguments (JSON)" },
          { opcode: "rawRequestJson", blockType: reporter, text: "raw MCP request (JSON)" }, "---",
          { opcode: "respond", blockType: command, text: "respond with [VALUE]", arguments: { VALUE: { type: string, defaultValue: "ok" } } },
          { opcode: "respondError", blockType: command, text: "respond with error [VALUE]", arguments: { VALUE: { type: string, defaultValue: "something went wrong" } } },
          { opcode: "respondToId", blockType: command, text: "respond to call [ID] with [VALUE]", arguments: { ID: { type: string }, VALUE: { type: string, defaultValue: "ok" } } },
          { opcode: "respondErrorToId", blockType: command, text: "respond to call [ID] with error [VALUE]", arguments: { ID: { type: string }, VALUE: { type: string, defaultValue: "something went wrong" } } },
          { opcode: "respondRawToId", blockType: command, text: "respond to call [ID] with raw MCP result JSON [JSON]", arguments: { ID: { type: string }, JSON: { type: string, defaultValue: '{"content":[{"type":"text","text":"hi"}]}' } } },
        ],
        menus: { toolNames: { acceptReporters: true, items: "_getToolNamesMenu" } },
      };
    }

    _getToolNamesMenu() { this._load(); return this.tools.length ? this.tools.map((tool) => tool.name) : ["(no tools defined yet)"]; }

    connectServer(args) {
      this._load();
      return new Promise((resolve) => {
        if (this.ws) this.ws.close();
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        const ws = new WebSocket(Scratch.Cast.toString(args.URL));
        ws.onopen = () => { this.ws = ws; this._sendManifest(); finish(); };
        ws.onmessage = (event) => this._handleMessage(event.data);
        ws.onclose = finish;
        ws.onerror = finish;
      });
    }

    disconnectServer() { this.ws?.close(); this.ws = null; }
    isConnected() { return this.ws?.readyState === WebSocket.OPEN; }
    defineTool() { this._load(); return showToolDialog().then((tool) => this._replaceTool(tool)); }
    editTool(args) { this._load(); return showToolDialog(this.tools.find((tool) => tool.name === Scratch.Cast.toString(args.NAME)) || { name: args.NAME }).then((tool) => this._replaceTool(tool)); }
    removeTool(args) { this._load(); this.tools = this.tools.filter((tool) => tool.name !== Scratch.Cast.toString(args.NAME)); saveTools(this.tools); this._sendManifest(); }
    refreshManifest() { this._load(); this._sendManifest(); }
    toolNamesJson() { this._load(); return JSON.stringify(this.tools.map((tool) => tool.name)); }

    _replaceTool(tool) {
      if (!tool) return;
      this.tools = [...this.tools.filter((candidate) => candidate.name !== tool.name), tool];
      saveTools(this.tools);
      this._sendManifest();
    }

    calledToolName(_args, util) { return this._currentCall(util)?.tool || ""; }
    currentCallId(_args, util) { return this._currentCall(util)?.id || ""; }
    callArgument(args, util) { const value = this._currentCall(util)?.arguments?.[Scratch.Cast.toString(args.ARG)]; return value === undefined ? "" : stringify(value); }
    allArgumentsJson(_args, util) { return JSON.stringify(this._currentCall(util)?.arguments || {}); }
    rawRequestJson(_args, util) { return JSON.stringify(this._currentCall(util)?.raw || {}); }
    respond(args, util) { const call = this._currentCall(util); if (call) this._send({ t: "result", id: call.id, ok: true, value: args.VALUE }); }
    respondError(args, util) { const call = this._currentCall(util); if (call) this._send({ t: "result", id: call.id, ok: false, error: args.VALUE }); }
    respondToId(args) { this._send({ t: "result", id: Scratch.Cast.toString(args.ID), ok: true, value: args.VALUE }); }
    respondErrorToId(args) { this._send({ t: "result", id: Scratch.Cast.toString(args.ID), ok: false, error: args.VALUE }); }
    respondRawToId(args) {
      const text = Scratch.Cast.toString(args.JSON);
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { content: [{ type: "text", text }] }; }
      this._send({ t: "raw_result", id: Scratch.Cast.toString(args.ID), payload });
    }
  }

  Scratch.extensions.register(new McpBridgeExtension());
})(Scratch);
