import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';

type Admin = { username: string };
type FileRecord = { id: string; originalName: string; extension: string; mimeType: string; fileSize: number; uploadedAt: string; isPublic: boolean };
type FormatStat = { extension: string; count: number; bytes: number };
type Stats = { totalFiles: number; storageUsed: number; totalFormats: number; maxStorageBytes: number; maxFileBytes: number; maxBatchBytes: number; maxUploadFiles: number; formats: FormatStat[]; recent: FileRecord[] };
type ApiError = { error?: string };
type View = 'overview' | 'files' | 'users';

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
};

const formatDate = (date: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date));

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></>,
    folder: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3 10h18"/></>,
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    download: <><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></>,
    trash: <><path d="M4 7h16"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/><path d="M10 11v5M14 11v5"/></>,
    arrow: <><path d="M7 17 17 7"/><path d="M8 7h9v9"/></>,
    chevron: <path d="m8 10 4 4 4-4"/>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11"/><path d="m9 12 2 2 4-4"/></>,
    harddrive: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/><path d="M7 17h.01M11 17h.01"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    logout: <><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.file}</svg>;
}

function Logo() {
  return <div className="brand">
    <img className="brand-wordmark" src="/scar-wordmark.svg" alt="SCAR DRONE" />
    <div className="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
    <div className="brand-meta"><span>FILES</span><small>PRIVATE CLOUD</small></div>
  </div>;
}

function FileGlyph({ extension }: { extension: string }) {
  const clean = extension.replace('.', '').replace(/[()]/g, '').slice(0, 4) || 'FILE';
  return <div className={`file-glyph glyph-${clean.toLowerCase().replace(/[^a-z0-9]/g, '')}`}><Icon name="file" size={19}/><span>{clean}</span></div>;
}

