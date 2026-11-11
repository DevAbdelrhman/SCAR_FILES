import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, pipeline } from 'node:stream';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { db } from './db.js';
import { createSqliteSessionStore } from './session-store.js';

const require = createRequire(import.meta.url);
const session = require('express-session');
export const sessionStore = createSqliteSessionStore(session, config.sessionDatabasePath, config.sessionMaxAgeMs);
const randomBytes = promisify(crypto.randomBytes);
const app = express();
const isProduction = config.nodeEnv === 'production';
const idPattern = /^[a-f0-9-]{36}$/i;
const dummyPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

if (isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(express.json({ limit: '16kb', type: 'application/json' }));
app.use(session({
  name: 'scar.files.sid',
  secret: config.sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: config.sessionMaxAgeMs,
    path: '/',
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

function csrfToken() {
  return randomBytes(32).then((bytes) => bytes.toString('hex'));
}

function requireCsrf(req, res, next) {
  const supplied = req.get('x-csrf-token');
  const expected = req.session?.csrfToken;
  if (!supplied || !expected || !/^[a-f0-9]{64}$/i.test(supplied) || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Your security token is missing or expired. Refresh and try again.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const adminId = req.session?.adminId;
  if (!adminId) return res.status(401).json({ error: 'Authentication required.' });
  const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(adminId);
  if (!admin) {
    return req.session.destroy(() => res.status(401).json({ error: 'Authentication required.' }));
  }
  req.admin = admin;
  next();
}

function requireUser(req, res, next) {
  const userId = req.session?.userId;
  if (!userId || req.session?.adminId) return res.status(401).json({ error: 'User authentication required.' });
  const user = db.prepare("SELECT id, username, email, status, session_version, created_at AS createdAt FROM users WHERE id = ?").get(userId);
  if (!user || user.status !== 'active' || req.session.userVersion !== user.session_version) {
    return req.session.destroy(() => res.status(401).json({ error: 'Your account is unavailable. Contact support.' }));
  }
  const { session_version: _sessionVersion, ...publicUser } = user;
  req.user = publicUser;
  next();
}

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', apiLimiter);

app.get('/api/auth/csrf', async (req, res, next) => {
  try {
    if (!req.session.csrfToken) req.session.csrfToken = await csrfToken();
    req.session.save((error) => {
      if (error) return next(error);
      res.set('Cache-Control', 'no-store').json({ csrfToken: req.session.csrfToken });
    });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || username.length > 64 || !password || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter a valid username and password.' });
    }
    const admin = db.prepare('SELECT id, username, password_hash FROM admins WHERE username = ?').get(username);
    const matches = await bcrypt.compare(password, admin?.password_hash || dummyPasswordHash);
    if (!admin || !matches) return res.status(401).json({ error: 'The username or password is incorrect.' });

    req.session.regenerate(async (error) => {
      if (error) return next(error);
      req.session.adminId = admin.id;
      req.session.csrfToken = await csrfToken();
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.set('Cache-Control', 'no-store').json({
          admin: { username: admin.username },
          csrfToken: req.session.csrfToken,
        });
      });
    });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireAdmin, requireCsrf, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('scar.files.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });
});

app.get('/api/auth/me', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ admin: { username: req.admin.username } });
});

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/user/auth/register', registerLimiter, requireCsrf, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–32 characters using letters, numbers, dots, dashes or underscores.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try { result = db.prepare('INSERT INTO users(username, email, password_hash) VALUES (?, ?, ?)').run(username, email, passwordHash); }
    catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That username or email is already registered.' });
      throw error;
    }
    req.session.regenerate(async (error) => {
      if (error) return next(error);
      req.session.userId = Number(result.lastInsertRowid);
      req.session.userVersion = 0;
      req.session.csrfToken = await csrfToken();
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.status(201).set('Cache-Control', 'no-store').json({
          user: { id: Number(result.lastInsertRowid), username, email },
          csrfToken: req.session.csrfToken,
        });
      });
    });
  } catch (error) { next(error); }
});

