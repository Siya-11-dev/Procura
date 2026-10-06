import { createHash } from "node:crypto";
import { getDb, withTransaction } from "./client";

/** Hash of the chain as it stood before this entry. */
const GENESIS = "0".repeat(64);

export type AuditAction =
  | "request.created"
  | "request.rerun"
  | "document.attached"
  | "pipeline.started"
  | "pipeline.completed"
  | "pipeline.failed"
  | "agent.completed"
  | "approval.requested"
  | "approval.auto_approved"
  | "approval.decided"
  | "risk.exception_granted"
  | "clarification.requested"
  | "clarification.answered"
  | "rfq.invitations_created"
  | "rfq.response_received"
  | "rfq.collection_closed"
  | "po.issued"
  | "po.blocked"
  | "po.dispatched"
  | "po.acknowledged"
  | "goods_receipt.recorded"
  | "invoice.matched";

export interface AuditEntry {
  requestId: string;
  actor: string;
  actorRole: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}

interface AuditRow {
  seq: number;
  request_id: string;
  occurred_at: string;
  actor: string;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string;
  prev_hash: string;
  entry_hash: string;
}

/**
 * Canonical string for an entry. Field order is fixed and separators are
 * unambiguous, so the same logical entry always hashes identically.
 */
function canonical(entry: {
  requestId: string;
  actor: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: string;
  occurredAt: string;
  prevHash: string;
}): string {
  return [
    entry.requestId,
    entry.actor,
    entry.actorRole ?? "",
    entry.action,
    entry.entityType,
    entry.entityId ?? "",
    entry.detail,
    entry.occurredAt,
    entry.prevHash,
  ].join("");
}

function hash(canonicalValue: string): string {
  return createHash("sha256").update(canonicalValue, "utf8").digest("hex");
}

function currentHash(): string {
  const row = getDb()
    .prepare("SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
    .get() as { entry_hash: string } | undefined;
  return row?.entry_hash ?? GENESIS;
}

/**
 * Append an entry to the chain.
 *
 * Must be called inside the same transaction as the change it describes,
 * otherwise the log can claim a change that rolled back. Callers get that for
 * free by wrapping both in `withTransaction`; when called on its own it opens
 * its own transaction.
 *
 * Wrapping matters for correctness beyond atomicity. Reading the previous hash
 * and inserting the new row is a read-then-write, and within a single process
 * the synchronous driver makes it unobservable. Across two processes it is not,
 * and both writers would chain off the same parent and fork the log. BEGIN
 * IMMEDIATE inside `withTransaction` takes the write lock before the read, so
 * the second writer waits rather than interleaving.
 */
export function appendAudit(entry: AuditEntry): string {
  return withTransaction(() => appendAuditLocked(entry));
}

function appendAuditLocked(entry: AuditEntry): string {
  const db = getDb();
  const occurredAt = new Date().toISOString();
  const prevHash = currentHash();
  const detail = JSON.stringify(entry.detail ?? {});
  const entryHash = hash(
    canonical({
      requestId: entry.requestId,
      actor: entry.actor,
      actorRole: entry.actorRole,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      detail,
      occurredAt,
      prevHash,
    }),
  );

  db.prepare(
    `INSERT INTO audit_log (
       request_id, actor, actor_role, action, entity_type, entity_id, detail,
       occurred_at, prev_hash, entry_hash
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    entry.requestId,
    entry.actor,
    entry.actorRole,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    detail,
    occurredAt,
    prevHash,
    entryHash,
  );

  return entryHash;
}

export interface AuditVerification {
  valid: boolean;
  entries: number;
  /** 1-based sequence number of the first entry that failed, if any. */
  brokenAtSeq: number | null;
  reason: string | null;
}

/**
 * Recompute the chain and confirm every link. A mismatch means an entry was
 * altered, removed, or inserted after the fact.
 */
export function verifyAuditChain(): AuditVerification {
  const rows = getDb()
    .prepare("SELECT * FROM audit_log ORDER BY seq")
    .all() as unknown as AuditRow[];

  let prevHash = GENESIS;
  for (const [index, row] of rows.entries()) {
    const expected = hash(
      canonical({
        requestId: row.request_id,
        actor: row.actor,
        actorRole: row.actor_role,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        detail: row.detail,
        occurredAt: row.occurred_at,
        prevHash,
      }),
    );

    if (row.prev_hash !== prevHash) {
      return {
        valid: false,
        entries: rows.length,
        brokenAtSeq: index + 1,
        reason: `previous-hash mismatch at seq ${row.seq}`,
      };
    }
    if (row.entry_hash !== expected) {
      return {
        valid: false,
        entries: rows.length,
        brokenAtSeq: index + 1,
        reason: `entry hash mismatch at seq ${row.seq}; content was modified`,
      };
    }
    prevHash = row.entry_hash;
  }

  return { valid: true, entries: rows.length, brokenAtSeq: null, reason: null };
}

export interface AuditRecord {
  seq: number;
  requestId: string;
  actor: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: unknown;
  occurredAt: string;
  entryHash: string;
}

export function listAudit(requestId?: string): AuditRecord[] {
  const rows = requestId
    ? (getDb()
        .prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY seq")
        .all(requestId) as unknown as AuditRow[])
    : (getDb().prepare("SELECT * FROM audit_log ORDER BY seq").all() as unknown as AuditRow[]);

  return rows.map((row) => ({
    seq: row.seq,
    requestId: row.request_id,
    actor: row.actor,
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: JSON.parse(row.detail) as unknown,
    occurredAt: row.occurred_at,
    entryHash: row.entry_hash,
  }));
}
