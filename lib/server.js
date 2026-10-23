const http = require("http");
const fs = require("fs");
const path = require("path");
const { snapshot, logs } = require("./collect");
const { perform } = require("./actions");
const {
  ensureDir,
  readAuth,
  setupPassword,
  verifyPassword,
  appendAudit,
  readAudit,
} = require("./store");
const sec = require("./security");

const PUBLIC = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...sec.securityHeaders(),
    ...headers,
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function json(res, status, obj) {
  send(res, status, obj, { "Content-Type": "application/json; charset=utf-8" });
}

function readBody(req, limit = 16_000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > limit) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  if (![".html", ".css", ".js", ".svg", ".ico"].includes(path.extname(file)) && rel !== "/index.html") {
    send(res, 404, "not found", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, "not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  });
}

function requireMutate(req, res, claims) {
  const ip = sec.clientIp(req);
  if (!sec.rateLimit(`mut:${ip}`, 40, 60_000)) {
    json(res, 429, { error: "too many requests" });
    return false;
  }
  if (!sec.originOk(req)) {
    json(res, 403, { error: "origin rejected" });
    return false;
  }
  if (!sec.csrfOk(req, claims || null)) {
    json(res, 403, { error: "csrf rejected" });
    return false;
  }
  return true;
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  const ip = sec.clientIp(req);

  if (!sec.rateLimit(`all:${ip}`, 180, 60_000)) {
    json(res, 429, { error: "too many requests" });
    return;
  }

  if (req.method === "GET" && p === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && p === "/api/csrf") {
    const { claims } = sec.readSession(req);
    if (claims) {
      sec.setCsrfCookie(req, res, claims.csrf, sec.JWT_TTL);
      json(res, 200, { csrf: claims.csrf, origin: sec.originFor(req) });
      return;
    }
    const token = sec.setAnonCsrf(req, res);
    json(res, 200, { csrf: token, origin: sec.originFor(req) });
    return;
  }

  if (req.method === "POST" && p === "/api/setup") {
    if (!sec.isLoopback(req) || req.headers["x-forwarded-for"]) {
      json(res, 403, { error: "setup only on loopback" });
      return;
    }
    if (readAuth()) {
      json(res, 409, { error: "already set up" });
      return;
    }
    if (!requireMutate(req, res, null)) return;
    const body = parseJson(await readBody(req));
    if (!body) {
      json(res, 400, { error: "bad json" });
      return;
    }
    const password = String(body.password || "");
    if (password.length < 12) {
      json(res, 400, { error: "password must be at least 12 characters" });
      return;
    }
    setupPassword(password);
    const jwt = sec.signJwt({ sub: "operator" });
    sec.setAuthCookies(req, res, jwt);
    appendAudit({ actor: "operator", type: "setup", target: "auth", ok: true, ip });
    json(res, 200, { ok: true, user: "operator", csrf: jwt.claims.csrf });
    return;
  }

  if (req.method === "POST" && p === "/api/login") {
    if (!sec.rateLimit(`login:${ip}`, 8, 15 * 60_000)) {
      json(res, 429, { error: "too many login attempts" });
      return;
    }
    if (!sec.loginAllowed(ip)) {
      json(res, 429, { error: "locked, try later" });
      return;
    }
    if (!requireMutate(req, res, null)) return;
    const body = parseJson(await readBody(req));
    if (!body) {
      json(res, 400, { error: "bad json" });
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
    if (!verifyPassword(String(body.password || ""))) {
      sec.loginFail(ip);
      appendAudit({ actor: "anon", type: "login_fail", target: "session", ok: false, ip });
      json(res, 401, { error: "invalid password" });
      return;
    }
    sec.loginOk(ip);
    const jwt = sec.signJwt({ sub: "operator" });
    sec.setAuthCookies(req, res, jwt);
    appendAudit({ actor: "operator", type: "login", target: "session", ok: true, ip });
    json(res, 200, { ok: true, user: "operator", csrf: jwt.claims.csrf });
    return;
  }

  if (req.method === "POST" && p === "/api/logout") {
    const { claims } = sec.readSession(req);
    if (!requireMutate(req, res, claims || null)) return;
    if (claims?.jti) sec.revokeJwt(claims.jti);
    sec.clearAuthCookies(req, res);
    appendAudit({ actor: claims?.sub || "anon", type: "logout", target: "session", ok: true, ip });
    json(res, 200, { ok: true });
    return;
  }

  const { claims } = sec.readSession(req);
  if (!claims) {
    json(res, 401, { error: "auth required", needSetup: !readAuth() && sec.isLoopback(req) });
    return;
  }

  if (req.method === "GET" && p === "/api/me") {
    sec.setCsrfCookie(req, res, claims.csrf, sec.JWT_TTL);
    json(res, 200, { user: claims.sub, csrf: claims.csrf, needSetup: false });
    return;
  }

  if (req.method === "GET" && p === "/api/snapshot") {
    json(res, 200, await snapshot());
    return;
  }

  if (req.method === "GET" && p === "/api/logs") {
    const kind = url.searchParams.get("kind") || "pm2";
    const name = url.searchParams.get("name") || "";
    if (!["pm2", "journal"].includes(kind)) {
      json(res, 400, { error: "bad kind" });
      return;
    }
    if (name && !/^[A-Za-z0-9_.:@+-]+$/.test(name)) {
      json(res, 400, { error: "bad name" });
      return;
    }
    json(res, 200, await logs({ kind, name }));
    return;
  }

  if (req.method === "GET" && p === "/api/audit") {
    json(res, 200, { items: readAudit(100) });
    return;
  }

  if (req.method === "POST" && p === "/api/password") {
    if (!requireMutate(req, res, claims)) return;
    const body = parseJson(await readBody(req));
    if (!body) {
      json(res, 400, { error: "bad json" });
      return;
    }
    if (!verifyPassword(String(body.current || ""))) {
      json(res, 401, { error: "current password invalid" });
      return;
    }
    const next = String(body.next || "");
    if (next.length < 12) {
      json(res, 400, { error: "new password must be at least 12 characters" });
      return;
    }
    setupPassword(next);
    if (claims.jti) sec.revokeJwt(claims.jti);
    const jwt = sec.signJwt({ sub: claims.sub || "operator" });
    sec.setAuthCookies(req, res, jwt);
    appendAudit({ actor: claims.sub, type: "password_change", target: "auth", ok: true, ip });
    json(res, 200, { ok: true, csrf: jwt.claims.csrf });
    return;
  }

  if (req.method === "POST" && p === "/api/action") {
    if (!requireMutate(req, res, claims)) return;
    const body = parseJson(await readBody(req));
    if (!body) {
      json(res, 400, { error: "bad json" });
      return;
    }
    const result = await perform(body.type, body.target, claims.sub, ip);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  json(res, 404, { error: "not found" });
}

function createServer() {
  ensureDir();
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
        json(res, 405, { error: "method" });
        return;
      }
      if (req.url.startsWith("/api/")) {
        await handleApi(req, res);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(req, res);
        return;
      }
      json(res, 405, { error: "method" });
    } catch (e) {
      json(res, 500, { error: "error" });
    }
  });
}

module.exports = { createServer };
