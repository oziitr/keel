const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR, ensureDir } = require("./store");

const SECRET_FILE = path.join(DATA_DIR, "jwt-secret");
const REVOKE_FILE = path.join(DATA_DIR, "jwt-revoke.json");
const JWT_TTL = Number(process.env.KEEL_JWT_TTL || 4 * 60 * 60);
const CSRF_TTL = 60 * 60;

function issuer() {
  return (process.env.KEEL_PUBLIC_ORIGIN || "keel").replace(/\/$/, "");
}

function originFor(req) {
  const env = process.env.KEEL_PUBLIC_ORIGIN;
  if (env) return env.replace(/\/$/, "");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:4310")
    .split(",")[0]
    .trim();
  const xf = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = process.env.KEEL_SECURE === "1" ? "https" : xf || "http";
  return `${proto}://${host}`;
}

const revoked = new Set();
const hits = new Map();
const fails = new Map();

function loadSecret() {
  ensureDir();
  try {
    const s = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (s.length >= 32) return s;
  } catch {
    /* create */
  }
  const s = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

let SECRET = loadSecret();

function loadRevoke() {
  try {
    const list = JSON.parse(fs.readFileSync(REVOKE_FILE, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    for (const row of list) {
      if (row.exp > now) revoked.add(row.jti);
    }
  } catch {
    /* none */
  }
}

loadRevoke();

function persistRevoke() {
  const now = Math.floor(Date.now() / 1000);
  const list = [...revoked].slice(-2000).map((jti) => ({ jti, exp: now + JWT_TTL }));
  fs.writeFileSync(REVOKE_FILE, JSON.stringify(list), { mode: 0o600 });
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function signJwt(payload, ttl = JWT_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    nbf: now,
    exp: now + ttl,
    iss: issuer(),
    aud: issuer(),
    jti: crypto.randomBytes(16).toString("hex"),
    csrf: crypto.randomBytes(24).toString("hex"),
  };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const mid = b64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${mid}`).digest("base64url");
  return { token: `${head}.${mid}.${sig}`, claims: body };
}

function verifyJwt(token) {
  if (!token || token.split(".").length !== 3) return null;
  const [head, mid, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SECRET).update(`${head}.${mid}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(mid, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now || (claims.nbf && claims.nbf > now)) return null;
  if (claims.iss !== issuer() || claims.aud !== issuer()) return null;
  if (revoked.has(claims.jti)) return null;
  return claims;
}

function revokeJwt(jti) {
  if (!jti) return;
  revoked.add(jti);
  persistRevoke();
}

function isSecureReq(req) {
  if (process.env.KEEL_SECURE === "1") return true;
  return forwardedProto(req) === "https";
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === ":ffff:127.0.0.1";
}

function forwardedProto(req) {
  if (isLoopback(req)) {
    return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  }
  return "http";
}

function clientIp(req) {
  if (isLoopback(req)) {
    const real = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    if (real) return real.slice(0, 64);
  }
  return (req.socket?.remoteAddress || "unknown").slice(0, 64);
}

function cookieNames(req) {
  const secure = isSecureReq(req);
  return {
    jwt: secure ? "__Host-keel" : "keel",
    csrf: secure ? "__Host-keel-csrf" : "keel_csrf",
    secure,
  };
}

function cookiePair(name, value, { httpOnly, maxAge, secure, extra = [] }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  parts.push(...extra);
  return parts.join("; ");
}

function setAuthCookies(req, res, jwt) {
  const names = cookieNames(req);
  const cookies = [
    cookiePair(names.jwt, jwt.token, {
      httpOnly: true,
      maxAge: JWT_TTL,
      secure: names.secure,
    }),
    cookiePair(names.csrf, jwt.claims.csrf, {
      httpOnly: false,
      maxAge: JWT_TTL,
      secure: names.secure,
    }),
  ];
  res.setHeader("Set-Cookie", cookies);
}

function clearAuthCookies(req, res) {
  const names = cookieNames(req);
  const cookies = [
    cookiePair(names.jwt, "", { httpOnly: true, maxAge: 0, secure: names.secure }),
    cookiePair(names.csrf, "", { httpOnly: false, maxAge: 0, secure: names.secure }),
  ];
  res.setHeader("Set-Cookie", cookies);
}

function setCsrfCookie(req, res, token, maxAge = CSRF_TTL) {
  const names = cookieNames(req);
  res.setHeader(
    "Set-Cookie",
    cookiePair(names.csrf, token, {
      httpOnly: false,
      maxAge,
      secure: names.secure,
    }),
  );
}

function setAnonCsrf(req, res) {
  const token = crypto.randomBytes(24).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + CSRF_TTL;
  const sig = crypto.createHmac("sha256", SECRET).update(`${token}.${exp}`).digest("hex");
  const packed = `${token}.${exp}.${sig}`;
  setCsrfCookie(req, res, packed, CSRF_TTL);
  return packed;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readSession(req) {
  const names = cookieNames(req);
  const cookies = parseCookies(req.headers.cookie);
  const claims = verifyJwt(cookies[names.jwt]);
  return { cookies, names, claims };
}

function csrfOk(req, claims) {
  const names = cookieNames(req);
  const cookies = parseCookies(req.headers.cookie);
  const header = String(req.headers["x-csrf-token"] || "");
  const cookieTok = cookies[names.csrf] || "";
  if (!header || !cookieTok) return false;
  if (header !== cookieTok) return false;
  if (claims) return header === claims.csrf;
  const parts = cookieTok.split(".");
  if (parts.length !== 3) return false;
  const [token, exp, sig] = parts;
  const expect = crypto.createHmac("sha256", SECRET).update(`${token}.${exp}`).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  } catch {
    return false;
  }
  return Number(exp) > Math.floor(Date.now() / 1000);
}

function originOk(req) {
  if (isLoopback(req) && !req.headers["x-forwarded-host"] && !req.headers["x-forwarded-proto"]) {
    return true;
  }
  const expected = originFor(req);
  const origin = String(req.headers.origin || "");
  if (origin) return origin === expected;
  const referer = String(req.headers.referer || "");
  return referer === expected || referer.startsWith(`${expected}/`);
}

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const rec = hits.get(key) || { n: 0, start: now };
  if (now - rec.start > windowMs) {
    rec.n = 0;
    rec.start = now;
  }
  rec.n += 1;
  hits.set(key, rec);
  return rec.n <= limit;
}

function loginAllowed(ip) {
  const rec = fails.get(ip);
  if (!rec) return true;
  if (Date.now() - rec.at > 15 * 60 * 1000) {
    fails.delete(ip);
    return true;
  }
  return rec.n < 8;
}

function loginFail(ip) {
  const rec = fails.get(ip) || { n: 0, at: Date.now() };
  rec.n += 1;
  rec.at = Date.now();
  fails.set(ip, rec);
}

function loginOk(ip) {
  fails.delete(ip);
}

function securityHeaders() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
  if (process.env.KEEL_SECURE === "1") {
    headers["Content-Security-Policy"] += "; upgrade-insecure-requests";
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

module.exports = {
  originFor,
  JWT_TTL,
  signJwt,
  verifyJwt,
  revokeJwt,
  setAuthCookies,
  clearAuthCookies,
  setAnonCsrf,
  setCsrfCookie,
  readSession,
  csrfOk,
  originOk,
  clientIp,
  isLoopback,
  rateLimit,
  loginAllowed,
  loginFail,
  loginOk,
  securityHeaders,
};
