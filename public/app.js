const STATIONS = [
  ["overview", "Overview"],
  ["pm2", "PM2"],
  ["tmux", "tmux"],
  ["processes", "Processes"],
  ["services", "Services"],
  ["network", "Network"],
  ["projects", "Projects"],
  ["logs", "Logs"],
  ["users", "People"],
  ["audit", "Audit"],
];

const state = {
  snap: null,
  audit: [],
  logs: [],
  logKind: "pm2",
  logName: "",
  logLevel: "all",
  filter: "",
  csrf: "",
};

function readCookie(name) {
  const hit = document.cookie.split("; ").find((p) => p.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.split("=").slice(1).join("=")) : "";
}

function csrfToken() {
  return state.csrf || readCookie("__Host-keel-csrf") || readCookie("keel_csrf");
}

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 10 ? 0 : 1)} ${u[i]}`;
}

function fmtUptime(s) {
  const sec = Math.floor(Number(s) || 0);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

function fmtWhen(ts, iso) {
  if (iso) return iso.replace("T", " ").replace("Z", " UTC").slice(0, 22);
  if (ts) return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
  return "—";
}

function statusClass(s) {
  const v = String(s || "").toLowerCase();
  if (["online", "running", "active", "ok"].includes(v)) return "ok";
  if (["stopped", "errored", "failed", "error"].includes(v) || v.includes("wait")) return "bad";
  return "warn";
}

function route() {
  return (location.hash.replace("#", "") || "overview").split("?")[0];
}

function nav() {
  $("nav").innerHTML = STATIONS.map(([id, label]) => {
    return `<a href="#${id}" class="${route() === id ? "on" : ""}">${label}</a>`;
  }).join("");
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if ((opts.method || "GET") !== "GET") headers["X-CSRF-Token"] = csrfToken();
  const res = await fetch(path, { credentials: "same-origin", ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (data.csrf) state.csrf = data.csrf;
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

function closeSheet() {
  $("sheet").classList.add("hidden");
  $("sheet-foot").innerHTML = "";
}

function openSheet(title, bodyHtml, footHtml = "") {
  $("sheet-title").textContent = title;
  $("sheet-body").innerHTML = bodyHtml;
  $("sheet-foot").innerHTML = footHtml;
  $("sheet").classList.remove("hidden");
}

function ring(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const c = 2 * Math.PI * 26;
  const hot = p >= 87 ? " hot" : "";
  return `<svg class="ring" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
    <circle class="track" cx="32" cy="32" r="26"/>
    <circle class="fill${hot}" cx="32" cy="32" r="26" stroke-dasharray="${c}" stroke-dashoffset="${c - (p / 100) * c}"/>
  </svg>`;
}

function gauge(label, value, sub, pct) {
  return `<div class="gauge">${ring(pct)}<div><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b><span>${escapeHtml(sub)}</span></div></div>`;
}

function spark(points, key) {
  const vals = (points || []).map((p) => Number(p[key]) || 0);
  if (vals.length < 2) return `<div class="empty">Collecting samples…</div>`;
  const max = Math.max(...vals, 1);
  const w = 640;
  const h = 72;
  const d = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * (w - 8) + 4;
      const y = h - 6 - (v / max) * (h - 14);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${key} history">
    <path d="${d}" fill="none" stroke="#3aa8a0" stroke-width="2"/>
  </svg>`;
}

function empty(msg) {
  return `<p class="empty">${escapeHtml(msg)}</p>`;
}

function table(headers, rows, { rowAttr = () => "" } = {}) {
  if (!rows.length) return empty("Nothing to show.");
  return `<div class="block" style="padding:0;overflow:auto">
    <table class="ledger"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr ${rowAttr(r.data)}>${r.html}</tr>`).join("")}</tbody></table>
  </div>`;
}

function matchFilter(obj) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return JSON.stringify(obj).toLowerCase().includes(q);
}

function searchBar(placeholder) {
  return `<div class="toolbar">
    <input class="search" id="q" type="search" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(state.filter)}" />
  </div>`;
}

function kv(pairs) {
  return `<dl class="kv">${pairs
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v ?? "—"))}</dd>`)
    .join("")}</dl>`;
}

function bar(pct) {
  const hot = pct >= 87 ? " hot" : "";
  return `<div class="bar${hot}"><i style="width:${Math.min(100, pct || 0)}%"></i></div>`;
}

