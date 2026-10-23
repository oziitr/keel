const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, which, num } = require("./util");
const { readProjectIndex, writeProjectIndex } = require("./store");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".npm",
  ".pm2",
  "dist",
  "build",
  "vendor",
  "snap",
  "proc",
  "sys",
  "dev",
  ".next",
  "lost+found",
  "mail",
  "logs",
  "tmp",
  "temp",
  "cache",
]);

const SKIP_VHOST = new Set(["system", "chroot", "fs", "default", ".skel"]);

let cache = { at: 0, data: null };
const TTL = 4000;
const history = [];
const HISTORY_MAX = 48;

function readLoad() {
  try {
    const [one, five, fifteen] = fs.readFileSync("/proc/loadavg", "utf8").split(" ");
    return { one: num(one), five: num(five), fifteen: num(fifteen) };
  } catch {
    const a = os.loadavg();
    return { one: a[0], five: a[1], fifteen: a[2] };
  }
}

function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    free,
    used: total - free,
    pct: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
  };
}

function cpuModel() {
  const c = os.cpus() || [];
  return {
    count: c.length,
    model: c[0]?.model?.replace(/\s+/g, " ").trim() || "cpu",
  };
}

async function disks() {
  const { out } = await run("df", ["-B1", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"]);
  const rows = [];
  for (const line of out.split("\n").slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    const size = num(p[1]);
    const used = num(p[2]);
    rows.push({
      fs: p[0],
      size,
      used,
      avail: num(p[3]),
      pct: size ? Math.round((used / size) * 1000) / 10 : 0,
      mount: p[5],
    });
  }
  return rows.filter((r) => r.mount === "/" || r.size > 1_000_000_000).slice(0, 8);
}

function netDev() {
  try {
    const lines = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const parts = line.trim().split(/[:\s]+/);
      if (parts.length < 10) continue;
      const iface = parts[0];
      if (!iface || iface === "lo") continue;
      rx += num(parts[1]);
      tx += num(parts[9]);
    }
    return { rx, tx };
  } catch {
    return { rx: 0, tx: 0 };
  }
}

async function processes() {
  const { out } = await run("ps", [
    "-eo",
    "pid,user,pcpu,pmem,etime,stat,comm",
    "--sort=-pcpu",
  ]);
  const rows = [];
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: num(m[1]),
      user: m[2],
      cpu: num(m[3]),
      mem: num(m[4]),
      elapsed: m[5],
      stat: m[6],
      comm: m[7].trim(),
    });
    if (rows.length >= 60) break;
  }
  return rows;
}

async function pm2List() {
  const bin = which("pm2");
  if (!bin) return { available: false, apps: [], notice: null };
  const { out, code } = await run(bin, ["jlist"]);
  if (code !== 0) return { available: true, apps: [], error: "pm2 jlist failed", notice: null };
  let parsed = [];
  try {
    const start = out.search(/[\[{]/);
    parsed = JSON.parse(start >= 0 ? out.slice(start) : "[]");
  } catch {
    return { available: true, apps: [], error: "pm2 json parse failed", notice: null };
  }
  const apps = parsed.map((p) => ({
    id: p.pm_id,
    name: p.name,
    status: p.pm2_env?.status,
    pid: p.pid,
    cpu: p.monit?.cpu,
    memory: p.monit?.memory,
    restarts: p.pm2_env?.restart_time,
    uptime: p.pm2_env?.pm_uptime,
    mode: p.pm2_env?.exec_mode,
    cwd: p.pm2_env?.pm_cwd,
    script: p.pm2_env?.pm_exec_path,
    unstable: p.pm2_env?.unstable_restarts,
    outLog: p.pm2_env?.pm_out_log_path || "",
    errLog: p.pm2_env?.pm_err_log_path || "",
    interpreter: p.pm2_env?.exec_interpreter || "",
    instances: p.pm2_env?.instances || 1,
  }));
  return { available: true, apps, notice: null };
}

async function tmuxSessions() {
  const bin = which("tmux");
  if (!bin) return { available: false, sessions: [] };
  const { out, code } = await run(bin, [
    "list-sessions",
    "-F",
    "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}",
  ]);
  if (code !== 0) return { available: true, sessions: [] };
  const sessions = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, windows, created, attached] = line.split("|");
      return {
        name,
        windows: num(windows),
        created: num(created) * 1000,
        attached: attached === "1",
      };
    });
  return { available: true, sessions };
}

