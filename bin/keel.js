#!/usr/bin/env node
const path = require("path");
const { createServer } = require("../lib/server");
const { ensureDir, readAuth } = require("../lib/store");

const HOST = process.env.KEEL_BIND || "127.0.0.1";
const PORT = Number(process.env.KEEL_PORT || 4310);

ensureDir();
const server = createServer();
server.listen(PORT, HOST, () => {
  const setup = readAuth() ? "login with existing password" : "open the UI and set the operator password";
  console.log(`[keel] listening on http://${HOST}:${PORT}`);
  console.log(`[keel] ${setup}`);
  console.log(`[keel] data: ${path.resolve(process.env.KEEL_DATA || path.join(__dirname, "..", "data"))}`);
  if (HOST !== "127.0.0.1" && HOST !== "::1") {
    console.warn("[keel] bound on a public interface — use a strong password and reverse proxy TLS");
  }
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