app.post('/api/user/auth/login', loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const identity = typeof req.body?.identity === 'string' ? req.body.identity.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!identity || identity.length > 254 || !password || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Enter your username/email and password.' });
    const user = db.prepare('SELECT id, username, email, password_hash, status, session_version FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(identity, identity);
    const matches = await bcrypt.compare(password, user?.password_hash || dummyPasswordHash);
    if (!user || !matches) return res.status(401).json({ error: 'The email/username or password is incorrect.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'This account is suspended. Contact SCAR support.' });
    req.session.regenerate(async (error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.userVersion = user.session_version;
      req.session.csrfToken = await csrfToken();
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.set('Cache-Control', 'no-store').json({ user: { id: user.id, username: user.username, email: user.email }, csrfToken: req.session.csrfToken });
      });
    });
  } catch (error) { next(error); }
});

app.get('/api/user/auth/me', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json({ user: req.user }));
app.post('/api/user/auth/logout', requireUser, requireCsrf, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('scar.files.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });
});

const passwordChangeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/user/auth/change-password', passwordChangeLimiter, requireUser, requireCsrf, async (req, res, next) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (!currentPassword || !newPassword || newPassword.length < 10 || Buffer.byteLength(newPassword, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter your current password and a new password of at least 10 characters.' });
    }
    const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!await bcrypt.compare(currentPassword, account.password_hash)) return res.status( currentPassword ? 403 : 400).json({ error: 'Your current password is incorrect.' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(hash, req.user.id);
    const nextVersion = db.prepare('SELECT session_version FROM users WHERE id = ?').get(req.user.id).session_version;
    req.session.regenerate(async error => {
      if (error) return next(error);
      req.session.userId = req.user.id;
      req.session.userVersion = nextVersion;
      req.session.csrfToken = await csrfToken();
      req.session.save(saveError => {
        if (saveError) return next(saveError);
        res.set('Cache-Control', 'no-store').json({ success: true, csrfToken: req.session.csrfToken });
      });
    });
  } catch (error) { next(error); }
});

app.delete('/api/user/auth/account', requireUser, requireCsrf, async (req, res, next) => {
  try {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!password || !await bcrypt.compare(password, account.password_hash)) return res.status(403).json({ error: 'Password confirmation failed.' });
    const owned = db.prepare('SELECT storage_path, stored_name FROM files WHERE user_id = ?').all(req.user.id);
    const removeAccount = db.transaction(() => db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id));
    removeAccount();
    for (const file of owned) {
      const fullPath = safeStoragePath(file);
      if (fullPath) fs.rmSync(fullPath, { force: true });
    }
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('scar.files.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
      res.status(204).end();
    });
  } catch (error) { next(error); }
});

app.get('/api/user/dashboard', requireUser, (req, res) => {
  const stats = db.prepare('SELECT COUNT(*) AS totalFiles, COALESCE(SUM(file_size), 0) AS storageUsed FROM files WHERE user_id = ?').get(req.user.id);
  const recent = db.prepare('SELECT id, original_name AS originalName, extension, file_size AS fileSize, uploaded_at AS uploadedAt FROM files WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 5').all(req.user.id);
  res.set('Cache-Control', 'no-store').json({ ...stats, maxStorageBytes: 5 * 1024 * 1024 * 1024, recent });
});

app.get('/api/user/files', requireUser, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 160) : '';
  const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
  const pageSize = 50;
  const count = q
    ? db.prepare('SELECT COUNT(*) AS total FROM files WHERE user_id = ? AND instr(lower(original_name), lower(?)) > 0').get(req.user.id, q).total
    : db.prepare('SELECT COUNT(*) AS total FROM files WHERE user_id = ?').get(req.user.id).total;
  const rows = q
    ? db.prepare('SELECT id, original_name, extension, mime_type, file_size, uploaded_at FROM files WHERE user_id = ? AND instr(lower(original_name), lower(?)) > 0 ORDER BY uploaded_at DESC LIMIT ? OFFSET ?').all(req.user.id, q, pageSize, (page - 1) * pageSize)
    : db.prepare('SELECT id, original_name, extension, mime_type, file_size, uploaded_at FROM files WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?').all(req.user.id, pageSize, (page - 1) * pageSize);
  res.set('Cache-Control', 'no-store').json({
    files: rows.map(row => ({ id: row.id, originalName: row.original_name, extension: row.extension, mimeType: row.mime_type, fileSize: row.file_size, uploadedAt: row.uploaded_at, isPublic: false })),
    total: count, page, pageSize,
  });
});

