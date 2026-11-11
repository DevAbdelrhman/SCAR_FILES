import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcrypt';
import { db } from '../db.js';

async function hiddenPrompt(label) {
  if (!stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') return done(new Error('Cancelled.'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

try {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  const username = (await terminal.question('Admin username: ')).trim();
  terminal.close();
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) throw new Error('Use 3–64 letters, numbers, dots, underscores, or hyphens for the username.');
  const password = await hiddenPrompt('Password (12+ characters, up to 72 UTF-8 bytes): ');
  const confirmation = await hiddenPrompt('Confirm password: ');
  if (password.length < 12) throw new Error('Use a password with at least 12 characters.');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('Use a password no longer than 72 UTF-8 bytes.');
  if (password !== confirmation) throw new Error('The passwords do not match.');
  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO admins(username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  console.log(`Admin “${username}” created.`);
} catch (error) {
  console.error(error.message.includes('UNIQUE') ? 'That admin username already exists.' : error.message);
  process.exitCode = 1;
} finally {
  db.close();
}

