# Keel

Self-hosted Linux host console. One Node process, no npm dependencies, no database, no build step.

It shows live host stats, PM2, tmux, processes, systemd, listening ports, cron, discovered projects, user sessions, structured logs, and an audit log of actions taken from the UI.

## Install

Node.js 18+ on Linux.

```bash
git clone https://github.com/oziitr/keel.git
cd keel
node bin/keel.js
```

Open `http://127.0.0.1:4310` and create the operator password (12+ characters). First-time setup is loopback-only.

Global command from the clone:

```bash
npm install -g .
keel
```

With PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Reverse proxy

Bind stays on `127.0.0.1`. Put TLS in nginx, Caddy, or Caddy-equivalent.

```nginx
location / {
  proxy_pass http://127.0.0.1:4310;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

Then:

```bash
KEEL_SECURE=1 KEEL_PUBLIC_ORIGIN=https://keel.example.com node bin/keel.js
```

If `KEEL_PUBLIC_ORIGIN` is unset, Keel uses the request `Host` (and `X-Forwarded-Proto` when present).

## Environment

| Variable | Default | Notes |
|---|---|---|
| `KEEL_BIND` | `127.0.0.1` | Do not expose the Node port publicly |
| `KEEL_PORT` | `4310` | |
| `KEEL_SECURE` | unset | `1` behind HTTPS (`Secure` cookies, HSTS) |
| `KEEL_PUBLIC_ORIGIN` | request Host | Optional hard lock, e.g. `https://keel.example.com` |
| `KEEL_DATA` | `./data` | Password hash, JWT secret, audit; mode `0600` |
| `KEEL_JWT_TTL` | `14400` | Session seconds |
| `KEEL_SCAN_ROOTS` | `/root,/home,/var/www,/opt,/srv` | Project discovery |
| `KEEL_SCAN_VHOSTS` | on | Set `0` to skip `/var/www/vhosts` |

Copy `.env.example` if you load env from a file. Do not commit `data/` or secrets.

## What it can do

- Read: CPU/load, memory, disks, `ps`, PM2, tmux, systemd units, sockets, crontab, `who`/`last`, git and workspace folders, Docker/LXC when present
- Discover new project directories under the scan roots (including Plesk vhosts and PM2 working directories)
- Logs: PM2 out/err files and journald, shown as a table (time, level, source, message)
- Act (confirm in the UI, written to audit): PM2 restart/stop/start, SIGTERM a process, kill a tmux session

There is **no open shell**. Actions are allowlisted.

Auth: scrypt password, HS256 JWT in an httpOnly cookie, CSRF double-submit, Origin lock, login lockout, rate limits, CSP.

## Project layout

```text
bin/keel.js          entry
lib/                 HTTP server, auth, collectors, allowlisted actions
public/              UI (HTML/CSS/JS, no bundler)
ecosystem.config.cjs PM2 example
data/                created at runtime, not in git
```

## Requirements

- Node.js 18+
- Linux (`/proc`; systemd optional)
- PM2 / tmux / Docker / LXC are used when they exist on `PATH`

## License

MIT