async function services() {
  const { out, code } = await run("systemctl", [
    "list-units",
    "--type=service",
    "--state=running",
    "--no-pager",
    "--no-legend",
    "--plain",
  ]);
  if (code !== 0) return [];
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 80)
    .map((line) => {
      const p = line.trim().split(/\s+/);
      return { unit: p[0], load: p[1], active: p[2], sub: p[3], desc: p.slice(4).join(" ") };
    });
}

function parseBind(local) {
  if (!local) return { bind: "", port: null };
  if (local.startsWith("[")) {
    const m = local.match(/^\[(.+)\]:(\d+)$/);
    if (m) return { bind: m[1], port: num(m[2]) };
  }
  const idx = local.lastIndexOf(":");
  if (idx < 0) return { bind: local, port: null };
  return { bind: local.slice(0, idx), port: num(local.slice(idx + 1), null) };
}

function parseSsUsers(extra) {
  const procs = [];
  const re = /\("([^"]+)",pid=(\d+)/g;
  let m;
  while ((m = re.exec(extra || ""))) {
    procs.push({ name: m[1], pid: num(m[2]) });
  }
  return procs;
}

async function listening() {
  let { out } = await run("ss", ["-tulpnH"]);
  if (!out.trim()) {
    const retry = await run("ss", ["-tulpn"]);
    out = retry.out.split("\n").slice(1).join("\n");
  }
  const grouped = new Map();
  for (const line of out.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const proto = p[0].replace("u_str", "unix");
    const state = p[1];
    const local = p[4];
    const extra = p.slice(6).join(" ");
    const { bind, port } = parseBind(local);
    const procs = parseSsUsers(extra);
    const proc = procs[0] || { name: extra ? "other" : "kernel", pid: null };
    const key = `${proto}|${bind}|${port}|${proc.name}|${state}`;
    const prev = grouped.get(key);
    if (prev) {
      prev.fds += 1;
      continue;
    }
    grouped.set(key, {
      proto,
      state,
      bind,
      port,
      process: proc.name,
      pid: proc.pid,
      fds: 1,
    });
  }
  return [...grouped.values()].sort((a, b) => (a.port || 0) - (b.port || 0) || a.process.localeCompare(b.process));
}

function parseWhoLine(line) {
  const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)?\s*(.*)$/);
  if (!m) return null;
  const rest = (m[4] || "").trim();
  const ip = (rest.match(/\(([^)]+)\)/) || [])[1] || "";
  return { user: m[1], tty: m[2], from: ip || m[3] || "", detail: rest || m[3] || "" };
}

function parseLastLine(line) {
  const t = line.trim();
  if (!t || t.startsWith("wtmp") || t.startsWith("btmp")) return null;
  const parts = t.split(/\s+/);
  if (parts.length < 4) return null;
  const still = /still logged in/i.test(t);
  const gone = t.match(/-\s+(\S.+?)(?:\s+\()/) || t.match(/gone - no logout/i);
  return {
    user: parts[0],
    tty: parts[1],
    from: parts[2] && !/^\d{4}-/.test(parts[2]) && parts[2] !== "system" ? parts[2] : "",
    when: t.replace(parts[0], "").trim(),
    active: still,
    ended: Boolean(gone),
  };
}

async function users() {
  const [whoRes, lastRes] = await Promise.all([run("who"), run("last", ["-n", "20", "--time-format", "iso"])]);
  const now = whoRes.out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parseWhoLine)
    .filter(Boolean);
  const last = lastRes.out
    .trim()
    .split("\n")
    .map(parseLastLine)
    .filter(Boolean)
    .slice(0, 16);
  return { now, last };
}

