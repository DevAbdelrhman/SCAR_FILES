# SCAR FILES

SCAR FILES is a secure file portal for `files.scardrone.cc`, with public guest downloads, personal user workspaces, and administrator management. The frontend is React, Vite, TypeScript, and Tailwind CSS. The API uses Express, SQLite, bcrypt password hashes, server-side sessions, and private disk storage.

## Features

- Guest access to administrator-published public files without an account.
- User registration and sign-in with bcrypt verification, HTTP-only session cookies, CSRF tokens, and rate limiting.
- Private personal workspaces with ownership-enforced upload, listing, download, deletion, and a 5 GiB per-user storage quota.
- Admin sign-in with bcrypt verification, HTTP-only session cookies, CSRF tokens, login rate limiting, and a separate administrator role.
- Multi-file uploads for any extension. Uploads receive random internal names, remain outside the web root, and are always downloaded as attachments.
- Configurable per-file, per-batch, file-count, and total-storage limits.
- Admin search, sorting, metadata, storage and format statistics, downloads, confirmed deletion, and user suspension/reactivation.
- SQLite prepared statements, persistent SQLite sessions, a responsive dashboard, and deployment materials for an independent Nginx site.

## Local development

Requirements: Node.js 20 or newer and npm. From the project root:

```sh
cp .env.example .env
```

Set a private session secret in `.env` (for example, `openssl rand -hex 32`). The local defaults use `127.0.0.1:3080` for the API and `server/data/` for the database and private files. Install dependencies, create the first admin interactively, then start both services:

```sh
npm install
npm run admin:create
npm run dev
```

Open the address printed by Vite (normally `http://127.0.0.1:5173`). The development server forwards `/api` requests to the local Express API. No demo files or credentials are seeded.

## Configuration

Copy `.env.example` and set these values for your environment:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST`, `PORT` | API bind address and port | `127.0.0.1`, `3080` |
| `SESSION_SECRET` | Secret used to sign session identifiers; at least 32 characters | Required |
| `DATA_DIR` | Base private data directory | `./server/data` |
| `DATABASE_PATH` | Admin and file metadata database | `${DATA_DIR}/scar-files.sqlite` |
| `SESSION_DATABASE_PATH` | Persistent session database | `${DATA_DIR}/sessions.sqlite` |
| `STORAGE_DIR` | Private file-content directory | `${DATA_DIR}/uploads` |
| `MAX_UPLOAD_BYTES` | Maximum size of each file in bytes | 1 GiB |
| `MAX_UPLOAD_BATCH_BYTES` | Maximum combined file content in one request | 2 GiB |
| `MAX_UPLOAD_FILES` | Maximum files in one request | 10 |
| `MAX_STORAGE_BYTES` | Maximum total stored file content | 100 GiB |
| `SESSION_MAX_AGE_MS` | Session lifetime | 8 hours |

The API does not trust file extensions or client MIME types for execution or rendering. It stores a generic download content type. The dashboard shows file names as text only.

## API

Admin file and dashboard endpoints require an authenticated administrator. User workspace endpoints require an authenticated user and enforce file ownership. Login, registration, logout, uploads, deletion, and publication changes also require the session CSRF token in `X-CSRF-Token`. Obtain it from `GET /api/auth/csrf`; successful authentication returns the replacement token for the new session.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/auth/csrf` | Create/read the session CSRF token |
| `POST` | `/api/auth/login` | Sign in with `{ "username", "password" }` |
| `POST` | `/api/auth/logout` | Destroy the current session |
| `GET` | `/api/auth/me` | Get the current administrator |
| `POST` | `/api/user/auth/register` | Create a standard user account (never an admin) |
| `POST` | `/api/user/auth/login` | Sign in with `{ "identity", "password" }` |
| `POST` | `/api/user/auth/logout` | End the user session |
| `GET` | `/api/user/auth/me` | Get the current user |
| `GET` | `/api/user/dashboard` | Personal storage usage and recent files |
| `GET` | `/api/user/files` | List only the signed-in user's files |
| `POST` | `/api/user/files/upload` | Upload private personal files |
| `GET` | `/api/user/files/:id/download` | Download an owned file |
| `DELETE` | `/api/user/files/:id` | Delete an owned file |
| `GET` | `/api/admin/users` | Admin-only user list and usage |
| `PATCH` | `/api/admin/users/:id/status` | Admin-only account suspension/reactivation |
| `GET` | `/api/dashboard/stats` | Storage, formats, and recent file statistics |
| `GET` | `/api/files?q=&sort=&direction=&page=&pageSize=` | Search and list files (50 per page by default; up to 100) |
| `POST` | `/api/files/upload` | Upload multipart fields named `files` |
| `GET` | `/api/files/:id` | Read file metadata |
| `GET` | `/api/files/:id/download` | Download as an attachment |
| `DELETE` | `/api/files/:id` | Permanently remove a file |