function overview(s) {
  const h = s.host;
  const root = (s.disks || []).find((d) => d.mount === "/") || s.disks?.[0] || { pct: 0, used: 0, size: 1 };
  $("headline").textContent = h.hostname;
  $("subhead").textContent = `${h.platform} · ${h.cpu.count} threads · up ${fmtUptime(h.uptime)}`;
  const pm2n = s.pm2.apps?.filter((a) => a.status === "online").length || 0;
  const alerts = (s.alerts || [])
    .map(
      (a) => `<div class="alert"><span class="chip ${a.level === "error" ? "bad" : a.level === "warn" ? "warn" : "info"}">${a.level}</span>
        <div><b>${escapeHtml(a.title)}</b><span>${escapeHtml(a.detail || "")}</span></div></div>`,
    )
    .join("");
  return `
    <div class="gauges">
      ${gauge("Load", h.load.one.toFixed(2), `${h.load.five.toFixed(2)} / ${h.load.fifteen.toFixed(2)}`, (h.load.one / Math.max(1, h.cpu.count)) * 100)}
      ${gauge("Memory", `${h.mem.pct}%`, `${fmtBytes(h.mem.used)} of ${fmtBytes(h.mem.total)}`, h.mem.pct)}
      ${gauge("Disk /", `${root.pct}%`, `${fmtBytes(root.used)} of ${fmtBytes(root.size)}`, root.pct)}
      ${gauge("PM2 online", String(pm2n), `${s.pm2.apps?.length || 0} processes`, s.pm2.apps?.length ? (pm2n / s.pm2.apps.length) * 100 : 0)}
    </div>
    ${alerts ? `<div class="alert-list">${alerts}</div>` : ""}
    <div class="grid-2">
      <div class="block">
        <h2>Load history</h2>
        ${spark(s.history, "load")}
      </div>
      <div class="block">
        <h2>Memory history</h2>
        ${spark(s.history, "mem")}
      </div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="block">
        <h2>Mounts</h2>
        ${table(
          ["Mount", "Used", "Free", "Fill"],
          (s.disks || []).map((d) => ({
            data: d,
            html: `<td>${escapeHtml(d.mount)}</td><td>${fmtBytes(d.used)} / ${fmtBytes(d.size)}</td><td>${fmtBytes(d.avail)}</td><td>${d.pct}% ${bar(d.pct)}</td>`,
          })),
        )}
      </div>
      <div class="block">
        <h2>New projects</h2>
        ${table(
          ["Name", "Kind", "Path"],
          (s.projects || [])
            .filter((p) => p.new)
            .map((p) => ({
              data: p,
              html: `<td>${escapeHtml(p.name)}</td><td><span class="chip info">${escapeHtml(p.kind)}</span></td><td>${escapeHtml(p.path)}</td>`,
            })),
        )}
      </div>
    </div>
  `;
}

function pm2View(s) {
  $("headline").textContent = "PM2";
  $("subhead").textContent = s.pm2.available ? "Process manager on this host." : "pm2 is not on PATH.";
  const rows = (s.pm2.apps || []).filter(matchFilter).map((a) => ({
    data: a,
    html: `<td>${escapeHtml(a.name)}</td>
      <td><span class="chip ${statusClass(a.status)}">${escapeHtml(a.status || "—")}</span></td>
      <td>${a.pid || "—"}</td>
      <td>${a.cpu ?? "—"}%</td>
      <td>${fmtBytes(a.memory || 0)}</td>
      <td>${a.restarts ?? 0}</td>
      <td class="row-act">
        <button data-act="pm2_restart" data-target="${escapeHtml(a.name)}">Restart</button>
        <button class="ghost-act" data-act="pm2_stop" data-target="${escapeHtml(a.name)}">Stop</button>
      </td>`,
  }));
  return `${searchBar("Filter by name, status, cwd")}
    ${table(["Name", "Status", "PID", "CPU", "Mem", "Restarts", ""], rows, {
      rowAttr: (a) => `data-open="pm2" data-name="${escapeHtml(a.name)}"`,
    })}`;
}