function Login({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setLoading(true);
    try { await onLogin(username, password); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not sign in.'); }
    finally { setLoading(false); }
  }
  return <main className="login-shell">
    <div className="login-grid"></div>
    <section className="login-card">
      <Logo />
      <div className="login-eyebrow"><span></span> SECURE ADMIN ACCESS</div>
      <h1>Welcome back.</h1>
      <p className="login-copy">Sign in to access your private file space.</p>
      <form onSubmit={submit} className="login-form">
        <label htmlFor="username">Username</label>
        <input id="username" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Enter your username" required />
        <div className="password-label"><label htmlFor="password">Password</label><span><Icon name="shield" size={14}/> Encrypted session</span></div>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required />
        {error && <div className="form-error">{error}</div>}
        <button className="button button-primary login-submit" disabled={loading}>{loading ? <span className="spinner"></span> : <>Sign in <Icon name="arrow" size={17}/></>}</button>
      </form>
      <div className="login-foot"><Icon name="shield" size={15}/> Private storage · Admin access only</div>
    </section>
    <div className="login-orbit orbit-one"></div><div className="login-orbit orbit-two"></div>
    <div className="login-caption">SCAR DRONE <span>·</span> FILE MANAGEMENT</div>
  </main>;
}


function GuestFiles() {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'firmware' | 'archives'>('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name' | 'size'>('newest');

  const loadPublicFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await readJson<{ files: FileRecord[] }>(
        await fetch('/api/public/files', {
          credentials: 'same-origin',
          cache: 'no-store'
        })
      );
      setFiles(result.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load public files.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPublicFiles(); }, [loadPublicFiles]);

  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return files
      .filter(file => {
        const name = file.originalName.toLowerCase();
        const matchesQuery = !normalized || name.includes(normalized);
        const matchesCategory =
          category === 'all' ||
          (category === 'firmware' && name.includes('.bin')) ||
          (category === 'archives' && /\.(zip|gz|tar|7z|rar)$/i.test(name));
        return matchesQuery && matchesCategory;
      })
      .sort((a, b) => {
        if (sort === 'name') return a.originalName.localeCompare(b.originalName);
        if (sort === 'size') return b.fileSize - a.fileSize;
        if (sort === 'oldest') return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
        return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
      });
  }, [files, query, category, sort]);

  const totalSize = files.reduce((sum, file) => sum + file.fileSize, 0);

  return (
    <main className="chatfiles-shell">
      <aside className="chatfiles-sidebar">
        <a className="chatfiles-brand" href="/" aria-label="SCAR Files home">
          <Logo />
        </a>



        <div className="chatfiles-nav-label">LIBRARY</div>
        <nav className="chatfiles-nav" aria-label="File categories">
          <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>
            <Icon name="grid" size={17} /> <span>All files</span>
            <small>{files.length}</small>
          </button>
          <button className={category === 'firmware' ? 'active' : ''} onClick={() => setCategory('firmware')}>
            <Icon name="harddrive" size={17} /> <span>Firmware</span>
          </button>
          <button className={category === 'archives' ? 'active' : ''} onClick={() => setCategory('archives')}>
            <Icon name="folder" size={17} /> <span>Archives</span>
          </button>
        </nav>

        <div className="chatfiles-sidebar-bottom">
          <div className="chatfiles-storage">
            <span className="chatfiles-storage-icon"><Icon name="shield" size={16} /></span>
            <div><strong>Public resources</strong><small>Shared by SCAR team</small></div>
          </div>
          <span className="chatfiles-sidebar-caption">SCAR DRONE · FILE PORTAL</span>
        </div>
      </aside>

      <section className="chatfiles-main">
        <header className="chatfiles-topbar">
          <span className="chatfiles-breadcrumb">SCAR FILES <span>/</span> RESOURCE LIBRARY</span>
          <a className="chatfiles-account-link" href="/account">Sign in / Create account</a>
          <button className="chatfiles-refresh" onClick={() => void loadPublicFiles()} disabled={loading}>
            <Icon name="arrow" size={15} /> {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </header>

        <div className="chatfiles-content">
          <div className="chatfiles-welcome">
            <div className="chatfiles-kicker"><span /> OFFICIAL RESOURCE CENTER</div>
            <h1>What are you<br /><span>looking for?</span></h1>
            <p>Find and download firmware, software and resources published by the SCAR Drone team.</p>
          </div>

          <label className="chatfiles-search">
            <Icon name="search" size={19} />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search the SCAR file library..."
              aria-label="Search public files"
            />
            <kbd>⌘ K</kbd>
          </label>

          <div className="chatfiles-section-head">
            <div>
              <h2>{category === 'all' ? 'All resources' : category === 'firmware' ? 'Firmware' : 'Archives'}</h2>
              <p>{loading ? 'Loading library...' : `${filteredFiles.length} resources available · ${formatBytes(totalSize)} total`}</p>
            </div>
            <label className="chatfiles-sort">
              <span>Sort</span>
              <select value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
                <option value="size">File size</option>
              </select>
            </label>
          </div>

          {loading ? (
            <div className="chatfiles-state"><span className="spinner" /> Loading resources...</div>
          ) : error ? (
            <div className="chatfiles-error" role="alert">
              <Icon name="shield" size={19} />
              <div><strong>Unable to load files</strong><span>{error}</span></div>
              <button onClick={() => void loadPublicFiles()}>Try again</button>
            </div>
          ) : filteredFiles.length ? (
            <div className="chatfiles-list">
              {filteredFiles.map(file => (
                <article className="chatfiles-row" key={file.id}>
                  <FileGlyph extension={file.extension} />
                  <div className="chatfiles-file-info">
                    <strong title={file.originalName}>{file.originalName}</strong>
                    <span>{file.extension.replace('.', '').toUpperCase() || 'FILE'} · {formatBytes(file.fileSize)}</span>
                  </div>
                  <span className="chatfiles-file-date">{formatDate(file.uploadedAt)}</span>
                  <a
                    className="chatfiles-download"
                    href={`/api/public/files/${encodeURIComponent(file.id)}/download`}
                    aria-label={`Download ${file.originalName}`}
                  >
                    <Icon name="download" size={17} />
                    <span>Download</span>
                  </a>
                </article>
              ))}
            </div>
          ) : (
            <div className="chatfiles-empty">
              <Icon name="folder" size={25} />
              <strong>{files.length ? 'No matching resources' : 'No public files yet'}</strong>
              <p>{files.length ? 'Try another search or category.' : 'Files will appear here when the SCAR team publishes them.'}</p>
              {files.length > 0 && <button onClick={() => { setQuery(''); setCategory('all'); }}>Clear filters</button>}
            </div>
          )}

          <footer className="chatfiles-footer">
            <span>SCAR DRONE</span>
            <span>{files.length} PUBLIC FILES <i /> {formatBytes(totalSize)} LIBRARY</span>
          </footer>
        </div>
      </section>
    </main>
  );
}


