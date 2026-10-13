# Authentication & Authorization

Internal, invitation-only authentication for the Garment Manager. The Express API is the
only security boundary; the Next.js app hides UI the user cannot use, nothing more.

## 1. Architecture

```
Browser ──HTTPS──▶ Next.js (md_frontend)  ──rewrite /api/v1/*──▶ Express API (md_backend) ──▶ PostgreSQL
          same-origin cookies + CSRF header                      sessions, RBAC, audit
```

- **Same-origin API.** The browser only talks to the Next.js origin. `next.config.ts` rewrites
  `/api/v1/*` to `API_URL`. Session cookies are therefore first-party, can use the `__Host-`
  prefix, and the Next `proxy.ts` can see them for optimistic redirects.
- **Opaque server sessions.** 256-bit random token in an HttpOnly cookie; the DB stores only
  `SHA-256(token)`. No JWTs, nothing in localStorage/sessionStorage.
- **RBAC.** Permission catalog in code (`permission.types.ts`), role → permission grants in the
  `role_permissions` table, one role per user, role `rank` for hierarchy.
- **Data layer.** Prisma ORM 7.10 (stable) with the `@prisma/adapter-pg` driver adapter. Schema in
  `prisma/schema.prisma`, migrations in `prisma/migrations`, client generated to `src/generated/prisma`
  (`src/db/prisma.ts` exports the client, `transaction()` and `isUniqueViolation()`). CRUD uses Prisma
  Client. Statements whose safety depends on one atomic SQL statement or a row lock stay typed raw SQL
  (`$queryRaw` tagged templates, always parameterized): single-use token consumption, login counters,
  `FOR UPDATE` locks, session lookup against the database clock, and the fabric list/ledger queries.

Backend modules (`src/modules`):

| Module | Responsibility |
| --- | --- |
| `auth/` | login, logout, password change/reset, CSRF, cookies, password policy/hashing, auth middleware |
| `sessions/` | create / authenticate / revoke / list sessions |
| `users/` | member administration and invitations |
| `permissions/` | permission catalog, `requirePermission` / `requireRole`, hierarchy rules, role editing |
| `audit/` | `recordAudit()`: security events, written inside the same transaction as the change |
| `mail/` | `outbox` (dev, JSON files) or `resend` (prod) transport |

Each module keeps the split: routes (middleware composition) → controller (HTTP + Zod parse)
→ service (security logic, transactions) → repository (SQL).

Frontend (`md_frontend`): `features/auth` (api, hooks, schemas, components, lib), `features/users`
(member admin), `lib/api-client.ts` (single Axios instance), `proxy.ts`, `components/app-sidebar.tsx`.

## 2. Files created