app.get('/api/user/files/:id/download', requireUser, (req, res, next) => {
  if (!idPattern.test(req.params.id)) return res.status(404).json({ error: 'File not found.' });
  const row = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'File not found.' });
  const storagePath = safeStoragePath(row);
  if (!storagePath || !fs.existsSync(storagePath)) return res.status(404).json({ error: 'File content is unavailable.' });
  res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.download(storagePath, row.original_name, { headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } }, error => { if (error && !res.headersSent) next(error); });
});

app.delete('/api/user/files/:id', requireUser, requireCsrf, (req, res, next) => {
  if (!idPattern.test(req.params.id)) return res.status(404).json({ error: 'File not found.' });
  const row = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'File not found.' });
  const storagePath = safeStoragePath(row);
  if (!storagePath) return res.status(500).json({ error: 'File storage record is invalid.' });
  try { db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(row.id, req.user.id); fs.rmSync(storagePath, { force: true }); res.status(204).end(); }
  catch (error) { next(error); }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`SELECT u.id, u.username, u.email, u.status, u.created_at AS createdAt,
    COUNT(f.id) AS totalFiles, COALESCE(SUM(f.file_size), 0) AS storageUsed
    FROM users u LEFT JOIN files f ON f.user_id = u.id GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`).all();
  res.set('Cache-Control', 'no-store').json({ users });
});

app.patch('/api/admin/users/:id/status', requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !['active', 'suspended'].includes(req.body?.status)) return res.status(400).json({ error: 'Invalid user status.' });
  const result = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(req.body.status, id);
  if (!result.changes) return res.status(404).json({ error: 'User not found.' });
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, requireCsrf, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  try {
    const owned = db.prepare('SELECT storage_path, stored_name FROM files WHERE user_id = ?').all(id);
    const removeAccount = db.transaction(() => db.prepare('DELETE FROM users WHERE id = ?').run(id));
    const result = removeAccount();
    if (!result.changes) return res.status(404).json({ error: 'User not found.' });
    for (const file of owned) {
      const fullPath = safeStoragePath(file);
      if (fullPath) fs.rmSync(fullPath, { force: true });
    }
    res.status(204).end();
  } catch (error) { next(error); }
});

function readStats() {
  const summary = db.prepare('SELECT COUNT(*) AS totalFiles, COALESCE(SUM(file_size), 0) AS storageUsed, COUNT(DISTINCT extension) AS totalFormats FROM files').get();
  const formats = db.prepare(`SELECT extension, COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes
    FROM files GROUP BY extension ORDER BY count DESC, extension ASC LIMIT 8`).all();
  const recent = db.prepare(`SELECT id, original_name AS originalName, extension, mime_type AS mimeType,
    file_size AS fileSize, uploaded_at AS uploadedAt, is_public AS isPublic FROM files ORDER BY uploaded_at DESC LIMIT 5`).all();
  return {
    ...summary,
    maxStorageBytes: config.maxStorageBytes,
    maxFileBytes: config.maxFileBytes,
    maxBatchBytes: config.maxBatchBytes,
    maxUploadFiles: config.maxUploadFiles,
    formats,
    recent,
  };
}

function mapFile(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    extension: row.extension,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    uploadedAt: row.uploaded_at,
  isPublic: Boolean(row.is_public),
  };
}

app.get('/api/dashboard/stats', requireAdmin, (req, res) => {
  res.json(readStats());
});

