import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const parsePositiveInteger = (value, fallback, name) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return parsed;
};

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.resolve(serverDir, '..', '.env') });
const dataDir = path.resolve(process.env.DATA_DIR || path.join(serverDir, 'data'));

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: parsePositiveInteger(process.env.PORT, 3080, 'PORT'),
  dataDir,
  databasePath: path.resolve(process.env.DATABASE_PATH || path.join(dataDir, 'scar-files.sqlite')),
  sessionDatabasePath: path.resolve(process.env.SESSION_DATABASE_PATH || path.join(dataDir, 'sessions.sqlite')),
  storageDir: path.resolve(process.env.STORAGE_DIR || path.join(dataDir, 'uploads')),
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionMaxAgeMs: parsePositiveInteger(process.env.SESSION_MAX_AGE_MS, 8 * 60 * 60 * 1000, 'SESSION_MAX_AGE_MS'),
  maxFileBytes: parsePositiveInteger(process.env.MAX_UPLOAD_BYTES, 1024 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
  maxBatchBytes: parsePositiveInteger(process.env.MAX_UPLOAD_BATCH_BYTES, 2 * 1024 * 1024 * 1024, 'MAX_UPLOAD_BATCH_BYTES'),
  maxUploadFiles: parsePositiveInteger(process.env.MAX_UPLOAD_FILES, 10, 'MAX_UPLOAD_FILES'),
  maxStorageBytes: parsePositiveInteger(process.env.MAX_STORAGE_BYTES, 100 * 1024 * 1024 * 1024, 'MAX_STORAGE_BYTES'),
};

if (config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters. Generate one with: openssl rand -hex 32');
}