Backend: `src/config/env.ts`, `src/db/prisma.ts`, `prisma/schema.prisma`, `prisma/migrations/*`, `prisma.config.ts`,
`src/lib/{crypto,errors,logger,rate-limit,request}.ts`, `src/types/express.d.ts`,
`src/modules/auth/{auth.constants,auth.controller,auth.cookies,auth.middleware,auth.repository,auth.routes,auth.schema,auth.service,csrf,password,password-reset.service}.ts`,
`src/modules/sessions/{session.repository,session.service,session.types}.ts`,
`src/modules/users/{invitation.service,user.controller,user.repository,user.routes,user.schema,user.service,user.types}.ts`,
`src/modules/permissions/{permission.middleware,permission.repository,permission.routes,permission.schema,permission.service,permission.types,role.service}.ts`,
`src/modules/audit/audit.service.ts`, `src/modules/mail/mailer.ts`,
`src/scripts/bootstrap-owner.ts`, tests `src/**/*.test.ts`, `src/test/{helpers,global-setup,setup-env,e2e-reset,rebuild-database}.ts`,
`vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `docs/authentication.md`.

Frontend: `proxy.ts`, `lib/{api-client,safe-redirect,form-errors,initials}.ts`,
`features/auth/**` (api, hooks, schemas, types, lib, components), `features/users/**`,
`features/dashboard/components/dashboard-overview.tsx`, `components/{app-sidebar,nav-main,nav-user,page-header,brand-mark}.tsx`,
`components/form/{field,form-alert,password-input}.tsx`, `app/providers.tsx`,
`app/(auth)/{layout,login,forgot-password,reset-password,accept-invitation}`,
`app/(dashboard)/{layout,dashboard,account,account/security,users}`, `vitest.config.mts`,
`test/{setup.ts,render.tsx}`, `playwright.config.ts`, `e2e/*`, `.env.example`.

## 3. Files modified

Backend: `src/app.ts` (factory, helmet/CORS/trust-proxy/pino config, error handling),
`src/server.ts`, `src/routes/index.ts`, `package.json` (scripts; removed unused `bcryptjs`,
`jsonwebtoken`; added `supertest`, `@types/pg`, `vitest`, `typescript-eslint`, `@eslint/js`;
TypeScript pinned to `~6.0` because `typescript-eslint` does not support TS 7), `.env`, `.env.example`.

Frontend: `app/layout.tsx`, `app/page.tsx`, `app/globals.css` (Linear-style tokens),
`next.config.ts` (rewrites, security headers), `config/navigation.ts` (Members item),
`types/navigation.ts` (shared `Permission` type), `hooks/use-mobile.ts` (lint fix:
`useSyncExternalStore`), `package.json` (test deps; `@types/node` ^24 for Vitest 5), `.gitignore`.

## 4. Database

Prisma Migrate owns the schema. `npm run db:migrate` (`prisma migrate deploy`) applies pending
migrations; `npm run db:status` shows what is applied. Prisma CLI commands connect with `DIRECT_URL`
when set (Neon's pooled URL cannot hold Migrate's advisory lock); the app uses `DATABASE_URL`.

| Migration | Contents |
| --- | --- |
| `20261012000000_init` | Baseline: auth tables, roles and permissions seed, fabric master, purchases, ledger, stock projection, triggers. Consolidates the earlier hand-rolled `0001_auth` … `0006_fabric_drop_active`. |
| `20261013000000_fabric_search_text` | Fabric search uses a generated, trigram-indexed `search_text` column instead of an expression index. |

New migration: edit `prisma/schema.prisma`, run `npm run db:migrate:dev -- --create-only --name <name>`,
review the SQL (CHECK constraints, triggers and generated columns are written by hand, since Prisma
has no syntax for them), then `npm run db:migrate`. Never edit an applied migration.

Auth tables:

| Table | Key points |
| --- | --- |
| `roles` | UUID PK, unique `key`, unique `rank`. Seeded OWNER(100), ADMIN(80), MANAGER(60), STAFF(40), VIEWER(20) |
| `role_permissions` | PK `(role_id, permission)`; format-checked permission strings |
| `users` | UUID PK, `UNIQUE(email)` (stored normalized), `status user_status` enum (ACTIVE, INVITED, DISABLED, LOCKED), `password_hash` (required unless INVITED), failed-login counters, `locked_until` |
| `sessions` | `UNIQUE(token_hash)` (32-byte SHA-256), `expires_at`, `last_seen_at`, `revoked_at/reason`, `ip_address inet`, `user_agent`; partial index on active sessions by user; index on `expires_at` |
| `password_reset_tokens` | `UNIQUE(token_hash)`, `expires_at`, `used_at`; partial index on unused by user |
| `invitations` | `UNIQUE(token_hash)`; partial unique index: one open invitation per user |
| `audit_events` | event type, actor, target, session id, ip, user agent, `metadata jsonb`; indexed by target and type |

## 5. Environment variables

Backend (validated by Zod at startup; the process refuses to start on invalid config):

| Variable | Notes |
| --- | --- |
| `CLIENT_URL` | The one trusted browser origin (CORS + CSRF Origin check, email links). Must be `https://` in production |
| `DATABASE_URL` | PostgreSQL |
| `TEST_DATABASE_URL` | Integration tests only; the test run **drops and recreates** its `public` schema |
| `CSRF_SECRET` | ≥ 32 random chars; placeholder rejected in production |
| `TRUST_PROXY` | `false`, hop count, or subnets (`loopback`, `10.0.0.0/8`). `true` is rejected |
| `SESSION_IDLE_TIMEOUT_MINUTES` | default 120 |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | default 12 |
| `MAIL_TRANSPORT` | `outbox` (dev only; rejected in production) or `resend` |
| `MAIL_FROM`, `MAIL_OUTBOX_DIR`, `RESEND_API_KEY` | mail settings |
| `LOG_LEVEL` | pino level |
| `BOOTSTRAP_OWNER_EMAIL/NAME/PASSWORD` | one-time owner bootstrap only |

Frontend: `API_URL` (server-side, used by the rewrite; default `http://127.0.0.1:5000`).

## 6. API

All responses: `{ "success": true, "data": … }` or
`{ "success": false, "error": { "code", "message", "details?" } }`. Clients branch on `code`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/auth/csrf` | – | CSRF token for current state (sets anonymous nonce cookie if needed) |
| POST | `/api/v1/auth/login` | CSRF | Sign in; rotates session |
| POST | `/api/v1/auth/logout` | CSRF | Revoke current session, clear cookie |
| POST | `/api/v1/auth/logout-all` | session | Revoke all own sessions, including current |
| GET | `/api/v1/auth/me` | session | Sanitized current user + permissions |
| PATCH | `/api/v1/auth/me` | session | Update own display name |
| POST | `/api/v1/auth/change-password` | session | Verify current, set new, revoke all, issue new session |
| GET | `/api/v1/auth/sessions` | session | Own active sessions |
| DELETE | `/api/v1/auth/sessions/:sessionId` | session | Revoke one own session |
| POST | `/api/v1/auth/forgot-password` | CSRF | Always `202` + generic message |
| POST | `/api/v1/auth/reset-password` | CSRF | `{ token, newPassword }` |
| POST | `/api/v1/auth/invitations/inspect` | CSRF | `{ token }` → invitation email/name/role |
| POST | `/api/v1/auth/invitations/accept` | CSRF | `{ token, name, newPassword }` → activates account |
| GET | `/api/v1/users` | `users.view` | Members with role, status, invitation state |
| GET | `/api/v1/users/:userId` | `users.view` | One member |
| POST | `/api/v1/users/invitations` | `users.manage` | `{ email, name, roleKey }` → `inviteUrl` (returned once) |
| PATCH | `/api/v1/users/:userId` | `users.manage` | Edit display name |
| PUT | `/api/v1/users/:userId/role` | `users.manage` | Change role |
| POST | `/api/v1/users/:userId/disable` \| `/enable` | `users.manage` | Disable (revokes sessions) / re-enable or unlock |
| POST | `/api/v1/users/:userId/sessions/revoke` | `users.manage` | Sign a member out everywhere |
| POST | `/api/v1/users/:userId/invitation/resend` \| `/revoke` | `users.manage` | New link (old dies) / revoke |
| GET | `/api/v1/roles` | `users.view` | Roles, permissions, `assignable` flag |
| PUT | `/api/v1/roles/:roleKey/permissions` | role OWNER + `settings.manage` | Replace a role's permissions |

*Deviation:* invitation tokens go in the JSON body (`/invitations/inspect`, `/invitations/accept`)
instead of `GET /invitations/:token`, so tokens never appear in access logs or proxies.

## 7. Authentication / session flow

1. Client fetches `GET /auth/csrf` (anonymous token bound to an HttpOnly nonce cookie).
2. `POST /auth/login`: Zod validation (password ≤ 128 chars before any hashing), email normalized
   (NFKC, trim, lowercase). Unknown/disabled/invited/locked accounts run a dummy Argon2 verify and
   return the same `401 AUTH_INVALID_CREDENTIALS`.
3. On success, in one transaction: any presented session token is revoked, failure counters reset,
   a fresh session is inserted, `LOGIN_SUCCESS` is audited. Cookie set; the response header
   `X-CSRF-Token` carries the new session-bound CSRF token.
4. Every API request: `loadSession` hashes the cookie and runs one query that enforces revocation,
   absolute expiry, idle expiry (`last_seen_at`), and account status, and loads role + permissions.
   `last_seen_at` is refreshed at most once a minute. Invalid cookies are cleared.
5. Password change: all sessions revoked, a new one issued to the current browser (rotation).
   Password reset: all sessions revoked, user is **not** signed in.

## 8. Authorization flow

`requireAuth` → `requirePermission(...)` / `requireRole(...)` at the route, then object-level rules
in services via `permission.service.ts`:

- `canManageUser`: needs `users.manage` and must outrank the target (owners may manage owners).
- `canAssignRole`: non-owners can only grant roles ranked below them whose permissions they hold.
- `canEditRolePermissions`: OWNER role immutable; only grants the actor already holds.
- No self-management through admin routes; the last active owner cannot be demoted or disabled
  (checked under row locks).

Permissions are loaded from the DB on every request (same query as the session), so role or
permission changes apply on the next request. The sidebar uses `filterNavigation()` (nested items
filtered, empty parents and groups dropped) for UX only.

## 9. CSRF flow

Synchronizer token, stateless via HMAC-SHA256 with `CSRF_SECRET`:

- Authenticated: `HMAC("session:" + sessionId)`, so it changes whenever the session rotates.
- Anonymous (login, reset, invitation): `HMAC("anon:" + nonce)`, nonce in an HttpOnly cookie. This
  covers login CSRF.
- `csrfProtection` runs on every POST/PUT/PATCH/DELETE: Origin (or Referer) must equal `CLIENT_URL`
  when present, and `X-CSRF-Token` must match (constant-time comparison).
- Axios keeps the token in memory only, attaches it to mutations, picks up rotated tokens from the
  response header, and on `CSRF_INVALID` refetches and replays **once**.

## 10. Cookies

Centralized in `auth.cookies.ts`.

| | Production | Development |
| --- | --- | --- |
| Session | `__Host-gm_session` | `gm_session` |
| CSRF nonce | `__Host-gm_csrf` | `gm_csrf` |
| Attributes | `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain` | same, without `Secure` (plain-http localhost) |
| Session lifetime | `Max-Age` = absolute timeout; idle timeout enforced server-side | |

Lax rather than Strict: links from email or chat into the app must arrive signed in. CSRF tokens
cover state-changing requests. Logout clears with identical attributes.

## 11. Security decisions

- **Argon2id** (19 MiB, t=2, p=1; OWASP baseline), passwords NFKC-normalized, transparent rehash
  on login when parameters change.
- **Password policy:** 12–128 characters, no composition rules, rejects a list of common passwords,
  repeated characters, and passwords equal to the email or name.
- **Login abuse:** per-IP (20 failures / 15 min) and per-account (10 failures / 15 min) rate limits.
  Unknown emails are limited too, so 429 reveals nothing. Plus a progressive temporary DB lockout:
  5 failures within 15 minutes → `LOCKED` for 1, 2, 4, 8, then at most 15 minutes. It expires by
  itself, so it is never permanent. Locks only block password login; existing sessions survive, so
  an attacker cannot sign the real user out.
- **Forgot password:** responds `202` before doing any lookup work (no timing oracle), a 60 s
  per-account cooldown on emails, 30-minute single-use tokens, only the newest link valid.
- **Tokens** (session, reset, invite): 32 bytes CSPRNG, SHA-256 at rest, consumed with conditional
  `UPDATE … RETURNING` so concurrent use has exactly one winner (covered by tests). Email links put
  the token in the URL fragment (`#token=`); the page strips it from the address bar.
- **Transactions** wrap reset (consume + password + token invalidation + session revocation + audit),
  invitation acceptance, role changes, disable, and password change.
- **Errors:** central handler maps Zod, body-parser and `AppError`; anything else becomes a generic
  `500 INTERNAL_ERROR` with details only in server logs.
- **Logging:** pino-http logs method, path and request id. No bodies, no query strings. Cookie,
  authorization and CSRF headers are redacted, along with password/token fields. `X-Request-Id`
  is honored or generated.
- **Headers:** API uses Helmet with `default-src 'none'; frame-ancestors 'none'`, HSTS, no-referrer.
  The Next app sends `frame-ancestors 'none'`, nosniff, a referrer policy, a permissions policy,
  and HSTS in production, and drops `X-Powered-By`. Script-src CSP is not enforced yet; see §18.
- **CORS:** a single explicit origin with credentials, never `*`.
- **Compression** is disabled for `/api/v1/auth/*` (BREACH-style secret leakage).
- **Mass assignment:** every body schema is a Zod `strictObject`, so unknown keys get a 400.

Security checklist reviewed: SQL injection (parameterized only), XSS (React escaping, no raw HTML),
CSRF, session fixation (test), session theft (HttpOnly, no storage), enumeration (tests), credential
stuffing / brute force (limits + lockout), open redirects (`getSafeRedirect`, tested), privilege
escalation and IDOR (tests), cookie flags (test), token leakage and logging, race conditions
(concurrency tests), mass assignment (test), CORS, missing middleware (router-level `requireAuth`).

## 12. Creating the first owner

```bash
cd md_backend
npm run db:migrate
BOOTSTRAP_OWNER_EMAIL=you@company.com BOOTSTRAP_OWNER_NAME="Your Name" \
BOOTSTRAP_OWNER_PASSWORD="a long unique passphrase" npm run bootstrap:owner
```

Production build: `npm run db:migrate` (needs the `prisma` CLI, a dev dependency, so run it from CI
or a full install) and `npm run bootstrap:owner:prod`. The script
refuses to run once any OWNER exists (it takes an advisory lock, so concurrent runs are safe). There
is no HTTP endpoint for it. Remove `BOOTSTRAP_OWNER_PASSWORD` from the environment afterwards.

## 13. Inviting a user

Members → **Invite member** → email, name, role (only roles you may grant are listed). The invitee
gets an email (`outbox` in dev: `md_backend/.outbox/*.json`). The dialog also shows the single-use
link once, so it can be shared directly. The link expires after 72 h. **Resend** issues a new link
and kills the old one; **Revoke** invalidates it.

## 13a. Session handling in the web app

Only a **session problem** signs the user out. A server or network error never does.

| Situation | What the user sees |
| --- | --- |
| Any API call returns 401 (expired, revoked, account disabled) | Signed out → `/login?reason=expired&next=<page>`: "Your session has ended." |
| No API request in any tab for the idle timeout (120 min) | "Are you still there?" dialog 2 minutes before, with **Stay signed in**; then signed out (`reason=idle`, session revoked) |
| Absolute session lifetime (12 h) | Warning toast 2 minutes before, then signed out (`reason=expired`) |
| Logged out in another tab | Every tab signs out (`reason=elsewhere`); a login in one tab also refreshes the others |
| API or database down on first load | "Can't reach the server" screen with automatic retry (5 s → 30 s back-off), **Try again** and **Log out**. Still signed in |
| API or database down while working | Pages show their own error state with Retry; the user stays signed in with cached data |
| Browser offline | "You're offline" banner; queries pause and resume automatically |

How it works:

- `GET /auth/me` returns `user.session = { expiresAt, idleTimeoutMinutes }`. The client mirrors the server's limits; the server stays the authority.
- Idle time is measured from the last API response in any tab (shared through `localStorage`, a timestamp only), so one active tab keeps the others signed in.
- The API fails fast when the database is unreachable (5 s connect timeout, 15 s statement timeout). `/auth/me` has a 6 s client timeout and retries a dropped connection once.
- Every sign-out goes through `features/auth/lib/sign-out.ts`. It revokes the session on the server when asked, and always clears the session cookie: through the API, or through the same-origin `POST /session/end` route when the API is down. It then reloads into `/login`, so no cached data, CSRF token or timer survives.

## 14. Revoking sessions

- Self: Account → Security → revoke a device, or **Sign out everywhere** (`/auth/logout-all`).
- Admin: Members → ⋯ → **Sign out all sessions** (`POST /users/:id/sessions/revoke`).
- Automatic: disable account, password change (all except a fresh current session), password reset (all).
- Emergency, all users: `UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_admin' WHERE revoked_at IS NULL;`

## 15. Development

```bash
# PostgreSQL 18 in Docker (container "garment-postgres", port 5435; credentials in md_backend/.env)
docker start garment-postgres

cd md_backend && npm run db:migrate && npm run dev      # http://localhost:5000
cd md_frontend && npm run dev                           # http://localhost:3001 (proxies /api/v1)
```

## 16. Tests and checks

```bash
cd md_backend
npm run typecheck && npm run lint
npm test              # 84 integration tests (Vitest + Supertest, real PostgreSQL via TEST_DATABASE_URL;
                      # the schema is rebuilt with `prisma migrate deploy` before each run)
npm run build

cd md_frontend
npm run typecheck && npm run lint
npm test              # 42 component/unit tests (Vitest + Testing Library, jsdom)
npm run test:e2e      # 15 Playwright flows against real API + garment_e2e database
npm run build
```

The E2E suite starts its own API (port 5100) and Next dev server (port 3100). It rebuilds the
`garment_e2e` database through `md_backend/src/test/e2e-reset.ts`, which refuses any database not
named `*_e2e`. It uses the installed Microsoft Edge (`PW_CHANNEL=msedge`), because the Playwright
Chromium download timed out on this machine. Set `PW_CHANNEL=""` after `npx playwright install chromium`.

## 17. Production requirements

- HTTPS at the edge. Serve the frontend and `/api/v1` on **one origin**, with `CLIENT_URL` set to that
  exact `https://` origin.
- `NODE_ENV=production` turns on `__Host-` cookies, `Secure`, and the production config checks.
- `TRUST_PROXY` must match the real hops (Next on loopback: `loopback`; behind a load balancer: hop
  count or subnets). Next's rewrite only *adds* `X-Forwarded-For` when absent, so Next must sit behind
  a proxy that sets or appends it. Otherwise clients can spoof their IP for IP-based limits (account
  limits and lockout are unaffected).
- Strong `CSRF_SECRET` from a secret manager. Use `MAIL_TRANSPORT=resend` with `RESEND_API_KEY` and a
  verified `MAIL_FROM`, or swap the transport in `mailer.ts`.
- Run `npm run db:migrate` before starting new versions; bootstrap the owner once.
- Least-privilege DB user (DML on app tables; DDL only for the migration step).

## 18. Remaining risks and next steps

- Rate-limit counters live in memory per process. Running several API instances needs a shared store
  (Redis or Postgres). The DB lockout is already shared.
- Targeted lockout of one account is possible for up to 15 minutes at a time (by design, never
  permanent). Add CAPTCHA or step-up after repeated locks if it becomes a problem.
- Common-password check is a small local list; upgrade to a k-anonymity breached-password API.
- No MFA yet (TOTP / WebAuthn are the next step for OWNER and ADMIN accounts).
- Frontend CSP does not restrict `script-src`. Adding nonces via `proxy.ts` forces dynamic rendering;
  evaluate when the app grows.
- Expired and revoked sessions/tokens are never purged. Schedule
  `DELETE FROM sessions WHERE expires_at < now() - interval '30 days'` (and the same for tokens).
- Login for a known account does slightly more DB work than for an unknown one (counter update),
  which is sub-millisecond next to Argon2. Acceptable, noted.
- Role-permission editing exists in the API (`PUT /roles/:key/permissions`, owner-only) but has no UI yet.