app.get('/api/files', requireAdmin, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 160) : '';
  const pageValue = Number(req.query.page);
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const pageSizeValue = Number(req.query.pageSize);
  const pageSize = Number.isSafeInteger(pageSizeValue) && pageSizeValue > 0 ? Math.min(pageSizeValue, 100) : 50;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) return res.status(400).json({ error: 'Page number is too large.' });
  const sortBy = ['name', 'size', 'uploadedAt'].includes(req.query.sort) ? req.query.sort : 'uploadedAt';
  const sortColumns = { name: 'original_name COLLATE NOCASE', size: 'file_size', uploadedAt: 'uploaded_at' };
  const direction = req.query.direction === 'asc' ? 'ASC' : 'DESC';
  const search = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const total = q
    ? db.prepare("SELECT COUNT(*) AS total FROM files WHERE original_name LIKE ? ESCAPE '\\'").get(search).total
    : db.prepare('SELECT COUNT(*) AS total FROM files').get().total;
  const rows = q
    ? db.prepare(`SELECT id, original_name, extension, mime_type, file_size, uploaded_at, is_public FROM files WHERE original_name LIKE ? ESCAPE '\\' ORDER BY ${sortColumns[sortBy]} ${direction} LIMIT ? OFFSET ?`)
      .all(search, pageSize, offset)
    : db.prepare(`SELECT id, original_name, extension, mime_type, file_size, uploaded_at, is_public FROM files ORDER BY ${sortColumns[sortBy]} ${direction} LIMIT ? OFFSET ?`).all(pageSize, offset);
  res.json({ files: rows.map(mapFile), total, page, pageSize });
});

function findFile(req, res, next) {
  if (!idPattern.test(req.params.id)) return res.status(404).json({ error: 'File not found.' });
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found.' });
  req.fileRecord = row;
  next();
}

