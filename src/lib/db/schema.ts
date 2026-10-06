import type { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id                   TEXT PRIMARY KEY,
  reference            TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  raw_description      TEXT NOT NULL,
  requester_name       TEXT NOT NULL,
  requester_department TEXT NOT NULL,
  requester_email      TEXT NOT NULL,
  category             TEXT,
  unit                 TEXT NOT NULL DEFAULT 'units',
  quantity             REAL,
  currency             TEXT NOT NULL DEFAULT 'ZAR',
  budget_amount        REAL,
  needed_by            TEXT,
  urgency              TEXT NOT NULL DEFAULT 'normal',
  status               TEXT NOT NULL DEFAULT 'submitted',
  -- 'simulated' collects quotes in-process, 'portal' invites suppliers to
  -- respond through the supplier portal at their own pace.
  quote_mode           TEXT NOT NULL DEFAULT 'simulated',
  spec                 TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  country              TEXT NOT NULL,
  city                 TEXT,
  categories           TEXT NOT NULL DEFAULT '[]',
  certifications       TEXT NOT NULL DEFAULT '[]',
  performance_rating   REAL NOT NULL,
  quality_score        REAL NOT NULL,
  on_time_rate         REAL NOT NULL,
  response_rate        REAL NOT NULL,
  financial_health     TEXT NOT NULL,
  years_in_business    INTEGER NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'ZAR',
  min_order_value      REAL NOT NULL DEFAULT 0,
  contact_name         TEXT,
  contact_email        TEXT,
  notes                TEXT,
  -- NULL checked_at means the supplier has never been screened, which the
  -- risk agent treats as a gap rather than as a clean result.
  sanctions_checked_at TEXT,
  sanctions_result     TEXT,
  bbbee_level          INTEGER,
  bbbee_expiry         TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  supplier_id       TEXT NOT NULL REFERENCES suppliers(id),
  unit_price        REAL NOT NULL,
  currency          TEXT NOT NULL,
  quantity          REAL NOT NULL,
  subtotal          REAL NOT NULL,
  shipping_cost     REAL NOT NULL DEFAULT 0,
  tax_rate          REAL NOT NULL DEFAULT 0,
  total_price       REAL NOT NULL,
  minimum_order_qty REAL NOT NULL DEFAULT 1,
  lead_time_days    INTEGER NOT NULL,
  payment_terms     TEXT NOT NULL,
  warranty_months   INTEGER NOT NULL DEFAULT 12,
  validity_days     INTEGER NOT NULL DEFAULT 30,
  price_breaks      TEXT NOT NULL DEFAULT '[]',
  incoterms         TEXT NOT NULL DEFAULT 'DDP',
  notes             TEXT,
  decline_reason    TEXT,
  status            TEXT NOT NULL DEFAULT 'received',
  received_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_request ON quotes(request_id);

CREATE TABLE IF NOT EXISTS comparisons (
  id                      TEXT PRIMARY KEY,
  request_id              TEXT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  weights                 TEXT NOT NULL,
  rows                    TEXT NOT NULL,
  recommended_quote_id    TEXT,
  recommended_supplier_id TEXT,
  budget_amount           REAL,
  savings_vs_budget       REAL,
  savings_pct_vs_budget   REAL,
  savings_vs_lowest_bid   REAL NOT NULL DEFAULT 0,
  price_premium_pct       REAL NOT NULL DEFAULT 0,
  rationale               TEXT NOT NULL,
  trade_off_note          TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  quote_id            TEXT NOT NULL,
  supplier_id         TEXT NOT NULL,
  overall_score       REAL NOT NULL,
  financial_score     REAL NOT NULL,
  delivery_score      REAL NOT NULL,
  compliance_score    REAL NOT NULL,
  concentration_score REAL NOT NULL,
  band                TEXT NOT NULL,
  flags               TEXT NOT NULL DEFAULT '[]',
  recommendation      TEXT NOT NULL,
  is_recommended      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_request ON risk_assessments(request_id);

-- An approver may accept a critical risk finding instead of fixing it. The
-- exception is recorded so the purchase order can be released and the decision
-- stays auditable.
CREATE TABLE IF NOT EXISTS risk_exceptions (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  flag_code     TEXT NOT NULL,
  justification TEXT NOT NULL,
  approver_name TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_exception_unique
  ON risk_exceptions(request_id, flag_code);

CREATE TABLE IF NOT EXISTS negotiations (
  id                    TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  quote_id              TEXT NOT NULL,
  supplier_id           TEXT NOT NULL,
  list_unit_price       REAL NOT NULL,
  opening_unit_price    REAL NOT NULL,
  target_unit_price     REAL NOT NULL,
  walkaway_unit_price   REAL NOT NULL,
  counter_unit_price    REAL,
  agreed_unit_price     REAL,
  expected_saving       REAL NOT NULL DEFAULT 0,
  realised_saving       REAL NOT NULL DEFAULT 0,
  leverage              TEXT NOT NULL DEFAULT '[]',
  strategy              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'prepared',
  transcript            TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_neg_request ON negotiations(request_id);

CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  step_order       INTEGER NOT NULL,
  role             TEXT NOT NULL,
  approver_name    TEXT NOT NULL,
  threshold_amount REAL NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  decision_note    TEXT,
  decided_at       TEXT,
  automated        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(request_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  po_number         TEXT NOT NULL UNIQUE,
  quote_id          TEXT NOT NULL,
  supplier_id       TEXT NOT NULL,
  currency          TEXT NOT NULL,
  subtotal          REAL NOT NULL,
  shipping_cost     REAL NOT NULL,
  tax_amount        REAL NOT NULL,
  total_amount      REAL NOT NULL,
  payment_terms     TEXT NOT NULL,
  incoterms         TEXT NOT NULL,
  ship_to           TEXT NOT NULL,
  line_items        TEXT NOT NULL DEFAULT '[]',
  expected_delivery TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',
  issued_at         TEXT,
  dispatched_at     TEXT,
  dispatch_channel  TEXT,
  acknowledged_at   TEXT,
  ack_reference     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_request ON purchase_orders(request_id);

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  po_id           TEXT NOT NULL,
  supplier_id     TEXT NOT NULL,
  invoice_number  TEXT NOT NULL,
  currency        TEXT NOT NULL,
  invoice_amount  REAL NOT NULL,
  tax_amount      REAL NOT NULL,
  total_amount    REAL NOT NULL,
  received_date   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted',
  match           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_request ON invoices(request_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  step         INTEGER NOT NULL,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL,
  summary      TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '{}',
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_request ON agent_runs(request_id, step);

-- ---------------------------------------------------------- request documents
--
-- Files attached to a request at intake. These are inputs, not derived data, so
-- the rerun path clears everything else about a request but leaves these alone.
--
-- stored_path is always a server-generated name inside the upload directory;
-- original_name is the label the requester uploaded under and is never used to
-- build a path. sha256 lets an attachment be proven identical across a rerun,
-- and extracted_text is what the Request Agent actually reads.
CREATE TABLE IF NOT EXISTS request_documents (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  original_name  TEXT NOT NULL,
  stored_name    TEXT NOT NULL,
  extension      TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  content_type   TEXT,
  -- 'read' when the text was extracted and fed to the Request Agent,
  -- 'not_read' when the file was stored as evidence but could not be parsed.
  extract_status TEXT NOT NULL,
  extract_reason TEXT,
  extracted_text TEXT,
  char_count     INTEGER,
  uploaded_by    TEXT NOT NULL,
  uploaded_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_request ON request_documents(request_id, uploaded_at);

-- -------------------------------------------------------- clarification loop
--
-- Blocking questions raised at intake. The unique index means a rerun can
-- re-assert the same question without duplicating it or resurrecting one the
-- requester has already answered: INSERT OR IGNORE leaves an answered row alone.
CREATE TABLE IF NOT EXISTS clarifications (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  question    TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  answer      TEXT,
  answered_by TEXT,
  answered_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clarification_unique
  ON clarifications(request_id, code);
CREATE INDEX IF NOT EXISTS idx_clarifications_request ON clarifications(request_id, status);

-- ------------------------------------------------------ supplier RFQ portal
--
-- An invitation is one shortlisted supplier's link into a request for quotation.
-- The token is the credential: anyone holding it may open the invitation, which
-- is what makes a response possible without a supplier account.
CREATE TABLE IF NOT EXISTS rfq_invitations (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  supplier_id   TEXT NOT NULL REFERENCES suppliers(id),
  token         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'invited',
  decline_reason TEXT,
  quote_id      TEXT REFERENCES quotes(id) ON DELETE SET NULL,
  invited_at    TEXT NOT NULL,
  viewed_at     TEXT,
  responded_at  TEXT,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rfq_request ON rfq_invitations(request_id, status);

-- -------------------------------------------------------- goods receipt note
--
-- What physically arrived against a purchase order, captured line by line so
-- the invoice agent can match invoiced quantity to received quantity rather
-- than to what was merely ordered.
CREATE TABLE IF NOT EXISTS goods_receipts (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  po_id         TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL,
  received_date TEXT NOT NULL,
  received_by   TEXT NOT NULL,
  lines         TEXT NOT NULL DEFAULT '[]',
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'partial',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grn_request ON goods_receipts(request_id);

-- ------------------------------------------------------- approval authority
--
-- The delegation-of-authority ladder, held as data so a finance admin can
-- change a threshold without a code change. The approval agent falls back to
-- the built-in chain when this table is empty.
CREATE TABLE IF NOT EXISTS approval_authority (
  id              TEXT PRIMARY KEY,
  step_order      INTEGER NOT NULL,
  role            TEXT NOT NULL,
  approver_name   TEXT NOT NULL,
  threshold_amount REAL NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authority_order ON approval_authority(step_order);

-- ------------------------------------------------------------------- budgets
--
-- Annual spend ceiling per department (optionally narrowed to a category). A
-- request whose award would cross the ceiling gets a Budget Exception approval
-- step owned by the budget holder.
CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  department   TEXT NOT NULL,
  category     TEXT,
  annual_limit REAL NOT NULL,
  owner_name   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_scope ON budgets(department, category);

-- ---------------------------------------------------------------- audit log
--
-- Append-only, tamper-evident record of every state change with a decision
-- attached. Each row stores the SHA-256 of its own canonical content chained to
-- the previous row, so editing or removing an entry breaks verification from
-- that point onward. Triggers reject UPDATE and DELETE outright, meaning even a
-- privileged SQL session cannot rewrite history without dropping the triggers.
--
-- There is deliberately no ON DELETE CASCADE here: a request with audit history
-- cannot be deleted at all, which is the point of retaining the record.
CREATE TABLE IF NOT EXISTS audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL REFERENCES requests(id),
  actor       TEXT NOT NULL,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  entry_hash  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- ------------------------------------------------------------- account admin
--
-- audit_log is request-scoped by construction: its request_id is a foreign key
-- to requests(id), so it cannot record an event that belongs to no request.
-- Creating an account or changing someone's role is exactly such an event, and
-- leaving those unrecorded would mean the most privileged changes in the system
-- are the only ones with no trail. They get their own append-only log instead.
CREATE TABLE IF NOT EXISTS user_audit (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id  TEXT NOT NULL,
  subject_email TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_audit_subject ON user_audit(subject_id, seq);

CREATE TRIGGER IF NOT EXISTS user_audit_no_update
BEFORE UPDATE ON user_audit
BEGIN
  SELECT RAISE(ABORT, 'user_audit is append-only: updates are not permitted');
END;

CREATE TRIGGER IF NOT EXISTS user_audit_no_delete
BEFORE DELETE ON user_audit
BEGIN
  SELECT RAISE(ABORT, 'user_audit is append-only: deletes are not permitted');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: updates are not permitted');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: deletes are not permitted');
END;

-- -------------------------------------------------------------------- users
--
-- Application accounts and the approval authority each one carries. Roles map
-- to the approval steps generated by the approval agent, so authorisation is
-- checked against the role the step actually requires.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  department    TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
`;

/**
 * Columns added to tables that already exist in databases created before the
 * column was introduced. `CREATE TABLE IF NOT EXISTS` never alters a table it
 * finds, so a working database from an earlier run would otherwise be missing
 * the column the code now expects. Each statement is a guarded ALTER, applied
 * only when the column is genuinely absent, so running this is idempotent.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "requests",
    column: "quote_mode",
    ddl: "ALTER TABLE requests ADD COLUMN quote_mode TEXT NOT NULL DEFAULT 'simulated'",
  },
  {
    table: "suppliers",
    column: "sanctions_checked_at",
    ddl: "ALTER TABLE suppliers ADD COLUMN sanctions_checked_at TEXT",
  },
  {
    table: "suppliers",
    column: "sanctions_result",
    ddl: "ALTER TABLE suppliers ADD COLUMN sanctions_result TEXT",
  },
  {
    table: "suppliers",
    column: "bbbee_level",
    ddl: "ALTER TABLE suppliers ADD COLUMN bbbee_level INTEGER",
  },
  {
    table: "suppliers",
    column: "bbbee_expiry",
    ddl: "ALTER TABLE suppliers ADD COLUMN bbbee_expiry TEXT",
  },
  {
    table: "purchase_orders",
    column: "dispatched_at",
    ddl: "ALTER TABLE purchase_orders ADD COLUMN dispatched_at TEXT",
  },
  {
    table: "purchase_orders",
    column: "dispatch_channel",
    ddl: "ALTER TABLE purchase_orders ADD COLUMN dispatch_channel TEXT",
  },
  {
    table: "purchase_orders",
    column: "acknowledged_at",
    ddl: "ALTER TABLE purchase_orders ADD COLUMN acknowledged_at TEXT",
  },
  {
    table: "purchase_orders",
    column: "ack_reference",
    ddl: "ALTER TABLE purchase_orders ADD COLUMN ack_reference TEXT",
  },
];

export function runMigrations(db: DatabaseSync): void {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db
      .prepare(`PRAGMA table_info(${migration.table})`)
      .all() as unknown as { name: string }[];
    if (columns.some((column) => column.name === migration.column)) continue;
    db.exec(migration.ddl);
  }
}