function parseCronLine(line) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  if (t.startsWith("@")) {
    const sp = t.indexOf(" ");
    return { schedule: t.slice(0, sp), command: t.slice(sp + 1) };
  }
  const parts = t.split(/\s+/);
  if (parts.length < 6) return { schedule: t, command: "" };
  return { schedule: parts.slice(0, 5).join(" "), command: parts.slice(5).join(" ") };
}

async function cron() {
  const { out } = await run("crontab", ["-l"]);
  return out
    .split("\n")
    .map(parseCronLine)
    .filter(Boolean)
    .slice(0, 40);
}

function inspectRepo(dir) {
  let remote = "";
  let branch = "";
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    const m = cfg.match(/url\s*=\s*(.+)/);
    remote = m ? m[1].trim() : "";
  } catch {
    remote = "";
  }
  try {
    const headRef = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    branch = headRef.replace("ref: refs/heads/", "");
    if (branch.startsWith("ref:")) branch = branch.slice(5);
  } catch {
    branch = "";
  }
  let name = path.basename(dir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.name) name = pkg.name;
  } catch {
    /* keep basename */
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(dir).mtimeMs;
  } catch {
    mtime = 0;
  }
  return { path: dir, name, branch, remote, mtime };
}

function detectKind(dir) {
  try {
    if (fs.existsSync(path.join(dir, ".git"))) return "git";
    if (fs.existsSync(path.join(dir, "docker-compose.yml")) || fs.existsSync(path.join(dir, "compose.yml"))) return "compose";
    if (fs.existsSync(path.join(dir, "package.json"))) return "node";
    if (fs.existsSync(path.join(dir, "go.mod"))) return "go";
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) return "rust";
    if (fs.existsSync(path.join(dir, "pyproject.toml")) || fs.existsSync(path.join(dir, "requirements.txt"))) return "python";
    if (fs.existsSync(path.join(dir, "composer.json"))) return "php";
    if (fs.existsSync(path.join(dir, "Gemfile"))) return "ruby";
  } catch {
    /* ignore */
  }
  return "dir";
}

function listWorkspaceDir(dir) {
  const kind = detectKind(dir);
  const base = inspectRepo(dir);
  return { ...base, kind };
}

function walkGit(root, depth, acc) {
  if (depth > 5 || acc.length >= 120) return;
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (ents.some((e) => e.isDirectory() && e.name === ".git")) {
    acc.push({ ...inspectRepo(root), kind: "git" });
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    walkGit(path.join(root, e.name), depth + 1, acc);
  }
}

