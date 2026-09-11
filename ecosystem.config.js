module.exports = {
  apps: [{
    name: "mimo-bridge",
    script: "server.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: "production"
    }
  }]
};
