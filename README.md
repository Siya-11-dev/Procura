# Procura

AI procurement workforce. An employee raises a request in plain language; nine
agents source it, compare quotations, check risk, negotiate, route approval,
raise the purchase order and match the invoice — with every decision recorded
in a tamper-evident audit trail.

The selling point: **reduce procurement costs and the amount of manual
procurement work.**

Instead of `Employee → Procurement → Emails → Suppliers → Quotes → Spreadsheet → Approval → PO`,
the flow is `Request → AI sourcing → comparison → risk analysis → approval → purchase order`.

## The nine agents

| Step | Agent | What it does |
| --- | --- | --- |
| 1 | Request | Understands the request, asks for anything missing before sourcing starts |
| 2 | Supplier | Finds and scores suitable suppliers from the panel |
| 3 | Quote | Collects quotations (simulated, or from real suppliers via the portal) |
| 4 | Comparison | Compares price, quality, terms and delivery |
| 5 | Risk | Screens sanctions, B-BBEE, financial health and budget exposure |
| 6 | Negotiation | Prepares negotiation recommendations and savings |
| 7 | Approval | Routes against the DB-backed delegation-of-authority ladder |
| 8 | PO | Raises the purchase order, ready for dispatch and acknowledgement |
| 9 | Invoice | Three-way match against PO and goods receipt, tolerance-based |

## Quick start

Requirements: Node 22+ (tested on Node 24), npm.

```bash
git clone https://github.com/Siya-11-dev/Procura.git
cd Procura
npm install
cp .env.example .env.local    # then set AUTH_SECRET (see the comment in the file)
npm run dev
```

Open http://localhost:3000 and sign in with a demo account — password
`Procura!2026` for all of them:

| Email | Role |
| --- | --- |
| `admin@procura.co.za` | Admin |
| `nomsa.khumalo@procura.co.za` | Procurement lead |
| `riaan.steyn@procura.co.za` | Finance director |
| `thandiwe.mokoena@procura.co.za` | CFO |
| `daniel.fischer@procura.co.za` | CEO |
| `lerato.mabaso@procura.co.za` | Compliance officer |
| `amahle.dlamini@procura.co.za` | Requester |

> The shared demo password exists for local evaluation only. Override or remove
> it before any deployment that is reachable by anyone else.

## Supplier portal (async quote collection)

On **Raise a request** choose *Portal* mode. The pipeline pauses after supplier
selection and issues each shortlisted supplier a one-time link
(`/portal?token=…`). Suppliers quote or decline straight from the browser — no
account, no JavaScript. When every window has been answered (or declined) the
run resumes from the comparison step automatically; if nobody quoted, the
request is blocked with an audit entry rather than hanging.

Token guessing is throttled: 8 wrong links per client every 5 minutes, then
HTTP 429 with a `Retry-After` hint.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `start` | Production build / serve |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest (every test uses a throwaway SQLite file) |
| `npm run verify` | typecheck → lint → test → build, the gate CI runs |
| `npm run db:backup` | Snapshot `data/procura.db` into `data/backups/` |
| `npm run demo` | Run end-to-end scenarios on a temp database (`-- --keep` for the real one) |
| `npm run user:create` | Create or promote an account from the terminal |

## Data and backups

The system of record is a single SQLite database (write-ahead log enabled) at
`data/procura.db`, overridden with `PROCURA_DB_PATH`. The `data/` directory is
git-ignored.

```bash
npm run db:backup
```

writes a consistent snapshot to `data/backups/procura-<timestamp>.db` using
SQLite's `VACUUM INTO`, so the app keeps running while it copies. The ten
newest snapshots are kept and older ones pruned.

**Restore:** stop the app, delete `data/procura.db-wal` and
`data/procura.db-shm`, then copy the chosen snapshot over `data/procura.db`.

## Security model

- **Proxy gate** (`src/proxy.ts`) — cookie-only session check on every
  non-public path; sends anonymous visitors to `/login?next=…`.
- **Page guards** (`requireSession`) — dashboard, supplier panel and request
  detail verify the session themselves, and the detail page checks it *before*
  the lookup so unknown references cannot be probed.
- **Server actions and API routes** re-authorise every mutation with
  `requireRoles([...])` — the role allow-lists live in `src/app/actions.ts`.
- **Supplier portal** is token-authenticated, rate-limited, idempotent
  (double submissions are ignored) and refuses expired windows.
- **Audit log** (`audit_log`) is hash-chained; `verifyAuditChain()` detects any
  historical edit.

Set `AUTH_SECRET` in production (≥32 random bytes) and rotate it before
go-live.

## Architecture

- **Next.js 16** (App Router, server components + server actions), **React 19**,
  **Tailwind CSS v4**, **next-auth v5**, **Vitest 5**, raw **`node:sqlite`**.
- `src/lib/agents/` — the nine agents. Every agent runs a deterministic rule
  engine; set `PROCURA_LLM_API_KEY` (see `.env.example`) to route decisions
  through an LLM instead.
- `src/lib/pipeline.ts` — orchestration, clarification gate, RFQ pause/resume,
  approval routing, audit actor plumbing.
- `src/lib/db/` — schema, migrations, repositories, hash-chained audit.
- `src/app/` — routes: dashboard, requests, suppliers, admin, login/signup,
  `/portal` (supplier-facing, public).
- `tests/` — 17 Vitest files covering agents, pipeline, actions, portal,
  guards and backups; each file runs against a freshly created temp database.

CI (`.github/workflows/ci.yml`) runs the full `verify` gate on every push and
pull request against `main`.

## Project notes

The original brief and to-do list live in
[`Procura — AI Procurement Workforce.txt`](./Procura%20%E2%80%94%20AI%20Procurement%20Workforce.txt).