function scanTopChildren(top, acc, seen) {
  let ents = [];
  try {
    ents = fs.readdirSync(top, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(top, e.name);
    if (seen.has(full)) continue;
    acc.push(listWorkspaceDir(full));
    seen.add(full);
  }
}

function scanVhosts(acc, seen) {
  const root = "/var/www/vhosts";
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (!e.isDirectory() || SKIP_VHOST.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(root, e.name);
    if (seen.has(full)) continue;
    const httpdocs = path.join(full, "httpdocs");
    const target = fs.existsSync(httpdocs) ? httpdocs : full;
    const item = listWorkspaceDir(target);
    item.name = e.name;
    item.kind = item.kind === "dir" ? "vhost" : item.kind;
    acc.push(item);
    seen.add(full);
    seen.add(target);
  }
}

function scanRoots() {
  const env = process.env.KEEL_SCAN_ROOTS;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return ["/root", "/home", "/var/www", "/opt", "/srv"];
}

function projects(pm2Apps = []) {
  const acc = [];
  const seen = new Set();
  const roots = scanRoots();
  for (const r of roots) {
    if (fs.existsSync(r)) walkGit(r, 0, acc);
  }
  for (const p of acc) seen.add(p.path);

  const tops = roots.filter((r) => r !== "/home");
  if (roots.includes("/home") || roots.some((r) => r.startsWith("/home/"))) {
    try {
      for (const e of fs.readdirSync("/home", { withFileTypes: true })) {
        if (e.isDirectory()) tops.push(path.join("/home", e.name));
      }
    } catch {
      /* no /home */
    }
  }
  for (const top of tops) scanTopChildren(top, acc, seen);
  if (process.env.KEEL_SCAN_VHOSTS !== "0") scanVhosts(acc, seen);

  for (const app of pm2Apps) {
    const cwd = app.cwd;
    if (!cwd) continue;
    const hit = acc.find((p) => p.path === cwd || cwd.startsWith(p.path + path.sep));
    if (hit) {
      hit.pm2 = hit.pm2 ? `${hit.pm2}, ${app.name}` : app.name;
      continue;
    }
    if (seen.has(cwd)) continue;
    const item = listWorkspaceDir(cwd);
    item.pm2 = app.name;
    if (item.kind === "dir") item.kind = "pm2";
    acc.push(item);
    seen.add(cwd);
  }

  const now = Date.now();
  const index = readProjectIndex();
  const bootstrap = !Object.keys(index).length;
  const NEW_MS = 48 * 3600 * 1000;
  for (const p of acc) {
    const prev = index[p.path];
    if (!prev) {
      index[p.path] = { firstSeen: now, lastSeen: now, name: p.name, kind: p.kind };
      p.firstSeen = now;
      p.new = !bootstrap;
    } else {
      prev.lastSeen = now;
      prev.name = p.name;
      prev.kind = p.kind;
      p.firstSeen = prev.firstSeen;
      p.new = now - prev.firstSeen < NEW_MS;
    }
  }
  for (const [k, v] of Object.entries(index)) {
    if (now - (v.lastSeen || 0) > 14 * 86400_000) delete index[k];
  }
  try {
    writeProjectIndex(index);
  } catch {
    /* ignore persist errors */
  }

  acc.sort((a, b) => Number(b.new) - Number(a.new) || b.mtime - a.mtime);
  return acc;
}

async function containers() {
  const docker = which("docker");
  const lxc = which("lxc");
  const result = { docker: [], lxc: [] };
  if (docker) {
    const { out } = await run(docker, [
      "ps",
      "-a",
      "--format",
      "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}",
    ]);
    result.docker = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 40)
      .map((l) => {
        const [name, status, image, ports] = l.split("\t");
        return { name, status, image, ports };
      });
  }
  if (lxc) {
    const { out } = await run(lxc, ["list", "--format", "csv", "-c", "n,s,ipv4"]);
    result.lxc = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 40)
      .map((l) => {
        const [name, status, ipv4] = l.split(",");
        return { name, status, ipv4 };
      });
  }
  return result;
}

function host() {
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    node: process.version,
    user: os.userInfo().username,
    time: Date.now(),
    load: readLoad(),
    cpu: cpuModel(),
    mem: memInfo(),
    net: netDev(),
  };
}

function pushHistory(h, diskRows) {
  const root = (diskRows || []).find((d) => d.mount === "/") || diskRows?.[0];
  history.push({
    t: h.time,
    load: h.load.one,
    mem: h.mem.pct,
    disk: root?.pct || 0,
  });
  while (history.length > HISTORY_MAX) history.shift();
}

function alertsFrom(data) {
  const items = [];
  for (const a of data.pm2.apps || []) {
    if (a.status && a.status !== "online") {
      items.push({ level: "error", title: `${a.name} is ${a.status}`, detail: `${a.restarts || 0} restarts` });
    } else if ((a.unstable || 0) > 0) {
      items.push({ level: "warn", title: `${a.name} unstable`, detail: `${a.unstable} unstable restarts` });
    }
  }
  for (const d of data.disks || []) {
    if (d.pct >= 90) items.push({ level: "error", title: `Disk ${d.mount} ${d.pct}%`, detail: d.fs });
    else if (d.pct >= 80) items.push({ level: "warn", title: `Disk ${d.mount} ${d.pct}%`, detail: d.fs });
  }
  const fresh = (data.projects || []).filter((p) => p.new);
  if (fresh.length) {
    items.push({
      level: "info",
      title: `${fresh.length} new project${fresh.length === 1 ? "" : "s"}`,
      detail: fresh.slice(0, 4).map((p) => p.name).join(", "),
    });
  }
  return items;
}