function safeStoragePath(row) {
  const resolved = path.resolve(row.storage_path);
  const relative = path.relative(config.storageDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (row.stored_name !== path.basename(resolved) || !/^[a-f0-9-]{36}$/i.test(row.stored_name)) return null;
  return resolved;
}

// Public visitors can only see files explicitly published by an administrator.
app.get('/api/public/files', (req, res) => {
  const rows = db.prepare(`
    SELECT id, original_name, extension, mime_type, file_size, uploaded_at, is_public
    FROM files
    WHERE is_public = 1
    ORDER BY uploaded_at DESC
    LIMIT 200
  `).all();

  res.set('Cache-Control', 'no-store').json({ files: rows.map(mapFile) });
});

app.get('/api/public/files/:id/download', (req, res, next) => {
  if (!idPattern.test(req.params.id)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  const row = db.prepare(
    'SELECT * FROM files WHERE id = ? AND is_public = 1'
  ).get(req.params.id);

  if (!row) return res.status(404).json({ error: 'File not found.' });

  const storagePath = safeStoragePath(row);
  if (!storagePath || !fs.existsSync(storagePath)) {
    return res.status(404).json({ error: 'File content is unavailable.' });
  }

  res.set({
    'Content-Type': 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });

  res.download(storagePath, row.original_name, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    },
  }, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get('/api/files/:id', requireAdmin, findFile, (req, res) => {
  res.json({ file: mapFile(req.fileRecord) });
});

app.get('/api/files/:id/download', requireAdmin, findFile, (req, res, next) => {
  const storagePath = safeStoragePath(req.fileRecord);
  if (!storagePath || !fs.existsSync(storagePath)) return res.status(404).json({ error: 'File content is unavailable.' });
  res.set({
    'Content-Type': 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.download(storagePath, req.fileRecord.original_name, { headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } }, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.patch('/api/files/:id/public', requireAdmin, requireCsrf, findFile, (req, res) => {
  if (typeof req.body?.isPublic !== 'boolean') {
    return res.status(400).json({ error: 'A valid publication status is required.' });
  }

  db.prepare('UPDATE files SET is_public = ? WHERE id = ?')
    .run(req.body.isPublic ? 1 : 0, req.fileRecord.id);

  const updated = db.prepare('SELECT * FROM files WHERE id = ?').get(req.fileRecord.id);
  res.set('Cache-Control', 'no-store').json({ file: mapFile(updated) });
});

app.delete('/api/files/:id', requireAdmin, requireCsrf, findFile, (req, res, next) => {
  const storagePath = safeStoragePath(req.fileRecord);
  if (!storagePath) return res.status(500).json({ error: 'File storage record is invalid.' });
  const removeRecord = db.transaction(() => db.prepare('DELETE FROM files WHERE id = ?').run(req.fileRecord.id));
  try {
    removeRecord();
    fs.rmSync(storagePath, { force: true });
    res.status(204).end();
  } catch (error) { next(error); }
});

let uploadInProgress = false;
function acquireUpload(req, res, next) {
  if (uploadInProgress) return res.status(429).json({ error: 'Another upload is finishing. Try again shortly.' });
  uploadInProgress = true;
  req.releaseUpload = () => { uploadInProgress = false; };
  next();
}

const privateStorage = {
  _handleFile(req, file, callback) {
    const filename = crypto.randomUUID();
    const target = path.join(config.storageDir, filename);
    let size = 0;
    const batchGuard = new Transform({
      transform(chunk, encoding, done) {
        size += chunk.length;
        req.uploadBatchBytes = (req.uploadBatchBytes || 0) + chunk.length;
        if (req.uploadBatchBytes > config.maxBatchBytes) {
          const error = new Error('Upload batch limit exceeded.');
          error.code = 'SCAR_BATCH_LIMIT';
          return done(error);
        }
        done(null, chunk);
      },
    });
    pipeline(file.stream, batchGuard, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), (error) => {
      if (error) return fs.rm(target, { force: true }, () => callback(error));
      callback(null, { destination: config.storageDir, filename, path: target, size });
    });
  },
  _removeFile(_req, file, callback) {
    fs.rm(file.path, { force: true }, callback);
  },
};

const uploadParser = multer({
  storage: privateStorage,
  limits: {
    fileSize: config.maxFileBytes,
    files: config.maxUploadFiles,
    fields: 0,
    parts: config.maxUploadFiles,
  },
});

function parseUploads(req, res, next) {
  // Allow a small multipart envelope in addition to the configured file-content limit.
  if (req.get('content-length') && Number(req.get('content-length')) > config.maxBatchBytes + 1024 * 1024) {
    req.releaseUpload();
    return res.status(413).json({ error: 'This upload is larger than the configured batch limit.' });
  }
  uploadParser.array('files', config.maxUploadFiles)(req, res, (error) => {
    if (error) {
      req.releaseUpload();
      return next(error);
    }
    next();
  });
}

const cleanOriginalName = (name) => {
  const base = path.posix.basename(String(name).replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'unnamed-file').slice(0, 255);
};

app.post('/api/files/upload', requireAdmin, requireCsrf, acquireUpload, parseUploads, (req, res, next) => {
  const uploaded = req.files || [];
  try {
    if (uploaded.length === 0) return res.status(400).json({ error: 'Choose at least one file to upload.' });
    const batchSize = uploaded.reduce((total, file) => total + file.size, 0);
    if (batchSize > config.maxBatchBytes) {
      uploaded.forEach((file) => fs.rmSync(file.path, { force: true }));
      return res.status(413).json({ error: 'This upload is larger than the configured batch limit.' });
    }
    const current = db.prepare('SELECT COALESCE(SUM(file_size), 0) AS bytes FROM files').get().bytes;
    if (current + batchSize > config.maxStorageBytes) {
      uploaded.forEach((file) => fs.rmSync(file.path, { force: true }));
      return res.status(413).json({ error: 'There is not enough storage available for these files.' });
    }
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO files(id, original_name, stored_name, extension, mime_type, file_size, storage_path, uploaded_at)
      VALUES (@id, @originalName, @storedName, @extension, @mimeType, @fileSize, @storagePath, @uploadedAt)`);
    const commit = db.transaction((records) => records.forEach((record) => insert.run(record)));
    const records = uploaded.map((file) => {
      const originalName = cleanOriginalName(file.originalname);
      const ext = path.extname(originalName).slice(0, 32).toLowerCase();
      return {
        id: crypto.randomUUID(),
        originalName,
        storedName: path.basename(file.path),
        extension: ext || '(no extension)',
        mimeType: 'application/octet-stream',
        fileSize: file.size,
        storagePath: path.resolve(file.path),
        uploadedAt: now,
      };
    });
    try { commit(records); }
    catch (error) {
      uploaded.forEach((file) => fs.rmSync(file.path, { force: true }));
      throw error;
    }
    res.status(201).json({ files: records.map((record) => ({
      id: record.id,
      originalName: record.originalName,
      extension: record.extension,
      mimeType: record.mimeType,
      fileSize: record.fileSize,
      uploadedAt: record.uploadedAt,
    })) });
  } catch (error) { next(error); }
  finally { req.releaseUpload(); }
});


app.post('/api/user/files/upload', requireUser, requireCsrf, acquireUpload, parseUploads, (req, res, next) => {
  const uploaded = req.files || [];
  try {
    if (!uploaded.length) return res.status(400).json({ error: 'Choose at least one file to upload.' });
    const batchSize = uploaded.reduce((sum, file) => sum + file.size, 0);
    const current = db.prepare('SELECT COALESCE(SUM(file_size), 0) AS bytes FROM files WHERE user_id = ?').get(req.user.id).bytes;
    const globalCurrent = db.prepare('SELECT COALESCE(SUM(file_size), 0) AS bytes FROM files').get().bytes;
    const userQuota = 5 * 1024 * 1024 * 1024;
    if (current + batchSize > userQuota) {
      uploaded.forEach(file => fs.rmSync(file.path, { force: true }));
      return res.status(413).json({ error: 'Your 5 GB personal storage limit would be exceeded.' });
    }
    if (globalCurrent + batchSize > config.maxStorageBytes) {
      uploaded.forEach(file => fs.rmSync(file.path, { force: true }));
      return res.status(413).json({ error: 'SCAR storage is currently full. Try again later.' });
    }
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO files(id, original_name, stored_name, extension, mime_type, file_size, storage_path, uploaded_at, user_id)
      VALUES (@id, @originalName, @storedName, @extension, @mimeType, @fileSize, @storagePath, @uploadedAt, @userId)`);
    const records = uploaded.map(file => {
      const originalName = cleanOriginalName(file.originalname);
      return { id: crypto.randomUUID(), originalName, storedName: path.basename(file.path), extension: path.extname(originalName).slice(0, 32).toLowerCase() || '(no extension)', mimeType: 'application/octet-stream', fileSize: file.size, storagePath: path.resolve(file.path), uploadedAt: now, userId: req.user.id };
    });
    try { db.transaction(items => items.forEach(item => insert.run(item)))(records); }
    catch (error) { uploaded.forEach(file => fs.rmSync(file.path, { force: true })); throw error; }
    res.status(201).json({ files: records.map(({ id, originalName, extension, fileSize, uploadedAt }) => ({ id, originalName, extension, fileSize, uploadedAt })) });
  } catch (error) { next(error); }
  finally { req.releaseUpload(); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));

app.use((error, req, res, _next) => {
  if (req.releaseUpload) req.releaseUpload();
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    const status = tooLarge || error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_PART_COUNT' ? 413 : 400;
    const message = tooLarge
      ? `Each file must be ${Math.floor(config.maxFileBytes / (1024 * 1024))} MB or smaller.`
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_PART_COUNT'
        ? `Choose no more than ${config.maxUploadFiles} files at a time.`
        : 'The upload could not be processed.';
    return res.status(status).json({ error: message });
  }
  if (error?.code === 'SCAR_BATCH_LIMIT') {
    return res.status(413).json({ error: `The combined upload must be ${Math.floor(config.maxBatchBytes / (1024 * 1024))} MB or smaller.` });
  }
  if (isProduction) console.error('Request failed:', error?.message || 'Unknown error');
  else console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

export default app;