function tmuxView(s) {
  $("headline").textContent = "tmux";
  $("subhead").textContent = s.tmux.available ? "Terminal sessions." : "tmux is not installed.";
  const rows = (s.tmux.sessions || []).filter(matchFilter).map((t) => ({
    data: t,
    html: `<td>${escapeHtml(t.name)}</td><td>${t.windows}</td>
      <td><span class="chip ${t.attached ? "ok" : "warn"}">${t.attached ? "attached" : "detached"}</span></td>
      <td class="row-act"><button class="ghost-act" data-act="tmux_kill" data-target="${escapeHtml(t.name)}">Kill</button></td>`,
  }));
  return `${searchBar("Filter sessions")}${table(["Session", "Windows", "State", ""], rows)}`;
}

function procView(s) {
  $("headline").textContent = "Processes";
  $("subhead").textContent = "Highest CPU first. Terminate sends SIGTERM.";
  const rows = (s.processes || []).filter(matchFilter).map((p) => ({
    data: p,
    html: `<td>${p.pid}</td><td>${escapeHtml(p.user)}</td><td>${p.cpu}</td><td>${p.mem}</td>
      <td>${escapeHtml(p.elapsed)}</td><td>${escapeHtml(p.comm)}</td>
      <td class="row-act"><button class="ghost-act" data-act="proc_term" data-target="${p.pid}">Stop</button></td>`,
  }));
  return `${searchBar("Filter pid, user, command")}${table(["PID", "User", "CPU", "Mem", "Elapsed", "Command", ""], rows, {
    rowAttr: (p) => `data-open="proc" data-pid="${p.pid}"`,
  })}`;
}

function svcView(s) {
  $("headline").textContent = "Services";
  $("subhead").textContent = "Running systemd units.";
  const rows = (s.services || []).filter(matchFilter).map((u) => ({
    data: u,
    html: `<td>${escapeHtml(u.unit)}</td><td><span class="chip ok">${escapeHtml(u.sub || u.active)}</span></td><td>${escapeHtml(u.desc)}</td>`,
  }));
  return `${searchBar("Filter unit or description")}${table(["Unit", "State", "Description"], rows, {
    rowAttr: (u) => `data-open="svc" data-unit="${escapeHtml(u.unit)}"`,
  })}`;
}

function netView(s) {
  $("headline").textContent = "Network";
  $("subhead").textContent = "Listening sockets, grouped by process and port.";
  const rows = (s.listening || []).filter(matchFilter).map((r) => ({
    data: r,
    html: `<td>${escapeHtml(r.process)}</td><td>${r.pid || "—"}</td>
      <td><span class="chip">${escapeHtml(r.proto)}</span></td>
      <td>${escapeHtml(r.bind)}</td><td>${r.port ?? "—"}</td>
      <td>${escapeHtml(r.state)}</td><td>${r.fds > 1 ? r.fds : "—"}</td>`,
  }));
  const cron = (s.cron || []).filter(matchFilter).map((c) => ({
    data: c,
    html: `<td><span class="chip">${escapeHtml(c.schedule)}</span></td><td>${escapeHtml(c.command)}</td>`,
  }));
  const dock = (s.containers?.docker || []).map((c) => ({
    data: c,
    html: `<td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.status)}</td><td>${escapeHtml(c.image)}</td><td>${escapeHtml(c.ports || "")}</td>`,
  }));
  return `${searchBar("Filter process, port, bind")}
    ${table(["Process", "PID", "Proto", "Bind", "Port", "State", "FDs"], rows)}
    <div style="height:16px"></div>
    <div class="block"><h2>Cron</h2>${table(["Schedule", "Command"], cron)}</div>
    ${dock.length ? `<div style="height:16px"></div><div class="block"><h2>Docker</h2>${table(["Name", "Status", "Image", "Ports"], dock)}</div>` : ""}`;
}

function projView(s) {
  const items = (s.projects || []).filter(matchFilter);
  $("headline").textContent = "Projects";
  $("subhead").textContent = `${items.length} discovered on this host. New folders show for 48 hours.`;
  const cards = items
    .map(
      (p) => `<article data-open="proj" data-path="${escapeHtml(p.path)}">
        <div class="meta">
          ${p.new ? `<span class="chip info">new</span>` : ""}
          <span class="chip">${escapeHtml(p.kind || "dir")}</span>
          ${p.pm2 ? `<span class="chip ok">pm2 ${escapeHtml(p.pm2)}</span>` : ""}
        </div>
        <strong>${escapeHtml(p.name)}</strong>
        <code>${escapeHtml(p.path)}</code>
        <span>${escapeHtml([p.branch, p.remote].filter(Boolean).join(" · ") || "local")}</span>
      </article>`,
    )
    .join("");
  return `${searchBar("Filter name, path, kind")}<div class="proj">${cards || empty("No projects found in scan roots.")}</div>`;
}

