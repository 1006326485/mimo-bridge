module.exports = {
  apps: [{
    name: "mimo-bridge",
    script: "server.js",
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: "production"
    }
  }]
};