## Deploy to Ubuntu Lightsail

The app is bound to `127.0.0.1:3080`. The provided Nginx site is a separate virtual host for `files.scardrone.cc`; it does not replace the main `scardrone.cc` or `flash.scardrone.cc` site configurations. Keep uploaded content under `/var/lib/scardrone-files`, outside the Nginx web root.

### 1. DNS and application files

At the DNS provider, add an `A` record for `files.scardrone.cc` pointing to the Lightsail server's public static IP. Leave the records for `scardrone.cc` and `flash.scardrone.cc` as they are. Allow inbound TCP 80 and 443 in the Lightsail firewall. Ensure the server has system-wide Node.js 20 or newer, npm, Nginx, Certbot, and OpenSSL installed. Copy the project into `/var/www/scardrone-files` and run the install script on the server as root:

```sh
sudo /var/www/scardrone-files/scripts/install-server.sh
```

The script checks for an existing Nginx configuration for this hostname and stops if it finds one. It also refuses to overwrite its own site files if they already exist. It creates a dedicated `scarfiles` system user, a private data directory, a root-readable environment file at `/etc/scardrone-files.env`, the systemd service, and a separate HTTP site configuration. It installs dependencies, builds the frontend, validates Nginx, and starts the service.

Review the generated environment file and adjust storage limits if needed:

```sh
sudoedit /etc/scardrone-files.env
sudo systemctl restart scar-files
```

Create the administrator. The password is entered without terminal echo and stored only as a bcrypt hash:

```sh
sudo -u scarfiles bash -c 'set -a; . /etc/scardrone-files.env; set +a; cd /var/www/scardrone-files; npm run admin:create --workspace server'
```

### 2. HTTPS

After DNS resolves to the Lightsail server, obtain a certificate using Certbot's webroot mode. This issues the certificate without rewriting any Nginx server block:

```sh
sudo certbot certonly --webroot -w /var/www/html -d files.scardrone.cc
```

Then enable the dedicated HTTPS site and validate/reload Nginx:

```sh
sudo /var/www/scardrone-files/scripts/enable-https.sh
```

The renewal hook reloads Nginx after Certbot renews certificates. Check the site at `https://files.scardrone.cc` and verify that the existing sites still respond as before.

### 3. Service operations

```sh
sudo systemctl status scar-files
sudo journalctl -u scar-files -f
sudo nginx -t
```

To update, copy the new release to the app directory and rerun `scripts/install-server.sh`. It reuses the existing environment file, service account, data, and site configuration; it does not reset the database or uploaded files.

## Security notes

- Public registration creates only standard user accounts. Administrator accounts must still be created from the server using `npm run admin:create --workspace server`.
- User uploads are private by default and are isolated by database ownership checks. Only an administrator can publish a file to the guest library.
- Suspending a user prevents further user API access and invalidates the account session on its next request.
- Each user has a 5 GiB personal quota, additionally bounded by the configured global storage limit.
- Uploaded names are metadata only. Disk names are random UUIDs, storage is not served by Nginx, and downloads force `application/octet-stream`, attachment disposition, and `nosniff`.
- Production session cookies are HTTP-only, Secure, and SameSite Lax. Express trusts one Nginx proxy hop for HTTPS detection.
- The Nginx proxy caps request bodies, disables request buffering for large uploads, and sends the original scheme and client address to Express.
- Database and upload directories are private to the service account. Back up both SQLite databases and the uploads directory together.

## Verification

The server test suite exercises CSRF token retrieval, unauthenticated rejection, login, current admin, dashboard statistics, file listing/search/detail/download/delete, logout, and the private metadata response. Run it with:

```sh
npm test
```

Build the production frontend with `npm run build`.
# SCAR_FILES
# SCAR_FILES
