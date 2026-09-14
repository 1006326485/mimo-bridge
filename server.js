"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const directAuth = require("./direct-auth");

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
  raw.mode = raw.mode || "desktop";
  raw.directBase = (raw.directBase || "https://mimo-server-sgp.xiaomimimo.com/api").replace(/\/+$/, "");
  if (raw.partitionDb) raw.partitionDb = expandHome(raw.partitionDb);
  // 多租户：keys 表优先，单 key 老配置自动兼容成 default 条目
  if (!Array.isArray(raw.keys) || !raw.keys.length) {
    raw.keys = [{ key: raw.bridgeKey || "change-me", label: "default", sid: raw.defaultSid || "" }];
  }
  raw.keys = raw.keys.filter((k) => k && typeof k.key === "string" && k.key && k.key !== "change-me" && !k.key.startsWith("PASTE_"));
  return raw;
}
let config = loadConfig();

// 每个 Key 独立计数：用量、错误、token、末次使用，不记任何正文
const stats = new Map();
function touchStats(label, ok, usage) {
  const s = stats.get(label) || { requests: 0, errors: 0, tokens: { input: 0, output: 0, total: 0 }, lastUsed: "" };
  s.requests++;
  if (!ok) s.errors++;
  if (usage) {
    s.tokens.input += usage.input || 0;
    s.tokens.output += usage.output || 0;
    s.tokens.total += usage.total || 0;
  }
  s.lastUsed = new Date().toISOString();
  stats.set(label, s);
}
function maskKey(k) {
  if (typeof k !== "string" || k.length <= 8) return "****";
  return `${k.slice(0, 4)}...${k.slice(-2)}`;
}
function authKey(req) {
  const m = /^(?:Bearer[ \t]+)(\S+)$/i.exec(String(req.headers.authorization || "").trim());
  if (!m) return null;
  return config.keys.find((k) => k.key === m[1]) || null;
}

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
// 对齐 Desktop 自身 Db() 语义：允许 "provider/model" 写法，取 / 后为真模型名
function normalizeModel(m) {
  const s = String(m || "");
  const i = s.indexOf("/");
  return i > 0 && i < s.length - 1 ? s.slice(i + 1) : s;
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
  const usage = { input: 0, output: 0, total: 0 };
  for (const m of allMessages) {
    const info = m.info || {};
    if (info.role !== "assistant") continue;
    const created = info.time && info.time.created ? info.time.created : 0;
    if (created <= sinceMs) continue;
    for (const p of m.parts || []) {
      if (p.type === "text" && p.text) hits.push({ created, text: p.text });
      // step-finish 自带本 turn 的 tokens，直接累加做计量
      if (p.type === "step-finish" && p.tokens) {
        usage.input += p.tokens.input || 0;
        usage.output += p.tokens.output || 0;
        usage.total += p.tokens.total || 0;
      }
    }
  }
  hits.sort((a, b) => a.created - b.created);
  return { text: hits.map((h) => h.text).join("\n"), usage };
}

async function waitForReply(sid, sinceMs, onProgress) {
  const deadline = Date.now() + config.timeoutMs;
  let lastText = "";
  let lastUsage = { input: 0, output: 0, total: 0 };
  let stableRounds = 0;
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    const r = await desktopFetch(`/v1/sessions/${encodeURIComponent(sid)}/messages`);
    if (r.status === 401) throw Object.assign(new Error("desktop unauthorized, token rotated?"), { code: 401 });
    if (r.status === 503) throw Object.assign(new Error("desktop not-logged-in"), { code: 503 });
    if (!r.ok) throw new Error(`desktop messages HTTP ${r.status}`);
    const list = await r.json();
    const { text, usage } = extractAssistantText(Array.isArray(list) ? list : [], sinceMs);
    // agent 是多步工具循环，第一段 text 出来不代表说完：
    // 文本连续 3 轮不再增长才认为收完，避免只拿到半截。
    if (text) {
      if (text === lastText) {
        stableRounds++;
        lastUsage = usage;
        if (stableRounds >= 3) return { text, usage };
      } else {
        lastText = text;
        lastUsage = usage;
        stableRounds = 0;
      }
    }
    await new Promise((r2) => setTimeout(r2, config.pollMs));
    if (onProgress && Date.now() - lastBeat > 20000) {
      lastBeat = Date.now();
      try { onProgress(); } catch {}
    }
  }
  if (lastText) return { text: lastText, usage: lastUsage };
  throw Object.assign(new Error("desktop reply timeout"), { code: 504 });
}

