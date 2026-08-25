module.exports = {
  apps: [
    {
      name: "leadflow-crm-backend",
      script: "server.js",
      cwd: ".",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 3333
      },
      error_file: "./exora_crm/server_err.txt",
      out_file: "./exora_crm/server_out.txt",
      log_file: "./exora_crm/server_log.txt",
      merge_logs: true
    }
  ]
};
