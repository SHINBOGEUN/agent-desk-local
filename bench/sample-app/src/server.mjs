import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { createApp } from './app.mjs';

const config = loadConfig();
const db = openDb(path.resolve(config.dataFile));
http.createServer(createApp({ db })).listen(config.port, '127.0.0.1', () => {
  console.log(`minitodo listening on http://127.0.0.1:${config.port}`);
});