function sseChunk(model, content, finish) {
  const obj = { id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish || null }] };
  return `data: ${JSON.stringify(obj)}\n\n`;
}
// 空 delta 心跳：标准 SSE 注释，下游按规范忽略，不污染 JSON 流。
// 用来立刻清掉上游 15s 首字节断头台，桌面模式等待期间每 20s 一次防 idle。
// 注意：之前用过伪造的 chat.completion.chunk 做心跳，id 与上游真实 id 不一致，
// 严格客户端可能校验失败，改用注释更安全。
function sseHeartbeat(model, res) {
  try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch {}
}
function sseErrorAndDone(res, message) {
  try { res.write(`data: ${JSON.stringify({ error: { message: String(message).slice(0, 500), type: "upstream" } })}\n\n`); } catch {}
  try { res.write("data: [DONE]\n\n"); } catch {}
}

// 直调：不经过 Desktop 会话，Cookie 换票后直发 route 网关
// 注意：网关只接受 stream:true，非流式也在上游走流式再拼装
// passthrough：上游透传的 OpenAI 标准字段（tools 等），缺了 agent 长链任务
// 会退化成一问一答；只放白名单，避免奇怪字段触发上游 400。
const PASSTHROUGH_KEYS = [
  "tools", "tool_choice", "parallel_tool_calls",
  "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "presence_penalty", "frequency_penalty", "stop", "seed", "response_format",
];
function buildPassthrough(body) {
  const out = {};
  if (!body || typeof body !== "object") return out;
  for (const k of PASSTHROUGH_KEYS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}
async function directChat({ model, messages, stream, label, passthrough }) {
  const url = `${config.directBase}/route/chat/completions`;
  const payload = { model, messages, stream: true, stream_options: { include_usage: true }, ...(passthrough || {}) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const jar = await directAuth.getCookies(config.partitionDb, attempt >= 1);
    let r = null;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Cookie: directAuth.headerFor(jar),
          "User-Agent": "MiMo-Desktop",
          "X-Mimo-Source": "mimocode-desktop",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // 建连层被重置（对方 RST/超时）：下游无感知，重打一次
      if (attempt < 2) {
        await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
    if (r.status === 401 && attempt === 0) continue;
    return r;
  }
}

function parseSseText(sse) {
  let text = "";
  const usage = { input: 0, output: 0, total: 0 };
  // 非流式也要还原 tool_calls，否则 agent 永远拿不到工具调用，长链任务退化成一问一答
  const toolMap = new Map();
  let finishReason = "";
  for (const chunk of sse.split("\n\n")) {
    for (const line of chunk.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0];
        if (d) {
          if (d.finish_reason) finishReason = d.finish_reason;
          if (d.delta && typeof d.delta.content === "string") text += d.delta.content;
          // 兼容 message 形态（极少数网关非流式拼装返回）：content 在 message 里
          if (d.message && typeof d.message.content === "string") text += d.message.content;
          const tcs = (d.delta && d.delta.tool_calls) || d.message?.tool_calls || d.tool_calls;
          if (Array.isArray(tcs)) {
            for (const tc of tcs) {
              const idx = tc.index ?? 0;
              const cur = toolMap.get(idx) || { id: "", type: "function", function: { name: "", arguments: "" } };
              if (tc.id) cur.id = tc.id;
              if (tc.type) cur.type = tc.type;
              if (tc.function) {
                if (tc.function.name) cur.function.name = (cur.function.name || "") + tc.function.name;
                if (typeof tc.function.arguments === "string") cur.function.arguments += tc.function.arguments;
              }
              toolMap.set(idx, cur);
            }
          }
        }
        if (j.usage) {
          usage.input += j.usage.prompt_tokens || 0;
          usage.output += j.usage.completion_tokens || 0;
          usage.total += j.usage.total_tokens || 0;
        }
      } catch {}
    }
  }
  const toolCalls = [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    .filter((v) => v.id || v.function.name || v.function.arguments);
  return { text, usage, toolCalls, finishReason };
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
  // 管理面：同 Bearer 鉴权，只回脱敏 Key 与计数，不回正文
  if (req.method === "GET" && u.pathname === "/admin/keys") {
    const entry = authKey(req);
    if (!entry) return sendJson(res, 401, { error: { message: "invalid bridge key", type: "auth" } });
    return sendJson(res, 200, {
      keys: config.keys.map((k) => ({ label: k.label || "default", key: maskKey(k.key), mode: k.mode || config.mode || "desktop", sid: k.sid || config.defaultSid || "", models: k.models || config.allowedModels, stats: stats.get(k.label || "default") || { requests: 0, errors: 0, tokens: { input: 0, output: 0, total: 0 }, lastUsed: "" } })),
    });
  }
  if (req.method === "POST" && u.pathname === "/admin/reload") {
    const entry = authKey(req);
    if (!entry) return sendJson(res, 401, { error: { message: "invalid bridge key", type: "auth" } });
    config = loadConfig();
    reloadDesktop();
    return sendJson(res, 200, { ok: true, keys: config.keys.length });
  }
  if (req.method === "POST" && u.pathname === "/v1/chat/completions") {
    const entry = authKey(req);
    if (!entry) return sendJson(res, 401, { error: { message: "invalid bridge key", type: "auth" } });
    const label = entry.label || "default";
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: { message: "body must be JSON" } });
    }
    const allowed = entry.models || config.allowedModels;
    const rawModel = String(body.model || allowed[0]);
    const model = normalizeModel(rawModel);
    if (!allowed.includes(model)) return sendJson(res, 400, { error: { message: `model not allowed for this key: ${rawModel}` } });
    // 双模式：一 Key 一模式，默认 desktop；direct 不碰 Desktop 会话
    const runMode = entry.mode || config.mode || "desktop";
    const stream = body.stream !== false;
    const t0 = Date.now();
    const done = (status, extra) => console.log(`[bridge] ${label} ${runMode} model=${model} stream=${stream} -> ${status} ${Date.now() - t0}ms${extra ? " " + extra : ""}`);
    if (runMode === "direct") {
      // 流式先等上游回头最多 8s：正常情况直接透传状态码；
      // 上游回头慢才落头+心跳，顶掉 15s 断头台（此时上游 HTTP 错只能以截流收尾）。
      let r = null;
      let headed = false;
      if (stream) {
        const pending = directChat({ model, messages: Array.isArray(body.messages) ? body.messages : [], stream, label, passthrough: buildPassthrough(body) });
        const slow = new Promise((resolve) => setTimeout(() => resolve("slow"), 10000));
        const won = await Promise.race([pending.then((v) => ({ v })), slow]);
        if (won === "slow") {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
          sseHeartbeat(model, res);
          headed = true;
          // 上游回头前的真空期也要保活：每 20s 一次，直到 fetch 落定
          const keep = setInterval(() => sseHeartbeat(model, res), 20000);
          try {
            r = await pending;
          } finally {
            clearInterval(keep);
          }
        } else {
          r = won.v;
        }
      } else {
        r = await directChat({ model, messages: Array.isArray(body.messages) ? body.messages : [], stream, label, passthrough: buildPassthrough(body) });
      }
      try {
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          touchStats(label, false);
          done(r.status >= 500 ? 502 : r.status, "direct-upstream");
          if (!res.headersSent) return sendJson(res, r.status >= 500 ? 502 : r.status, { error: { message: `upstream ${r.status} ${txt.slice(0, 200)}`, type: "upstream" } });
          // 已落头后不能再改状态码：发 SSE 错误事件 + [DONE]，避免下游报 ended-before-DONE
          sseErrorAndDone(res, `upstream ${r.status} ${txt.slice(0, 200)}`);
          try { res.end(); } catch {}
          return;
        }
        if (!stream) {
          const { text, usage, toolCalls, finishReason } = parseSseText(await r.text());
          touchStats(label, true, { input: usage.input, output: usage.output, total: usage.total });
          done(200, `direct usage=${usage.total}`);
          const message = { role: "assistant", content: text };
          let finish = finishReason || "stop";
          if (toolCalls && toolCalls.length) {
            message.tool_calls = toolCalls;
            finish = "tool_calls";
          }
          return sendJson(res, 200, { id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.total } });
        }
        if (!headed) {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
          sseHeartbeat(model, res);
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        // 下游提前断开就别再写 socket，否则 EPIPE 抛到 catch 里误记为上游错
        let clientClosed = false;
        try { req.on("close", () => { clientClosed = true; try { reader.cancel(); } catch {} }); } catch {}
        // 上游 chunk 间隙超 25s 就补注释心跳：只保下游 idle，不保上游
        let pending = null;
        let seenDone = false;
        let tail = "";
        let carry = "";
        const normalizeSse = (text) => text.replace(/(^|\n)data:(?=\S)/g, "$1data: ");
        for (;;) {
          if (clientClosed) break;
          if (!pending) pending = reader.read();
          let timer = null;
          const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("idle"), 25000); });
          const got = await Promise.race([pending, timeout]);
          if (got === "idle") {
            sseHeartbeat(model, res);
            continue;
          }
          clearTimeout(timer);
          pending = null;
          if (got.done) break;
          const s = decoder.decode(got.value, { stream: true });
          if (s) {
            // [DONE] 可能被 TCP 切成两段，用 tail 拼接后再判，避免漏判导致重复补哨兵
            if ((tail + s).includes("[DONE]")) seenDone = true;
            tail = (tail + s).slice(-16);
            // 上游发的是 data:{...} / data:[DONE]（冒号后无空格），严格下游
            // （如 ai-proxy 以 line.startsWith('data: ') 解析）会整流丢弃，
            // 最终误报 ended-before-DONE。这里按 OpenAI 规范补空格后透传。
            // 用 carry 行缓冲，避免 data: 被 TCP 切散导致单 chunk 正则漏匹配。
            carry += s;
            const parts = carry.split("\n");
            carry = parts.pop() || "";
            const out = normalizeSse(parts.join("\n"));
            if (out) {
              try { res.write(out + "\n"); } catch { clientClosed = true; break; }
            }
          }
        }
        if (carry) {
          if ((tail + carry).includes("[DONE]")) seenDone = true;
          try { res.write(normalizeSse(carry) + "\n"); } catch { clientClosed = true; }
          carry = "";
        }
        try {
          const rest = decoder.decode();
          if (rest && !clientClosed) {
            if (rest.includes("[DONE]")) seenDone = true;
            try { res.write(normalizeSse(rest)); } catch {}
          }
        } catch {}
        // 上游干净断流却没发哨兵就补一个，避免下游报 ended-before-DONE 而整单作废
        // 下游已断开则直接收尾，不再补写
        if (!clientClosed) {
          if (!seenDone) res.write("data: [DONE]\n\n");
          try { res.end(); } catch {}
        }
        touchStats(label, !clientClosed);
        done(clientClosed ? "CLIENT_CLOSED" : 200, "direct-stream");
      } catch (e) {
        touchStats(label, false);
        done("ERR", "direct:"+String((e&&e.message)||e).slice(0,120));
        if (!res.headersSent) return sendJson(res, 502, { error: { message: String((e && e.message) || e).slice(0, 300), type: "upstream" } });
        // 流中段上游 RST/超时：同样补错误事件 + [DONE]，让下游拿到完整 SSE 而不是截流
        sseErrorAndDone(res, (e && e.message) || e);
        try { res.end(); } catch {}
      }
      return;
    }
    // 一 Key 一会话：显式 sid > 该 Key 绑定的 sid > 全局默认，互不串味
    const sid = String(body.sid || entry.sid || config.defaultSid || "");
    if (!sid) {
      touchStats(label, false);
      return sendJson(res, 400, { error: { message: "no session bound to this key: set sid for the key or pass sid per request" } });
    }
    const message = lastUserText(body.messages);
    const sinceMs = Date.now();
    const fail = (code, msg, type) => {
      touchStats(label, false);
      done(code, `desktop-${type}`);
      if (!res.headersSent) return sendJson(res, code, { error: { message: msg, type } });
      try { res.end(); } catch {}
    };
    // 流式先落头+心跳：上游 15s 首字节断头台清掉，后面慢慢等 Desktop
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      sseHeartbeat(model, res);
    }
    try {
      // 单会话一次只能跑一 turn：409 busy 就排队等到超时，而不是直接失败
      let t = null;
      const busyDeadline = Date.now() + config.timeoutMs;
      for (;;) {
        t = await desktopFetch(`/v1/sessions/${encodeURIComponent(sid)}/turns`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, model }),
        });
        if (t.status !== 409) break;
        if (Date.now() >= busyDeadline) break;
        await new Promise((r2) => setTimeout(r2, 2000));
      }
      if (t.status === 401) return fail(401, "desktop unauthorized, re-read desktop-api.json", "auth");
      if (t.status === 409) return fail(429, "desktop session busy, try again later", "rate_limit");
      if (!t.ok) {
        const txt = await t.text().catch(() => "");
        return fail(502, `desktop turns HTTP ${t.status} ${txt.slice(0, 200)}`, "upstream");
      }
      const { text: reply, usage } = await waitForReply(sid, sinceMs, stream ? () => sseHeartbeat(model, res) : undefined);
      touchStats(label, true, usage);
      if (!stream) {
        done(200, `desktop usage=${usage.total}`);
        return sendJson(res, 200, { id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.total } });
      }
      res.write(sseChunk(model, "", null));
      for (let i = 0; i < reply.length; i += 800) res.write(sseChunk(model, reply.slice(i, i + 800), null));
      res.write(sseChunk(model, "", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      done(200, "desktop-stream");
    } catch (e) {
      touchStats(label, false);
      done("ERR", "desktop:"+String((e&&e.message)||e).slice(0,120));
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