function logsView() {
  $("headline").textContent = "Logs";
  $("subhead").textContent = "Structured entries from PM2 files or journald.";
  const names = (state.snap?.pm2.apps || []).map((a) => a.name);
  const units = (state.snap?.services || []).slice(0, 40).map((u) => u.unit);
  const options =
    state.logKind === "pm2"
      ? names.map((n) => `<option ${n === state.logName ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")
      : units.map((n) => `<option ${n === state.logName ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");
  const filtered = (state.logs || []).filter((e) => state.logLevel === "all" || e.level === state.logLevel).filter(matchFilter);
  const rows = filtered
    .slice()
    .reverse()
    .map((e) => ({
      data: { idx: state.logs.indexOf(e) },
      html: `<td>${escapeHtml(fmtWhen(e.ts, e.iso))}</td>
        <td><span class="chip ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "info"}">${escapeHtml(e.level)}</span></td>
        <td>${escapeHtml(e.source)}</td>
        <td>${escapeHtml(e.stream)}</td>
        <td class="log-msg">${escapeHtml(e.message)}</td>`,
    }));
  return `
    <div class="toolbar">
      <select id="log-kind">
        <option value="pm2" ${state.logKind === "pm2" ? "selected" : ""}>PM2</option>
        <option value="journal" ${state.logKind === "journal" ? "selected" : ""}>journal</option>
      </select>
      <select id="log-name"><option value="">All sources</option>${options}</select>
      <select id="log-level">
        <option value="all" ${state.logLevel === "all" ? "selected" : ""}>All levels</option>
        <option value="error" ${state.logLevel === "error" ? "selected" : ""}>Error</option>
        <option value="warn" ${state.logLevel === "warn" ? "selected" : ""}>Warn</option>
        <option value="info" ${state.logLevel === "info" ? "selected" : ""}>Info</option>
      </select>
      <input class="search" id="q" type="search" placeholder="Search messages" value="${escapeHtml(state.filter)}" />
      <button type="button" id="log-load">Reload</button>
    </div>
    ${table(["Time", "Level", "Source", "Stream", "Message"], rows, {
      rowAttr: (r) => `data-open="log" data-i="${r.idx}"`,
    })}
  `;
}

function usersView(s) {
  $("headline").textContent = "People";
  $("subhead").textContent = "Signed-in sessions and recent logins.";
  const now = (s.users.now || []).map((l) => ({
    data: l,
    html: `<td>${escapeHtml(l.user)}</td><td>${escapeHtml(l.tty)}</td><td>${escapeHtml(l.from)}</td><td>${escapeHtml(l.detail)}</td>`,
  }));
  const last = (s.users.last || []).map((l) => ({
    data: l,
    html: `<td>${escapeHtml(l.user)}</td><td>${escapeHtml(l.tty)}</td><td>${escapeHtml(l.from)}</td>
      <td>${l.active ? `<span class="chip ok">active</span>` : `<span class="chip">ended</span>`}</td>
      <td>${escapeHtml(l.when)}</td>`,
  }));
  return `<div class="grid-2">
    <div class="block"><h2>Now</h2>${table(["User", "TTY", "From", "Detail"], now)}</div>
    <div class="block"><h2>Recent logins</h2>${table(["User", "TTY", "From", "State", "When"], last)}</div>
  </div>`;
}

function auditView() {
  $("headline").textContent = "Audit";
  $("subhead").textContent = "Actions taken from this console.";
  const rows = (state.audit || []).map((a) => ({
    data: a,
    html: `<td>${escapeHtml(a.at || "")}</td><td>${escapeHtml(a.type || "")}</td><td>${escapeHtml(a.target || "")}</td>
      <td class="${a.ok ? "ok" : "bad"}">${a.ok ? "ok" : "fail"}</td><td>${escapeHtml(a.detail || "")}</td>`,
  }));
  return `${table(["When", "Action", "Target", "Result", "Detail"], rows)}
    <div class="block" style="margin-top:16px">
      <h2>Change password</h2>
      <form id="pw-form" class="toolbar" style="flex-direction:column;align-items:flex-start">
        <input type="password" id="pw-cur" placeholder="Current password" minlength="12" required />
        <input type="password" id="pw-new" placeholder="New password (12+)" minlength="12" required />
        <button type="submit">Update password</button>
      </form>
    </div>`;
}

function findPm2(name) {
  return (state.snap?.pm2.apps || []).find((a) => a.name === name);
}

function findProj(p) {
  return (state.snap?.projects || []).find((x) => x.path === p);
}

function findProc(pid) {
  return (state.snap?.processes || []).find((x) => String(x.pid) === String(pid));
}

function findSvc(unit) {
  return (state.snap?.services || []).find((x) => x.unit === unit);
}

function inspect(kind, key) {
  if (kind === "pm2") {
    const a = findPm2(key);
    if (!a) return;
    openSheet(
      a.name,
      kv([
        ["Status", a.status],
        ["PID", a.pid],
        ["CPU", `${a.cpu ?? 0}%`],
        ["Memory", fmtBytes(a.memory || 0)],
        ["Restarts", a.restarts],
        ["Unstable", a.unstable],
        ["Mode", a.mode],
        ["CWD", a.cwd],
        ["Script", a.script],
      ]),
      `<button type="button" data-act="pm2_restart" data-target="${escapeHtml(a.name)}">Restart</button>
       <button type="button" class="icon-btn" data-act="pm2_stop" data-target="${escapeHtml(a.name)}">Stop</button>
       <button type="button" class="icon-btn" data-act="pm2_start" data-target="${escapeHtml(a.name)}">Start</button>`,
    );
    return;
  }
  if (kind === "proj") {
    const p = findProj(key);
    if (!p) return;
    openSheet(
      p.name,
      kv([
        ["Kind", p.kind],
        ["Path", p.path],
        ["Branch", p.branch || "—"],
        ["Remote", p.remote || "—"],
        ["PM2", p.pm2 || "—"],
        ["New", p.new ? "yes" : "no"],
      ]),
    );
    return;
  }
  if (kind === "proc") {
    const p = findProc(key);
    if (!p) return;
    openSheet(
      p.comm,
      kv([
        ["PID", p.pid],
        ["User", p.user],
        ["CPU", p.cpu],
        ["Mem", p.mem],
        ["Elapsed", p.elapsed],
        ["Stat", p.stat],
      ]),
      `<button type="button" class="icon-btn" data-act="proc_term" data-target="${p.pid}">Send SIGTERM</button>`,
    );
    return;
  }
  if (kind === "svc") {
    const u = findSvc(key);
    if (!u) return;
    openSheet(u.unit, kv([["State", u.sub], ["Load", u.load], ["Description", u.desc]]));
    return;
  }
  if (kind === "log") {
    const e = state.logs[Number(key)];
    if (!e) return;
    openSheet(
      e.source,
      kv([
        ["Time", fmtWhen(e.ts, e.iso)],
        ["Level", e.level],
        ["Stream", e.stream],
        ["Message", e.message],
      ]),
    );
  }
}

function confirmAction(type, target) {
  const labels = {
    pm2_restart: "Restart this process?",
    pm2_stop: "Stop this process?",
    pm2_start: "Start this process?",
    proc_term: "Send SIGTERM to this PID?",
    tmux_kill: "Kill this tmux session?",
  };
  openSheet(
    labels[type] || type,
    `<p class="lede">${escapeHtml(type)} → <code>${escapeHtml(target)}</code></p>`,
    `<button type="button" id="act-go" data-act="${escapeHtml(type)}" data-target="${escapeHtml(target)}" data-confirmed="1">Confirm</button>
     <button type="button" class="icon-btn" id="act-no">Cancel</button>`,
  );
}

function render() {
  nav();
  const s = state.snap;
  if (!s) {
    $("view").innerHTML = "<p class='lede'>Loading host snapshot…</p>";
    return;
  }
  $("host-mini").textContent = s.host.hostname;
  const r = route();
  const map = {
    overview: () => overview(s),
    pm2: () => pm2View(s),
    tmux: () => tmuxView(s),
    processes: () => procView(s),
    services: () => svcView(s),
    network: () => netView(s),
    projects: () => projView(s),
    logs: logsView,
    users: () => usersView(s),
    audit: auditView,
  };
  $("view").innerHTML = (map[r] || map.overview)();
  bindView();
}

async function runAction(type, target) {
  try {
    await api("/api/action", { method: "POST", body: JSON.stringify({ type, target }) });
    toast("Done");
    closeSheet();
    await loadSnap();
  } catch (e) {
    toast(e.message);
  }
}

function bindView() {
  const q = $("q");
  if (q) {
    q.addEventListener("input", () => {
      state.filter = q.value;
      const pos = q.selectionStart;
      render();
      const nq = $("q");
      if (nq) {
        nq.focus();
        nq.setSelectionRange(pos, pos);
      }
    });
  }
  $("view").querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      confirmAction(btn.getAttribute("data-act"), btn.getAttribute("data-target"));
    });
  });
  $("view").querySelectorAll("[data-open]").forEach((row) => {
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      const kind = row.getAttribute("data-open");
      inspect(kind, row.getAttribute("data-name") || row.getAttribute("data-path") || row.getAttribute("data-pid") || row.getAttribute("data-unit") || row.getAttribute("data-i"));
    });
  });
  const kind = $("log-kind");
  const load = $("log-load");
  if (kind) {
    kind.addEventListener("change", () => {
      state.logKind = kind.value;
      state.logName = "";
      state.logs = [];
      render();
    });
  }
  const level = $("log-level");
  if (level) {
    level.addEventListener("change", () => {
      state.logLevel = level.value;
      render();
    });
  }
  const name = $("log-name");
  if (name) {
    name.addEventListener("change", () => {
      state.logName = name.value;
    });
  }
  const pw = $("pw-form");
  if (pw) {
    pw.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/password", {
          method: "POST",
          body: JSON.stringify({ current: $("pw-cur").value, next: $("pw-new").value }),
        });
        toast("Password updated");
        pw.reset();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  if (load) {
    load.addEventListener("click", () => loadLogs());
  }
}

