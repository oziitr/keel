const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function which(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const extras = ["/usr/bin", "/usr/sbin", "/bin", "/sbin", "/snap/bin", "/opt/plesk/node/24/bin"];
  for (const dir of [...dirs, ...extras]) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* skip */
    }
  }
  return null;
}

function run(bin, args = [], { timeout = 8000, max = 800_000 } = {}) {
  return new Promise((resolve) => {
    const exe = path.isAbsolute(bin) ? bin : which(bin);
    if (!exe) {
      resolve({ code: 127, out: "", err: `not found: ${bin}` });
      return;
    }
    const child = spawn(exe, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > max) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > max) child.kill("SIGKILL");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

function clampText(s, n = 200_000) {
  const t = String(s || "");
  return t.length > n ? t.slice(t.length - n) : t;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = { which, run, clampText, num };
