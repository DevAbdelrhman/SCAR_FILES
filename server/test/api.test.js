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


test('user registration, private workspace, ownership isolation, and admin moderation', async () => {
  const first = request.agent(app);
  const firstCsrf = (await first.get('/api/auth/csrf').expect(200)).body.csrfToken;
  await first.post('/api/user/auth/register').set('X-CSRF-Token', firstCsrf)
    .send({ username: 'privateuser', email: 'private@example.com', password: 'long-secure-pass-1' }).expect(201);
  const me = await first.get('/api/user/auth/me').expect(200);
  assert.equal(me.body.user.username, 'privateuser');
  assert.equal(me.body.user.email, 'private@example.com');
  await first.get('/api/dashboard/stats').expect(401);
  await first.get('/api/user/dashboard').expect(200);

  const upload = await first.post('/api/user/files/upload')
    .set('X-CSRF-Token', (await first.get('/api/auth/csrf')).body.csrfToken)
    .attach('files', Buffer.from('my private document'), 'private.txt').expect(201);
  const privateId = upload.body.files[0].id;
  const ownList = await first.get('/api/user/files').expect(200);
  assert.equal(ownList.body.total, 1);
  assert.equal(ownList.body.files[0].isPublic, false);
  await first.get('/api/public/files').expect(200).expect(({ body }) => assert.equal(body.files.some(file => file.id === privateId), false));

  const second = request.agent(app);
  const secondCsrf = (await second.get('/api/auth/csrf').expect(200)).body.csrfToken;
  await second.post('/api/user/auth/register').set('X-CSRF-Token', secondCsrf)
    .send({ username: 'anotheruser', email: 'another@example.com', password: 'long-secure-pass-2' }).expect(201);
  await second.get('/api/user/files').expect(200).expect(({ body }) => assert.equal(body.total, 0));
  await second.get('/api/user/files/' + privateId + '/download').expect(404);
  await second.delete('/api/user/files/' + privateId).set('X-CSRF-Token', (await second.get('/api/auth/csrf')).body.csrfToken).expect(404);

  await first.get('/api/user/files/' + privateId + '/download').expect(200);
  await first.delete('/api/user/files/' + privateId).set('X-CSRF-Token', (await first.get('/api/auth/csrf')).body.csrfToken).expect(204);
  await first.get('/api/user/files').expect(200).expect(({ body }) => assert.equal(body.total, 0));

  const adminCsrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken;
  const adminLogin = await agent.post('/api/auth/login').set('X-CSRF-Token', adminCsrf)
    .send({ username: 'operator', password: testPassword }).expect(200);
  const users = await agent.get('/api/admin/users').expect(200);
  assert.equal(users.body.users.length, 2);
  const target = users.body.users.find(user => user.username === 'anotheruser');
  await agent.patch('/api/admin/users/' + target.id + '/status').set('X-CSRF-Token', adminLogin.body.csrfToken)
    .send({ status: 'suspended' }).expect(200);
  await second.get('/api/user/auth/me').expect(401);
  await second.post('/api/user/auth/login').set('X-CSRF-Token', (await second.get('/api/auth/csrf')).body.csrfToken)
    .send({ identity: 'anotheruser', password: 'long-secure-pass-2' }).expect(403);

  const firstToken = (await first.get('/api/auth/csrf')).body.csrfToken;
  await first.post('/api/user/auth/change-password').set('X-CSRF-Token', firstToken)
    .send({ currentPassword: 'wrong-password', newPassword: 'new-secure-password-3' }).expect(403);
  const changed = await first.post('/api/user/auth/change-password').set('X-CSRF-Token', firstToken)
    .send({ currentPassword: 'long-secure-pass-1', newPassword: 'new-secure-password-3' }).expect(200);
  assert.equal(typeof changed.body.csrfToken, 'string');
  await first.post('/api/user/auth/login').set('X-CSRF-Token', (await first.get('/api/auth/csrf')).body.csrfToken)
    .send({ identity: 'privateuser', password: 'long-secure-pass-1' }).expect(401);
  await first.post('/api/user/auth/login').set('X-CSRF-Token', (await first.get('/api/auth/csrf')).body.csrfToken)
    .send({ identity: 'privateuser', password: 'new-secure-password-3' }).expect(200);

  await first.delete('/api/user/auth/account').set('X-CSRF-Token', (await first.get('/api/auth/csrf')).body.csrfToken)
    .send({ password: 'incorrect-password' }).expect(403);
  await first.delete('/api/user/auth/account').set('X-CSRF-Token', (await first.get('/api/auth/csrf')).body.csrfToken)
    .send({ password: 'new-secure-password-3' }).expect(204);
  await first.get('/api/user/auth/me').expect(401);

  const afterDelete = await agent.get('/api/admin/users').expect(200);
  const targetAfter = afterDelete.body.users.find(user => user.username === 'anotheruser');
  await agent.delete('/api/admin/users/' + targetAfter.id).set('X-CSRF-Token', changed.body.csrfToken).expect(204);
  await agent.get('/api/admin/users').expect(200).expect(({ body }) => assert.equal(body.users.length, 0));
});