type UserAccount = { id: number; username: string; email: string; status: string; createdAt?: string };
function UserPortal() {
  const [user, setUser] = useState<UserAccount | null>(null);
  const [csrf, setCsrf] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identity, setIdentity] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [stats, setStats] = useState({ totalFiles: 0, storageUsed: 0, maxStorageBytes: 5 * 1024 * 1024 * 1024 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<FileList | null>(null);

  const api = async <T,>(response: Response) => readJson<T>(response);
  const refresh = useCallback(async () => {
    const [dashboard, list] = await Promise.all([
      fetch('/api/user/dashboard', { credentials: 'same-origin', cache: 'no-store' }).then(api<{ totalFiles: number; storageUsed: number; maxStorageBytes: number }>),
      fetch('/api/user/files', { credentials: 'same-origin', cache: 'no-store' }).then(api<{ files: FileRecord[] }>),
    ]);
    setStats(dashboard); setFiles(list.files);
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/csrf', { credentials: 'same-origin' }).then(api<{ csrfToken: string }>).then(async value => {
      if (!active) return;
      setCsrf(value.csrfToken);
      const response = await fetch('/api/user/auth/me', { credentials: 'same-origin' });
      if (response.ok) {
        const result = await api<{ user: UserAccount }>(response);
        if (active) setUser(result.user);
      }
    }).catch(() => {}).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => { if (user) refresh().catch(err => setError(err.message || 'Could not load your files.')); }, [user, refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      let token = csrf;
      if (!token) {
        const result = await api<{ csrfToken: string }>(await fetch('/api/auth/csrf', { credentials: 'same-origin' }));
        token = result.csrfToken; setCsrf(token);
      }
      const endpoint = mode === 'register' ? '/api/user/auth/register' : '/api/user/auth/login';
      const body = mode === 'register' ? { username, email, password } : { identity, password };
      const result = await api<{ user: UserAccount; csrfToken: string }>(await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body),
      }));
      setCsrf(result.csrfToken); setUser(result.user); setPassword('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Authentication failed.'); }
    finally { setBusy(false); }
  }

  async function uploadFiles() {
    if (!selected?.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const form = new FormData(); Array.from(selected).forEach(file => form.append('files', file));
      const result = await api<{ files: FileRecord[] }>(await fetch('/api/user/files/upload', {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf }, body: form,
      }));
      setSelected(null); setNotice(`${result.files.length} file(s) uploaded successfully.`); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.'); }
    finally { setBusy(false); }
  }

  async function removeFile(file: FileRecord) {
    if (!window.confirm(`Permanently delete "${file.originalName}"?`)) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/user/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
      if (!response.ok) throw new Error((await response.json() as ApiError).error || 'Delete failed.');
      setNotice('File deleted.'); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Delete failed.'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try {
      const response = await fetch('/api/user/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
      if (!response.ok) throw new Error('Could not sign out.');
      setUser(null); setFiles([]); setIdentity(''); setPassword('');
      const token = await api<{ csrfToken: string }>(await fetch('/api/auth/csrf', { credentials: 'same-origin' }));
      setCsrf(token.csrfToken);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not sign out.'); }
    finally { setBusy(false); }
  }

  return <main className="user-portal">
    <header className="user-portal-header"><a href="/" aria-label="SCAR Files home"><Logo /></a><div><a href="/">Public library</a>{user ? <button onClick={signOut} disabled={busy}>Sign out</button> : <span>Secure user access</span>}</div></header>
    {error && <div className="user-alert user-alert-error" role="alert">{error}</div>}
    {notice && <div className="user-alert user-alert-success">{notice}</div>}
    {!user ? <section className="user-auth-card">
      <div className="login-eyebrow"><span/> SCAR USER ACCOUNT</div>
      <h1>{mode === 'login' ? 'Your files. Your space.' : 'Create your account.'}</h1>
      <p>{mode === 'login' ? 'Sign in to manage your private files.' : 'Get your own secure 5 GB file workspace.'}</p>
      <div className="user-auth-tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Sign in</button><button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>Create account</button></div>
      <form onSubmit={submit} className="login-form">
        {mode === 'register' ? <><label htmlFor="user-name">Username</label><input id="user-name" value={username} onChange={e => setUsername(e.target.value)} minLength={3} maxLength={32} autoComplete="username" required/><label htmlFor="user-email">Email</label><input id="user-email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required/></> : <><label htmlFor="user-identity">Username or email</label><input id="user-identity" value={identity} onChange={e => setIdentity(e.target.value)} autoComplete="username" required/></>}
        <label htmlFor="user-password">Password</label><input id="user-password" type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={mode === 'register' ? 10 : undefined} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required/>
        {mode === 'register' && <small className="user-form-hint">Use at least 10 characters. User accounts cannot access admin controls.</small>}
        <button className="button button-primary login-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <Icon name="arrow" size={17}/></button>
      </form>
      <div className="login-foot"><Icon name="shield" size={15}/> Private by default · Secure session</div>
    </section> : <section className="user-workspace">
      <div className="user-workspace-heading"><div><div className="login-eyebrow"><span/> PERSONAL WORKSPACE</div><h1>Welcome, {user.username}.</h1><p>Your files are private and visible only to your account.</p></div><div className="user-storage-pill">{formatBytes(stats.storageUsed)} / {formatBytes(stats.maxStorageBytes)}</div></div>
      <div className="user-stats"><article><span>YOUR FILES</span><strong>{stats.totalFiles}</strong></article><article><span>STORAGE USED</span><strong>{formatBytes(stats.storageUsed)}</strong></article><article><span>AVAILABLE</span><strong>{formatBytes(Math.max(0, stats.maxStorageBytes - stats.storageUsed))}</strong></article></div>
      <section className="user-upload-card"><div><strong>Upload to your private space</strong><p>Files are private by default and never appear in the public library.</p></div><input type="file" multiple onChange={e => setSelected(e.target.files)} /><button className="button button-primary" onClick={uploadFiles} disabled={busy || !selected?.length}><Icon name="upload" size={16}/> Upload files</button></section>
      <section className="user-files-card"><div className="user-files-heading"><div><h2>Your files</h2><p>{files.length} files in your workspace</p></div><button onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
        {files.length ? <div className="user-files-list">{files.map(file => <article key={file.id}><FileGlyph extension={file.extension}/><div><strong title={file.originalName}>{file.originalName}</strong><span>{formatBytes(file.fileSize)} · {formatDate(file.uploadedAt)}</span></div><a href={`/api/user/files/${encodeURIComponent(file.id)}/download`}><Icon name="download" size={17}/> Download</a><button onClick={() => void removeFile(file)} disabled={busy} aria-label={`Delete ${file.originalName}`}><Icon name="trash" size={17}/></button></article>)}</div> : <div className="user-files-empty"><Icon name="folder" size={26}/><strong>Your workspace is empty</strong><span>Upload your first file to get started.</span></div>}
      </section>
    </section>}
    <footer className="user-portal-footer">SCAR DRONE · FILE PORTAL <span>Secure personal storage</span></footer>
  </main>;
}

function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [booting, setBooting] = useState(true);
  const [csrfToken, setCsrfToken] = useState('');
  const [view, setView] = useState<View>('overview');
  const [stats, setStats] = useState<Stats | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('uploadedAt');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [fileTotal, setFileTotal] = useState(0);
  const [adminUsers, setAdminUsers] = useState<(UserAccount & { totalFiles: number; storageUsed: number })[]>([]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStats = useCallback(async () => {
    setStats(await readJson<Stats>(await fetch('/api/dashboard/stats', { credentials: 'same-origin' })));
  }, []);

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const params = new URLSearchParams({ q: query, sort, direction, page: String(page), pageSize: '50' });
      const result = await readJson<{ files: FileRecord[]; total: number }>(await fetch(`/api/files?${params}`, { credentials: 'same-origin' }));
      setFiles(result.files);
      setFileTotal(result.total);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load files.'); }
    finally { setLoadingFiles(false); }
  }, [query, sort, direction, page]);

  const refresh = useCallback(async () => {
    await Promise.all([loadStats(), loadFiles()]);
  }, [loadStats, loadFiles]);

  const loadAdminUsers = useCallback(async () => {
    const result = await readJson<{ users: (UserAccount & { totalFiles: number; storageUsed: number })[] }>(
      await fetch('/api/admin/users', { credentials: 'same-origin', cache: 'no-store' })
    );
    setAdminUsers(result.users);
  }, []);

  async function updateUserStatus(user: UserAccount, status: 'active' | 'suspended') {
    try {
      const response = await fetch('/api/admin/users/' + user.id + '/status', {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ status }),
      });
      await readJson<{ success: boolean }>(response);
      setToast(status === 'suspended' ? 'User account suspended' : 'User account reactivated');
      await loadAdminUsers();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update user.'); }
  }

  useEffect(() => {
    let live = true;
    fetch('/api/auth/csrf', { credentials: 'same-origin' })
      .then((response) => readJson<{ csrfToken: string }>(response))
      .then(async (csrf) => {
        if (live) setCsrfToken(csrf.csrfToken);
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        return { csrf, session: response.ok ? await readJson<{ admin: Admin }>(response) : null };
      }).then(({ session }) => {
      if (!live) return;
      if (session) setAdmin(session.admin);
      setBooting(false);
    }).catch((err) => { if (live) { setError(err instanceof Error ? err.message : 'Could not connect to SCAR FILES.'); setBooting(false); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!admin) return;
    loadStats().catch((err) => setError(err instanceof Error ? err.message : 'Could not load your dashboard.'));
  }, [admin, loadStats]);

  useEffect(() => {
    if (!admin || view !== 'users') return;
    loadAdminUsers().catch(err => setError(err instanceof Error ? err.message : 'Could not load users.'));
  }, [admin, view, loadAdminUsers]);

  useEffect(() => {
    if (!admin) return;
    const timer = window.setTimeout(() => { void loadFiles(); }, 180);
    return () => window.clearTimeout(timer);
  }, [admin, loadFiles]);

  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(fileTotal / 50));
    if (page > lastPage) setPage(lastPage);
  }, [fileTotal, page]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function handleLogin(username: string, password: string) {
    if (!csrfToken) {
      const csrf = await readJson<{ csrfToken: string }>(await fetch('/api/auth/csrf', { credentials: 'same-origin' }));
      setCsrfToken(csrf.csrfToken);
    }
    const token = csrfToken || (await readJson<{ csrfToken: string }>(await fetch('/api/auth/csrf', { credentials: 'same-origin' }))).csrfToken;
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ username, password }),
    });
    const result = await readJson<{ admin: Admin; csrfToken: string }>(response);
    setCsrfToken(result.csrfToken); setAdmin(result.admin); setError('');
  }

  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
      if (!response.ok) throw new Error((await response.json() as ApiError).error || 'Sign out failed.');
      window.history.replaceState({}, '', '/');
      setAdmin(null); setFiles([]); setStats(null); setView('overview');
      const csrf = await readJson<{ csrfToken: string }>(await fetch('/api/auth/csrf', { credentials: 'same-origin' }));
      setCsrfToken(csrf.csrfToken);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not sign out.'); }
  }

  function addFiles(incoming: FileList | File[]) {
    const next = Array.from(incoming);
    if (next.length) { setSelectedFiles((previous) => [...previous, ...next]); setError(''); }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files);
  }

  async function upload() {
    if (!selectedFiles.length || uploadProgress !== null) return;
    setError(''); setUploadProgress(0);
    const body = new FormData(); selectedFiles.forEach((file) => body.append('files', file));
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload'); xhr.withCredentials = true;
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100)); };
      xhr.onload = async () => {
        try {
          const result = JSON.parse(xhr.responseText || '{}') as { files?: FileRecord[]; error?: string };
          if (xhr.status < 200 || xhr.status >= 300) throw new Error(result.error || 'Upload failed.');
          setToast(`${result.files?.length || selectedFiles.length} file${(result.files?.length || selectedFiles.length) === 1 ? '' : 's'} uploaded`);
          setSelectedFiles([]); setView('files'); await refresh();
        } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.'); }
        finally { setUploadProgress(null); resolve(); }
      };
      xhr.onerror = () => { setError('The connection was interrupted. Try the upload again.'); setUploadProgress(null); resolve(); };
      xhr.send(body);
    });
  }

  async function deleteFile() {
    if (!deleteTarget) return;
    try {
      const response = await fetch(`/api/files/${deleteTarget.id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
      if (!response.ok) throw new Error((await response.json() as ApiError).error || 'Could not delete this file.');
      setToast('File deleted'); setDeleteTarget(null); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete this file.'); }
  }

  async function togglePublic(file: FileRecord) {
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/public`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ isPublic: !file.isPublic }),
      });
      await readJson<{ file: FileRecord }>(response);
      setToast(file.isPublic ? 'File is now private' : 'File published for guests');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update publication status.');
    }
  }

  const usedPercentage = useMemo(() => stats ? Math.min((stats.storageUsed / stats.maxStorageBytes) * 100, 100) : 0, [stats]);

  if (booting) return <div className="loading-screen"><Logo/><span className="spinner"></span></div>;
  const isAdminRoute = window.location.pathname.replace(/\/+$/, '') === '/admin';

  const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
  if (!isAdminRoute && ['/account', '/register', '/workspace'].includes(currentPath)) return <UserPortal />;
  if (!isAdminRoute) return <GuestFiles />;
  if (!admin) return <Login onLogin={handleLogin} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <Logo />
      <div className="workspace-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => setView('overview')} aria-label="Overview"><Icon name="grid"/><span>Overview</span></button>
        <button className={view === 'files' ? 'nav-item active' : 'nav-item'} onClick={() => setView('files')} aria-label="File manager"><Icon name="folder"/><span>File manager</span><span className="nav-count">{stats?.totalFiles ?? 0}</span></button>
        <button className={view === 'users' ? 'nav-item active' : 'nav-item'} onClick={() => setView('users')} aria-label="User management"><Icon name="grid"/><span>User accounts</span><span className="nav-count">{adminUsers.length}</span></button>
      </nav>
      <div className="sidebar-spacer"></div>
      <div className="sidebar-storage">
        <div className="storage-title"><Icon name="harddrive" size={16}/> Storage</div>
        <div className="storage-values"><strong>{formatBytes(stats?.storageUsed ?? 0)}</strong><span>of {formatBytes(stats?.maxStorageBytes ?? 0)}</span></div>
        <div className="progress-track"><span style={{ width: `${usedPercentage}%` }}></span></div>
        <div className="storage-foot">{usedPercentage.toFixed(1)}% used</div>
      </div>
      <div className="sidebar-bottom">
        <div className="profile-avatar">{admin.username.slice(0, 1).toUpperCase()}</div>
        <div className="profile-info"><strong>{admin.username}</strong><span>Administrator</span></div>
        <button className="icon-button logout-button" onClick={logout} title="Sign out" aria-label="Sign out"><Icon name="logout" size={18}/></button>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div className="mobile-brand"><Logo/></div>
        <div className="breadcrumb"><span>SCAR FILES</span><b>/</b><strong>{view === 'overview' ? 'Overview' : view === 'users' ? 'User accounts' : 'File manager'}</strong></div>
        <div className="topbar-right"><span className="connection-status"><i></i> Private workspace</span><div className="top-avatar">{admin.username.slice(0, 1).toUpperCase()}</div></div>
      </header>

      {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" size={17}/></button></div>}

      <div className="page-content">
        {view === 'overview' ? <>
          <section className="welcome-row">
            <div><div className="eyebrow"><span className="eyebrow-line"></span> YOUR PRIVATE SPACE</div><h1>Good to see you, {admin.username}.</h1><p>Everything in your file space, in one place.</p></div>
            <button className="button button-primary" onClick={() => { setView('files'); window.setTimeout(() => fileInput.current?.click(), 0); }}><Icon name="plus" size={18}/> Upload files</button>
          </section>

          <section className="stats-grid" aria-label="Storage overview">
            <article className="stat-card"><div className="stat-top"><span className="stat-icon green"><Icon name="folder" size={19}/></span><span className="stat-label">TOTAL FILES</span><span className="stat-trend"><Icon name="arrow" size={13}/></span></div><div className="stat-number">{stats?.totalFiles ?? '—'}</div><div className="stat-foot">Across your private space</div><div className="stat-accent"></div></article>
            <article className="stat-card"><div className="stat-top"><span className="stat-icon mint"><Icon name="harddrive" size={19}/></span><span className="stat-label">STORAGE USED</span><span className="stat-trend"><Icon name="arrow" size={13}/></span></div><div className="stat-number">{formatBytes(stats?.storageUsed ?? 0)}</div><div className="stat-foot">of {formatBytes(stats?.maxStorageBytes ?? 0)} available</div><div className="mini-progress"><span style={{ width: `${usedPercentage}%` }}></span></div></article>
            <article className="stat-card"><div className="stat-top"><span className="stat-icon amber"><Icon name="file" size={19}/></span><span className="stat-label">FILE FORMATS</span><span className="stat-trend"><Icon name="arrow" size={13}/></span></div><div className="stat-number">{stats?.totalFormats ?? '—'}</div><div className="stat-foot">Different file extensions</div><div className="format-dots"><i></i><i></i><i></i><i></i><i></i></div></article>
          </section>

          <section className="overview-grid">
            <article className="panel recent-panel">
              <div className="panel-heading"><div><h2>Recent uploads</h2><p>Your latest files, ready when you are.</p></div><button className="text-button" onClick={() => setView('files')}>View all <Icon name="arrow" size={15}/></button></div>
              {(stats?.recent.length ?? 0) > 0 ? <div className="recent-list">{stats?.recent.map((file) => <div className="recent-row" key={file.id}><FileGlyph extension={file.extension}/><div className="recent-name"><strong title={file.originalName}>{file.originalName}</strong><span>{formatDate(file.uploadedAt)} <i>·</i> {formatBytes(file.fileSize)}</span></div><a className="icon-button download-icon" href={`/api/files/${file.id}/download`} title={`Download ${file.originalName}`} aria-label={`Download ${file.originalName}`}><Icon name="download" size={17}/></a></div>)}</div> : <div className="empty-recent"><div className="empty-art"><div><Icon name="file" size={22}/></div><span>+</span></div><strong>Nothing here yet</strong><p>When you upload a file, it will show up here.</p><button className="text-button" onClick={() => { setView('files'); window.setTimeout(() => fileInput.current?.click(), 0); }}>Upload your first file <Icon name="arrow" size={15}/></button></div>}
            </article>
            <article className="panel format-panel">
              <div className="panel-heading"><div><h2>File formats</h2><p>A quick look at your space.</p></div><span className="panel-kicker">TOP TYPES</span></div>
              {(stats?.formats.length ?? 0) > 0 ? <div className="format-list">{stats?.formats.slice(0, 5).map((format, index) => <div className="format-row" key={format.extension}><div className={`format-bullet bullet-${index}`}></div><div className="format-name"><strong>{format.extension}</strong><span>{format.count} {format.count === 1 ? 'file' : 'files'}</span></div><div className="format-size">{formatBytes(format.bytes)}</div></div>)}</div> : <div className="formats-empty"><div className="format-empty-icon"><Icon name="spark" size={20}/></div><strong>Your format mix</strong><span>will appear here once you add files.</span></div>}
              <div className="format-bottom"><span><i></i> All formats are welcome</span><Icon name="check" size={16}/></div>
            </article>
          </section>

          <section className="security-banner"><div className="security-badge"><Icon name="shield" size={20}/></div><div><strong>Your files stay private.</strong><p>Only your administrator account can access this workspace.</p></div><span className="secure-pill"><i></i> SECURE</span></section>
        </> : view === 'users' ? <>
          <section className="file-page-heading"><div><div className="eyebrow"><span className="eyebrow-line"></span> ADMINISTRATION</div><h1>User accounts</h1><p>Review registrations and control access to personal workspaces.</p></div><button className="button button-secondary" onClick={() => void loadAdminUsers()}><Icon name="arrow" size={15}/> Refresh</button></section>
          <section className="panel files-panel admin-users-panel">
            <div className="files-toolbar"><div><h2>Registered users <span className="count-chip">{adminUsers.length}</span></h2><p>Users can only manage their own private files.</p></div></div>
            <div className="admin-users-list">
              {adminUsers.length ? adminUsers.map(user => <article key={user.id}>
                <div className="profile-avatar">{user.username.slice(0,1).toUpperCase()}</div>
                <div className="admin-user-identity"><strong>{user.username}</strong><span>{user.email}</span></div>
                <div className="admin-user-meta"><strong>{user.totalFiles} files</strong><span>{formatBytes(user.storageUsed)}</span></div>
                <span className={user.status === 'active' ? 'admin-user-status active' : 'admin-user-status suspended'}>{user.status}</span>
                <button className="button button-secondary" onClick={() => void updateUserStatus(user, user.status === 'active' ? 'suspended' : 'active')}>{user.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
              </article>) : <div className="table-empty"><strong>No user accounts yet</strong><p>New registrations will appear here.</p></div>}
            </div>
          </section>
        </> : <>
          <section className="file-page-heading"><div><div className="eyebrow"><span className="eyebrow-line"></span> YOUR LIBRARY</div><h1>File manager</h1><p>Organize and access everything in your private space.</p></div><button className="button button-primary" onClick={() => fileInput.current?.click()}><Icon name="plus" size={18}/> Upload files</button></section>
          <section className="upload-zone-wrap">
            <div className={`upload-zone ${dragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop}>
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}/>
              <div className="upload-cloud"><Icon name="upload" size={22}/></div>
              <div className="drop-copy"><strong>Drop files here to upload</strong><span>or <button className="inline-link" onClick={() => fileInput.current?.click()}>browse your device</button></span></div>
              <div className="drop-foot"><Icon name="shield" size={14}/> Any file type · Up to {formatBytes(stats?.maxFileBytes ?? 1024 * 1024 * 1024)} per file · {formatBytes(stats?.maxBatchBytes ?? 2 * 1024 * 1024 * 1024)} total · {stats?.maxUploadFiles ?? 10} files per batch</div>
            </div>
            {selectedFiles.length > 0 && <div className="upload-queue"><div className="queue-heading"><strong>Ready to upload <span>{selectedFiles.length}</span></strong><button className="text-button subtle" onClick={() => setSelectedFiles([])}>Clear all</button></div>
              {selectedFiles.map((file, index) => <div className="queue-file" key={`${file.name}-${file.lastModified}-${index}`}><FileGlyph extension={file.name.includes('.') ? `.${file.name.split('.').pop()}` : '(none)'}/><div><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)}</span></div><button className="icon-button" onClick={() => setSelectedFiles((items) => items.filter((_, i) => i !== index))} aria-label={`Remove ${file.name}`}><Icon name="close" size={16}/></button></div>)}
              {uploadProgress !== null && <div className="upload-progress"><div className="progress-track"><span style={{ width: `${uploadProgress}%` }}></span></div><span>{uploadProgress}%</span></div>}
              <div className="queue-actions"><span><Icon name="shield" size={15}/> Stored privately and never executed</span><button className="button button-primary" onClick={upload} disabled={uploadProgress !== null}><Icon name="upload" size={17}/>{uploadProgress !== null ? 'Uploading…' : `Upload ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}`}</button></div>
            </div>}
          </section>
          <section className="panel files-panel">
            <div className="files-toolbar">
              <div><h2>All files <span className="count-chip">{stats?.totalFiles ?? 0}</span></h2><p>Search, sort, download, or remove a file.</p></div>
              <div className="file-controls">
                <label className="search-box"><Icon name="search" size={17}/><input aria-label="Search files" placeholder="Search files…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }}/></label>
                <div className="sort-select"><span>Sort</span><select aria-label="Sort files" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="uploadedAt">Date added</option><option value="name">Name</option><option value="size">Size</option></select><button className="icon-button sort-direction" onClick={() => { setDirection((value) => value === 'asc' ? 'desc' : 'asc'); setPage(1); }} title={direction === 'asc' ? 'Ascending' : 'Descending'} aria-label="Change sort direction">{direction === 'asc' ? '↑' : '↓'}</button></div>
              </div>
            </div>
            <div className="file-table-wrap"><table className="file-table"><thead><tr><th>NAME</th><th>FILE TYPE</th><th>SIZE</th><th>DATE ADDED</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
              {loadingFiles ? <tr><td colSpan={5}><div className="table-state"><span className="spinner"></span> Loading files…</div></td></tr> : files.length ? files.map((file) => <tr key={file.id}><td><div className="table-file"><FileGlyph extension={file.extension}/><strong title={file.originalName}>{file.originalName}</strong></div></td><td><span className="type-pill">{file.extension}</span></td><td>{formatBytes(file.fileSize)}</td><td>{formatDate(file.uploadedAt)}</td><td><div className="row-actions"><a className="icon-button" href={`/api/files/${file.id}/download`} title="Download" aria-label={`Download ${file.originalName}`}><Icon name="download" size={16}/></a><button className="icon-button" onClick={() => void togglePublic(file)} title={file.isPublic ? 'Unpublish file' : 'Publish file'} aria-label={file.isPublic ? 'Unpublish file' : 'Publish file'} style={{ color: file.isPublic ? '#65c99a' : '#a8b8ae', fontSize: 11, width: 'auto', padding: '0 8px' }}>{file.isPublic ? 'PUBLIC' : 'PRIVATE'}</button><button className="icon-button danger-action" onClick={() => setDeleteTarget(file)} title="Delete" aria-label={`Delete ${file.originalName}`}><Icon name="trash" size={16}/></button></div></td></tr>) : <tr><td colSpan={5}><div className="table-empty"><div className="empty-art compact-art"><div><Icon name="folder" size={20}/></div><span>+</span></div><strong>{query ? 'No matching files' : 'Your file space is empty'}</strong><p>{query ? 'Try another name or clear your search.' : 'Upload your first file and it will be stored securely here.'}</p>{!query && <button className="button button-secondary" onClick={() => fileInput.current?.click()}><Icon name="upload" size={16}/> Choose files</button>}</div></td></tr>}
            </tbody></table></div>
            <div className="file-table-footer"><span>Showing <strong>{fileTotal ? `${(page - 1) * 50 + 1}–${(page - 1) * 50 + files.length}` : '0'}</strong> of <strong>{fileTotal}</strong> files{query ? ` matching “${query}”` : ''}</span><div className="pagination"><button className="button button-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil(fileTotal / 50))}</span><button className="button button-secondary" disabled={page >= Math.ceil(fileTotal / 50)} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>
          </section>
        </>}
        <footer className="page-footer"><span>SCAR FILES <i>·</i> PRIVATE FILE MANAGEMENT</span><span>Designed for secure access <Icon name="shield" size={13}/></span></footer>
      </div>
    </main>

    {toast && <div className="toast"><span><Icon name="check" size={16}/></span>{toast}</div>}
    {deleteTarget && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }}><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div className="modal-icon"><Icon name="trash" size={21}/></div><button className="icon-button modal-close" onClick={() => setDeleteTarget(null)} aria-label="Close"><Icon name="close" size={18}/></button><h2 id="delete-title">Delete this file?</h2><p><strong>{deleteTarget.originalName}</strong> will be permanently removed from your private storage.</p><div className="modal-actions"><button className="button button-secondary" onClick={() => setDeleteTarget(null)}>Keep file</button><button className="button button-danger" onClick={deleteFile}><Icon name="trash" size={16}/> Delete file</button></div></section></div>}
  </div>;
}

export default App;
