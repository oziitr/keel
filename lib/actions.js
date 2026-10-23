const { run, which } = require("./util");
const { appendAudit } = require("./store");

const ALLOWED = new Set([
  "pm2_restart",
  "pm2_stop",
  "pm2_start",
  "proc_term",
  "tmux_kill",
]);

function safeName(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 80) return null;
  if (!/^[A-Za-z0-9_.:@+-]+$/.test(s)) return null;
  return s;
}

async function perform(type, target, actor, ip) {
  if (!ALLOWED.has(type)) {
    return { ok: false, error: "action not allowed" };
  }
  const name = safeName(target);
  if (!name && type !== "proc_term") {
    return { ok: false, error: "invalid target" };
  }

  let result;
  if (type.startsWith("pm2_")) {
    const bin = which("pm2");
    if (!bin) return { ok: false, error: "pm2 missing" };
    const cmd = type.slice(4);
    result = await run(bin, [cmd, name]);
  } else if (type === "proc_term") {
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: "bad pid" };
    try {
      process.kill(pid, "SIGTERM");
      result = { code: 0, out: `SIGTERM ${pid}`, err: "" };
    } catch (e) {
      result = { code: 1, out: "", err: e.message };
    }
  } else if (type === "tmux_kill") {
    const bin = which("tmux");
    if (!bin) return { ok: false, error: "tmux missing" };
    result = await run(bin, ["kill-session", "-t", name]);
  }

  const ok = result && result.code === 0;
  appendAudit({
    actor,
    type,
    target: String(target),
    ok,
    ip: ip || null,
    detail: (result?.err || result?.out || "").slice(0, 400),
  });
  return {
    ok,
    error: ok ? null : (result?.err || "failed").slice(0, 400),
    out: (result?.out || "").slice(0, 400),
  };
}

module.exports = { perform, ALLOWED };
