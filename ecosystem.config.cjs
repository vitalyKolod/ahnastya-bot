module.exports = {
  apps: [
    {
      name: 'ahnastya-bot',
      script: 'dist/app/bootstrap.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