async function snapshot() {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL) return cache.data;
  const [diskRows, procs, pm2, tmux, units, ports, people, cronRows, boxes] = await Promise.all([
    disks(),
    processes(),
    pm2List(),
    tmuxSessions(),
    services(),
    listening(),
    users(),
    cron(),
    containers(),
  ]);
  const h = host();
  pushHistory(h, diskRows);
  const proj = projects(pm2.apps || []);
  const data = {
    host: h,
    disks: diskRows,
    processes: procs,
    pm2,
    tmux,
    services: units,
    listening: ports,
    users: people,
    cron: cronRows,
    containers: boxes,
    projects: proj,
    history: history.slice(),
    alerts: [],
    tools: {
      pm2: Boolean(which("pm2")),
      tmux: Boolean(which("tmux")),
      docker: Boolean(which("docker")),
      lxc: Boolean(which("lxc")),
      systemctl: Boolean(which("systemctl")),
    },
  };
  data.alerts = alertsFrom(data);
  cache = { at: now, data };
  return data;
}

function classifyLevel(text) {
  const s = String(text || "").toLowerCase();
  if (/\b(fatal|panic|emerg|alert|crit|error|err|exception|failed|failure)\b/.test(s)) return "error";
  if (/\b(warn|warning|deprecated|unstable)\b/.test(s)) return "warn";
  if (/\b(debug|trace)\b/.test(s)) return "debug";
  if (/\b(info|online|started|listening)\b/.test(s)) return "info";
  return "info";
}

function parseStamp(line) {
  const iso = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) {
    const ms = Date.parse(iso[1].replace(" ", "T"));
    return { ts: Number.isFinite(ms) ? ms : null, iso: iso[1], rest: line.slice(iso[0].length).replace(/^[:\s]+/, "") };
  }
  const syslog = line.match(/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/);
  if (syslog) return { ts: null, iso: syslog[0], rest: line.slice(syslog[0].length).trim() };
  return { ts: null, iso: "", rest: line };
}

function tailFile(file, maxBytes = 96_000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function entriesFromText(text, source, stream) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith(">>>>") && !l.includes("[TAILING] Tailing last"));
  const rows = [];
  for (const line of lines) {
    const { ts, iso, rest } = parseStamp(line.replace(/^\/.+:\s*/, ""));
    const message = rest || line;
    rows.push({
      ts,
      iso: iso || "",
      level: stream === "err" ? "error" : classifyLevel(message),
      source,
      stream,
      message: message.slice(0, 2000),
    });
  }
  return rows;
}

function journalPriority(n) {
  const p = Number(n);
  if (p <= 3) return "error";
  if (p === 4) return "warn";
  if (p >= 7) return "debug";
  return "info";
}

async function logs({ kind, name }) {
  const entries = [];
  if (kind === "pm2") {
    const list = await pm2List();
    const apps = (list.apps || []).filter((a) => !name || a.name === name);
    for (const a of apps) {
      if (a.outLog) entries.push(...entriesFromText(tailFile(a.outLog), a.name, "out"));
      if (a.errLog) entries.push(...entriesFromText(tailFile(a.errLog), a.name, "err"));
    }
  } else if (kind === "journal") {
    const args = ["-n", "120", "--no-pager", "-o", "json"];
    if (name) args.push("-u", String(name));
    const { out, err } = await run("journalctl", args, { timeout: 8000 });
    const blob = out || err || "";
    for (const line of blob.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const ts = j.__REALTIME_TIMESTAMP ? Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000) : null;
        const message = String(j.MESSAGE || "").slice(0, 2000);
        entries.push({
          ts,
          iso: ts ? new Date(ts).toISOString() : "",
          level: journalPriority(j.PRIORITY),
          source: j.SYSLOG_IDENTIFIER || j._SYSTEMD_UNIT || name || "journal",
          stream: "journal",
          message,
        });
      } catch {
        const { ts, iso, rest } = parseStamp(line);
        entries.push({
          ts,
          iso,
          level: classifyLevel(rest || line),
          source: name || "journal",
          stream: "journal",
          message: (rest || line).slice(0, 2000),
        });
      }
    }
  }
  entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { entries: entries.slice(-200), kind, name: name || "" };
}

module.exports = { snapshot, logs, host };