async function loadLogs() {
  const kindEl = $("log-kind");
  const nameEl = $("log-name");
  if (kindEl) state.logKind = kindEl.value;
  if (nameEl) state.logName = nameEl.value;
  const q = new URLSearchParams({ kind: state.logKind, name: state.logName });
  const data = await api(`/api/logs?${q}`);
  state.logs = data.entries || [];
  render();
}

async function loadSnap() {
  state.snap = await api("/api/snapshot");
  if (route() === "audit") state.audit = (await api("/api/audit")).items || [];
  render();
}

function tickClock() {
  $("clock").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function showGate(needSetup) {
  $("app").classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("gate-title").textContent = needSetup ? "Create operator password" : "Operator sign in";
  $("gate-copy").textContent = needSetup
    ? "First run on this host. This password stays in data/auth.json (scrypt)."
    : "Password for this host console.";
  $("gate-btn").textContent = needSetup ? "Create password" : "Enter";
  $("gate-form").dataset.mode = needSetup ? "setup" : "login";
}

function showApp() {
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
}

function bindSheet() {
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
  });
  $("sheet").addEventListener("click", (e) => {
    const no = e.target.closest("#act-no");
    if (no) closeSheet();
    const go = e.target.closest("[data-confirmed='1']");
    if (go) runAction(go.getAttribute("data-act"), go.getAttribute("data-target"));
    const act = e.target.closest(".sheet-foot [data-act]:not([data-confirmed])");
    if (act) confirmAction(act.getAttribute("data-act"), act.getAttribute("data-target"));
  });
}

async function boot() {
  nav();
  tickClock();
  setInterval(tickClock, 1000);
  bindSheet();
  $("refresh").addEventListener("click", () => loadSnap().catch((e) => toast(e.message)));
  $("logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    location.reload();
  });
  window.addEventListener("hashchange", async () => {
    state.filter = "";
    if (route() === "audit") state.audit = (await api("/api/audit")).items || [];
    if (route() === "logs" && !state.logs.length) {
      render();
      loadLogs().catch((e) => toast(e.message));
      return;
    }
    render();
  });
  $("gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("gate-err").hidden = true;
    const password = $("gate-pass").value.trim();
    const mode = $("gate-form").dataset.mode;
    try {
      await api(mode === "setup" ? "/api/setup" : "/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      showApp();
      await loadSnap();
    } catch (err) {
      $("gate-err").hidden = false;
      $("gate-err").textContent = err.message;
    }
  });

  try {
    const bootCsrf = await api("/api/csrf");
    if (bootCsrf.csrf) state.csrf = bootCsrf.csrf;
    await api("/api/me");
    showApp();
    await loadSnap();
    setInterval(() => loadSnap().catch(() => {}), 8000);
  } catch (e) {
    showGate(Boolean(e.data?.needSetup));
  }
}

boot();
