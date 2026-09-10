"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith("$HOME")) return path.join(os.homedir(), p.slice(5));
  return p;
}

const CONFIG_PATH = path.join(__dirname, "config.json");
function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (process.env.BRIDGE_PORT) raw.bridgePort = Number(process.env.BRIDGE_PORT);
  if (process.env.BRIDGE_KEY) raw.bridgeKey = process.env.BRIDGE_KEY;
  if (process.env.MIMO_SID) raw.defaultSid = process.env.MIMO_SID;
  if (process.env.DESKTOP_INFO_PATH) raw.desktopInfoPath = process.env.DESKTOP_INFO_PATH;
  raw.desktopInfoPath = expandHome(raw.desktopInfoPath);
  return raw;
}
let config = loadConfig();

let desktop = { port: 0, token: "" };
function reloadDesktop() {
  try {
    const d = JSON.parse(fs.readFileSync(config.desktopInfoPath, "utf8"));
    desktop = { port: d.port, token: d.token };
  } catch (e) {
    console.error("[bridge] read desktop-api.json failed:", e.message);
  }
}
reloadDesktop();
try {
  fs.watch(path.dirname(config.desktopInfoPath), (ev, name) => {
    if (name === "desktop-api.json") reloadDesktop();
  });
} catch {}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function desktopFetch(p, opts = {}) {
  return fetch(`http://127.0.0.1:${desktop.port}${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${desktop.token}`, ...(opts.headers || {}) },
  });
}

function contentToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
  return String(c || "");
}

// 只发增量：Desktop 会话里本来就有历史，再把全量历史拼成一条发过去会导致
// 上下文翻倍、agent 困惑。取最后一条 user 消息的纯文本即可连续对话。
function lastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if ((arr[i] || {}).role === "user") return contentToText(arr[i].content).slice(0, 35000);
  }
  return contentToText(arr.length ? arr[arr.length - 1].content : "").slice(0, 35000) || "hi";
}

function extractAssistantText(allMessages, sinceMs) {
  const hits = [];
  for (const m of allMessages) {
    const info = m.info || {};
    if (info.role !== "assistant") continue;
    const created = info.time && info.time.created ? info.time.created : 0;
    if (created <= sinceMs) continue;
    const texts = (m.parts || []).filter((p) => p.type === "text" && p.text).map((p) => p.text);
    if (texts.length) hits.push({ created, text: texts.join("\n") });
  }
  hits.sort((a, b) => a.created - b.created);
  return hits.map((h) => h.text).join("\n");
}

async function waitForReply(sid, sinceMs) {
  const deadline = Date.now() + config.timeoutMs;
  let lastText = "";
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const r = await desktopFetch(`/v1/sessions/${encodeURIComponent(sid)}/messages`);
    if (r.status === 401) throw Object.assign(new Error("desktop unauthorized, token rotated?"), { code: 401 });
    if (r.status === 503) throw Object.assign(new Error("desktop not-logged-in"), { code: 503 });
    if (!r.ok) throw new Error(`desktop messages HTTP ${r.status}`);
    const list = await r.json();
    const text = extractAssistantText(Array.isArray(list) ? list : [], sinceMs);
    // agent 是多步工具循环，第一段 text 出来不代表说完：
    // 文本连续 3 轮不再增长才认为收完，避免只拿到半截。
    if (text) {
      if (text === lastText) {
        stableRounds++;
        if (stableRounds >= 3) return text;
      } else {
        lastText = text;
        stableRounds = 0;
      }
    }
    await new Promise((r2) => setTimeout(r2, config.pollMs));
  }
  if (lastText) return lastText;
  throw Object.assign(new Error("desktop reply timeout"), { code: 504 });
}

function sseChunk(model, content, finish) {
  const obj = { id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish || null }] };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (req.method === "GET" && u.pathname === "/health") {
    try {
      const r = await desktopFetch("/v1/health");
      return sendJson(res, 200, { ok: r.ok, desktop: r.status, bridge: "up" });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message) });
    }
  }
  if (req.method === "GET" && u.pathname === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: config.allowedModels.map((id) => ({ id, object: "model", owned_by: "mimo-bridge" })) });
  }
  if (req.method === "POST" && u.pathname === "/v1/chat/completions") {
    if (config.bridgeKey && config.bridgeKey !== "change-me") {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${config.bridgeKey}`) return sendJson(res, 401, { error: { message: "invalid bridge key", type: "auth" } });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: { message: "body must be JSON" } });
    }
    const model = String(body.model || config.allowedModels[0]);
    if (!config.allowedModels.includes(model)) return sendJson(res, 400, { error: { message: `model not allowed: ${model}` } });
    const sid = String(body.sid || config.defaultSid);
    const message = lastUserText(body.messages);
    const stream = body.stream !== false;
    const sinceMs = Date.now();
    try {
      const t = await desktopFetch(`/v1/sessions/${encodeURIComponent(sid)}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, model }),
      });
      if (t.status === 401) return sendJson(res, 401, { error: { message: "desktop unauthorized, re-read desktop-api.json", type: "auth" } });
      if (!t.ok) {
        const txt = await t.text().catch(() => "");
        return sendJson(res, 502, { error: { message: `desktop turns HTTP ${t.status} ${txt.slice(0, 200)}`, type: "upstream" } });
      }
      const reply = await waitForReply(sid, sinceMs);
      if (!stream) {
        return sendJson(res, 200, { id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      res.write(sseChunk(model, "", null));
      for (let i = 0; i < reply.length; i += 800) res.write(sseChunk(model, reply.slice(i, i + 800), null));
      res.write(sseChunk(model, "", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e) {
      if (!res.headersSent) return sendJson(res, e.code === 504 ? 504 : 502, { error: { message: String(e.message), type: "upstream" } });
      try { res.end(); } catch {}
    }
    return;
  }
  return sendJson(res, 404, { error: { message: "not found" } });
});

server.listen(config.bridgePort, "127.0.0.1", () => {
  console.log(`[mimo-bridge] listening on 127.0.0.1:${config.bridgePort} desktop=${desktop.port}`);
});
