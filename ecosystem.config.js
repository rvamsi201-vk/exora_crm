module.exports = {
  apps: [
    {
      name: "exora-crm",
      script: "server.js",
      cwd: "/var/www/exora_crm",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      // No `env` block on purpose: /var/www/exora_crm/.env is the single
      // source of truth (server.js loads it via lib/env-guard), and PM2 env
      // values would silently win over it — dotenv never overwrites a var
      // that is already set in the process environment.
      max_memory_restart: "600M",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      time: true
    }
  ]
};
