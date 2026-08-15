// PM2 ecosystem — start with: pm2 start ecosystem.config.js
// Process name is `tech-king-backend` — completely separate from `shimba-backend`.
module.exports = {
  apps: [
    {
      name: 'tech-king-backend',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
