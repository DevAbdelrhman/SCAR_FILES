import Database from 'better-sqlite3';

export function createSqliteSessionStore(session, databasePath, defaultMaxAge) {
  class SqliteSessionStore extends session.Store {
    constructor() {
      super();
      this.database = new Database(databasePath);
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('busy_timeout = 5000');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expire INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
      `);
      this.getStatement = this.database.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
      this.setStatement = this.database.prepare(`INSERT INTO sessions(sid, sess, expire) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`);
      this.destroyStatement = this.database.prepare('DELETE FROM sessions WHERE sid = ?');
      this.touchStatement = this.database.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
      this.pruneStatement = this.database.prepare('DELETE FROM sessions WHERE expire <= ?');
      this.pruneTimer = setInterval(() => {
        try { this.pruneStatement.run(Date.now()); } catch { /* cleanup will retry on the next interval */ }
      }, 60 * 60 * 1000);
      this.pruneTimer.unref();
    }

    expiry(sessionData) {
      const cookieExpiry = sessionData?.cookie?.expires;
      const parsed = cookieExpiry ? new Date(cookieExpiry).getTime() : NaN;
      if (Number.isFinite(parsed)) return parsed;
      const maxAge = Number(sessionData?.cookie?.maxAge);
      return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : defaultMaxAge);
    }

    get(sid, callback) {
      try {
        const row = this.getStatement.get(sid);
        if (!row) return callback(null, null);
        if (row.expire <= Date.now()) {
          this.destroyStatement.run(sid);
          return callback(null, null);
        }
        callback(null, JSON.parse(row.sess));
      } catch (error) { callback(error); }
    }

    set(sid, sessionData, callback = () => {}) {
      try {
        this.setStatement.run(sid, JSON.stringify(sessionData), this.expiry(sessionData));
        callback(null);
      } catch (error) { callback(error); }
    }

    destroy(sid, callback = () => {}) {
      try {
        this.destroyStatement.run(sid);
        callback(null);
      } catch (error) { callback(error); }
    }

    touch(sid, sessionData, callback = () => {}) {
      try {
        this.touchStatement.run(this.expiry(sessionData), sid);
        callback(null);
      } catch (error) { callback(error); }
    }

    close(callback = () => {}) {
      clearInterval(this.pruneTimer);
      try {
        this.database.close();
        callback(null);
      } catch (error) { callback(error); }
    }
  }

  return new SqliteSessionStore();
}
