const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.KEEL_DATA || path.join(__dirname, "..", "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");
const PROJECTS_FILE = path.join(DATA_DIR, "projects-seen.json");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password || "").trim(), salt, 32).toString("hex");
}

function setupPassword(password) {
  ensureDir();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(String(password || "").trim(), salt);
  const rec = { salt, hash, createdAt: new Date().toISOString() };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

function verifyPassword(password) {
  const rec = readAuth();
  if (!rec) return false;
  const hash = hashPassword(String(password || "").trim(), rec.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(rec.hash, "hex"));
  } catch {
    return false;
  }
}

function appendAudit(entry) {
  ensureDir();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
}

function readProjectIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeProjectIndex(map) {
  ensureDir();
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}

function readAudit(limit = 80) {
  try {
    const raw = fs.readFileSync(AUDIT_FILE, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split("\n");
    return lines.slice(-limit).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}

module.exports = {
  DATA_DIR,
  ensureDir,
  readAuth,
  setupPassword,
  verifyPassword,
  appendAudit,
  readAudit,
  readProjectIndex,
  writeProjectIndex,
};
