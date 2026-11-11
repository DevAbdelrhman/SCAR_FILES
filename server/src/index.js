import app, { sessionStore } from './app.js';
import { config } from './config.js';
import { closeDatabase } from './db.js';

const server = app.listen(config.port, config.host, () => {
  console.log(`SCAR FILES API listening on ${config.host}:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      sessionStore.close(() => {
        closeDatabase();
        process.exit(0);
      });
    });
  });
}

