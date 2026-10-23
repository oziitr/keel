module.exports = {
  apps: [
    {
      name: "keel",
      cwd: __dirname,
      script: "bin/keel.js",
      env: {
        NODE_ENV: "production",
        KEEL_BIND: "127.0.0.1",
        KEEL_PORT: "4310",
      },
    },
  ],
};
