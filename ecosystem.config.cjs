/** Why: PM2 process manager config — keeps the server alive after crashes and restarts it automatically.
 *  Usage: pm2 start ecosystem.config.cjs
 *  Requires PM2 to be installed globally: npm install -g pm2
 *  Log files land in ~/.pm2/logs/ by default. */
module.exports = {
  apps: [
    {
      name: 'vision-landing-console',
      script: 'server.js',
      interpreter: 'node',
      watch: false,
      max_restarts: 15,
      min_uptime: '5s',
      exp_backoff_restart_delay: 200,
      env: {
        NODE_ENV: 'production',
        PORT: 4010,
        LOG_LEVEL: 'info',
      },
      error_file: './data/pm2-error.log',
      out_file: './data/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
