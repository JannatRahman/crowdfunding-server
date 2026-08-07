// ecosystem.config.js — PM2 process manager configuration
// Usage:  pm2 start ecosystem.config.js --env production

module.exports = {
  apps: [
    {
      name: 'crowdfunding-server',
      script: 'index.js',
      instances: 2,
      exec_mode: 'cluster',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
    },
  ],
};
