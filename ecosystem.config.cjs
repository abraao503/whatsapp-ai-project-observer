const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

module.exports = {
  apps: [
    {
      name: 'whatsapp-observer',
      cwd: __dirname,
      script: 'dist/server.js',
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 15000,
      listen_timeout: 15000,
      time: true,
      out_file: path.join(__dirname, 'logs', 'out.log'),
      error_file: path.join(__dirname, 'logs', 'error.log'),
      merge_logs: true,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'production',
        HOST: process.env.HOST || '127.0.0.1',
        PORT: process.env.PORT || '3105'
      }
    }
  ]
};
