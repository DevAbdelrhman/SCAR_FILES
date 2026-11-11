import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { before, after, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scar-files-test-'));
const testPassword = randomBytes(24).toString('base64url');
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.DATA_DIR = tempDir;
process.env.DATABASE_PATH = path.join(tempDir, 'db.sqlite');
process.env.SESSION_DATABASE_PATH = path.join(tempDir, 'sessions.sqlite');
process.env.STORAGE_DIR = path.join(tempDir, 'uploads');
process.env.MAX_UPLOAD_BYTES = String(1024 * 1024);
process.env.MAX_UPLOAD_BATCH_BYTES = String(2 * 1024 * 1024);
process.env.MAX_STORAGE_BYTES = String(4 * 1024 * 1024);

let app;
let db;
let sessionStore;
let agent;
let csrfToken;
let uploadedId;

before(async () => {
  ({ default: app } = await import('../src/app.js'));
  ({ sessionStore } = await import('../src/app.js'));
  ({ db } = await import('../src/db.js'));
  db.prepare('INSERT INTO admins(username, password_hash) VALUES (?, ?)').run('operator', await bcrypt.hash(testPassword, 4));
  agent = request.agent(app);
});

after(() => {
  sessionStore?.close();
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('authentication, dashboard, file lifecycle, and logout API', async () => {
  const csrf = await agent.get('/api/auth/csrf').expect(200);
  csrfToken = csrf.body.csrfToken;
  assert.equal(typeof csrfToken, 'string');

  await agent.get('/api/auth/me').expect(401);
  await agent.get('/api/dashboard/stats').expect(401);
  await agent.get('/api/files').expect(401);
  await agent.get('/api/files/00000000-0000-4000-8000-000000000000').expect(401);
  await agent.get('/api/files/00000000-0000-4000-8000-000000000000/download').expect(401);
  await agent.post('/api/files/upload').expect(401);
  await agent.delete('/api/files/00000000-0000-4000-8000-000000000000').expect(401);
  await agent.post('/api/auth/login').send({ username: 'operator', password: testPassword }).expect(403);
  await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({ username: 'operator', password: randomBytes(24).toString('base64url') }).expect(401);

  const login = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken)
    .send({ username: 'operator', password: testPassword }).expect(200);
  csrfToken = login.body.csrfToken;
  assert.equal(login.body.admin.username, 'operator');
  await agent.get('/api/auth/me').expect(200).expect(({ body }) => assert.equal(body.admin.username, 'operator'));

  const stats = await agent.get('/api/dashboard/stats').expect(200);
  assert.equal(stats.body.totalFiles, 0);
  assert.equal(stats.body.storageUsed, 0);
  assert.equal(stats.body.totalFormats, 0);

  await agent.get('/api/files').expect(200).expect(({ body }) => assert.deepEqual(body.files, []));
  await agent.post('/api/files/upload').set('X-CSRF-Token', csrfToken)
    .attach('files', Buffer.alloc(1024 * 1024 + 1), 'too-large.bin').expect(413);

  const upload = await agent.post('/api/files/upload').set('X-CSRF-Token', csrfToken)
    .attach('files', Buffer.from('safe arbitrary binary payload'), 'release.bin')
    .attach('files', Buffer.from('firmware backup'), 'backup.fw').expect(201);
  assert.equal(upload.body.files.length, 2);
  uploadedId = upload.body.files[0].id;
  const secondId = upload.body.files[1].id;

  const detail = await agent.get(`/api/files/${uploadedId}`).expect(200);
  assert.equal(detail.body.file.originalName, 'release.bin');
  assert.equal('storagePath' in detail.body.file, false);
  await agent.get('/api/files/not-a-valid-id').expect(404);

  const list = await agent.get('/api/files?q=release&sort=name&direction=asc').expect(200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.files[0].id, uploadedId);
  const firstPage = await agent.get('/api/files?page=1&pageSize=1&sort=name&direction=asc').expect(200);
  const secondPage = await agent.get('/api/files?page=2&pageSize=1&sort=name&direction=asc').expect(200);
  assert.equal(firstPage.body.total, 2);
  assert.equal(firstPage.body.files.length, 1);
  assert.equal(secondPage.body.files.length, 1);
  assert.notEqual(firstPage.body.files[0].id, secondPage.body.files[0].id);

  const download = await agent.get(`/api/files/${uploadedId}/download`).expect(200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(download.headers['content-disposition'], /attachment/);
  assert.equal(download.body.toString(), 'safe arbitrary binary payload');

  const refreshedStats = await agent.get('/api/dashboard/stats').expect(200);
  assert.equal(refreshedStats.body.totalFiles, 2);
  assert.equal(refreshedStats.body.storageUsed, Buffer.byteLength('safe arbitrary binary payload') + Buffer.byteLength('firmware backup'));
  assert.equal(refreshedStats.body.totalFormats, 2);

  await agent.delete(`/api/files/${uploadedId}`).expect(403);
  await agent.delete(`/api/files/${uploadedId}`).set('X-CSRF-Token', csrfToken).expect(204);
  await agent.get(`/api/files/${uploadedId}`).expect(404);
  await agent.delete(`/api/files/${secondId}`).set('X-CSRF-Token', csrfToken).expect(204);
  await agent.post('/api/auth/logout').set('X-CSRF-Token', csrfToken).expect(204);
  await agent.get('/api/auth/me').expect(401);
});
