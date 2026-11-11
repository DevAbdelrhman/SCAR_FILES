import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

for (const dir of [path.dirname(config.databasePath), path.dirname(config.sessionDatabasePath), config.storageDir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* permissions may be managed by the service owner */ }
}

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    extension TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL CHECK(file_size >= 0),
    storage_path TEXT NOT NULL UNIQUE,
    uploaded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS files_uploaded_at_idx ON files(uploaded_at DESC);
  CREATE INDEX IF NOT EXISTS files_name_idx ON files(original_name COLLATE NOCASE);
`);

const fileColumns = db.pragma('table_info(files)');
if (!fileColumns.some((column) => column.name === 'is_public')) {
  db.exec('ALTER TABLE files ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1))');
}
db.exec('CREATE INDEX IF NOT EXISTS files_public_uploaded_at_idx ON files(is_public, uploaded_at DESC)');

export function closeDatabase() {
  if (db.open) db.close();
}

