"use strict";
// 直调换票：headless Chrome 跑官方 SSO，导出可用 Cookie，全程只落盘到本机。
// 对外只暴露 getCookieHeader() / refresh()，不打印任何密钥。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawn } = require("child_process");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  process.env.CHROME_BIN,
].filter(Boolean);

const PROFILE_DIR = path.join(__dirname, ".direct-profile");
const JAR_PATH = path.join(__dirname, ".direct-cookies.json");
const DEBUG_PORT = Number(process.env.DIRECT_DEBUG_PORT || 13377);
const ME_URL = "https://mimo-server-sgp.xiaomimimo.com/api/user/xiaomi/me";

function chromeBin() {
  const hit = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error("no chromium browser found (set CHROME_BIN)");
  return hit;
}

function readPartitionCookies(partitionDb) {
  const db = partitionDb || path.join(os.homedir(), "Library/Application Support/Xiaomi MiMo AI/Partitions/xiaomi-account/Cookies");
  const out = execSync(`sqlite3 ${JSON.stringify(db)} "SELECT name, value, host_key FROM cookies;"`, { encoding: "utf8" });
  const rows = [];
  for (const line of out.split("\n")) {
    const i = line.indexOf("|");
    const j = line.indexOf("|", i + 1);
    if (i > 0 && j > 0) rows.push({ name: line.slice(0, i), value: line.slice(i + 1, j), domain: line.slice(j + 1) });
  }
  return rows;
}

let msgId = 0;
function cdpCall(ws, pending, method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function withBrowser(fn) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const proc = spawn(chromeBin(), [
    "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${PROFILE_DIR}`, "about:blank",
  ], { stdio: "ignore" });
  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        if (targets && targets.length) break;
      } catch {}
    }
    if (!targets || !targets.length) throw new Error("chrome debugging port not ready");
    const page = targets.find((t) => t.type === "page") || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("cdp ws failed"));
    });
    const pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
    try {
      return await fn((method, params, t) => cdpCall(ws, pending, method, params, t));
    } finally {
      try { ws.close(); } catch {}
    }
  } finally {
    try { proc.kill(); } catch {}
  }
}

async function refresh(partitionDb) {
  const jar = await withBrowser(async (call) => {
    await call("Network.enable", {});
    for (const c of readPartitionCookies(partitionDb)) {
      try {
        await call("Network.setCookie", { name: c.name, value: c.value, domain: c.domain, path: "/" });
      } catch {}
    }
    await call("Page.enable", {});
    await call("Page.navigate", { url: ME_URL }, 20000);
    // 等 serviceToken 落到 xiaomimimo 域
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { cookies } = await call("Storage.getCookies", {});
      const hit = cookies.filter((c) => c.domain.includes("xiaomimimo.com") && /serviceToken/i.test(c.name));
      if (hit.length) return cookies;
    }
    throw new Error("sso ticket not issued (login may have expired, re-login in Desktop)");
  });
  const slim = jar.map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
  fs.writeFileSync(JAR_PATH, JSON.stringify({ at: Date.now(), cookies: slim }), { mode: 0o600 });
  try { fs.chmodSync(JAR_PATH, 0o600); } catch {}
  return slim;
}

function loadJar() {
  try {
    const d = JSON.parse(fs.readFileSync(JAR_PATH, "utf8"));
    if (Date.now() - d.at > 20 * 3600 * 1000) return null;
    return d.cookies;
  } catch {
    return null;
  }
}

let inflight = null;
async function getCookies(partitionDb, force) {
  if (!force) {
    const cached = loadJar();
    if (cached) return cached;
  }
  if (!inflight) inflight = refresh(partitionDb).finally(() => { inflight = null; });
  return inflight;
}

function headerFor(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

module.exports = { getCookies, refresh, headerFor };
