import { getDb } from "@/lib/db/client";
import { nowIso } from "@/lib/util";
import type { Role } from "./roles";

/**
 * Append-only log of account-level events: registrations, role changes and
 * suspensions.
 *
 * Separate from the request audit chain on purpose. `audit_log.request_id` is a
 * foreign key to `requests(id)`, so it structurally cannot hold an event that
 * belongs to no request, and account administration is exactly that. Hash
 * chaining is not applied here either: these entries describe the accounts that
 * *grant* authority, and a hash chain an admin can rewrite by rewriting history
 * is not a control. The append-only triggers plus the write path below are the
 * control, and access to this table is itself admin-gated.
 */

export interface UserAuditEntry {
  subjectId: string;
  subjectEmail: string;
  actor: string;
  actorRole: Role | null;
  action:
    | "user.registered"
    | "user.role_changed"
    | "user.activated"
    | "user.deactivated"
    | "user.password_reset";
  detail?: Record<string, unknown>;
}

export function appendUserAudit(entry: UserAuditEntry): void {
  getDb()
    .prepare(
      `INSERT INTO user_audit (subject_id, subject_email, actor, actor_role, action, detail, occurred_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      entry.subjectId,
      entry.subjectEmail,
      entry.actor,
      entry.actorRole,
      entry.action,
      JSON.stringify(entry.detail ?? {}),
      nowIso(),
    );
}

export interface UserAuditRow {
  seq: number;
  subjectId: string;
  subjectEmail: string;
  actor: string;
  actorRole: string | null;
  action: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export function listUserAudit(limit = 100): UserAuditRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM user_audit ORDER BY seq DESC LIMIT ?")
    .all(limit) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    seq: row.seq as number,
    subjectId: row.subject_id as string,
    subjectEmail: row.subject_email as string,
    actor: row.actor as string,
    actorRole: (row.actor_role as string | null) ?? null,
    action: row.action as string,
    detail: JSON.parse((row.detail as string) || "{}") as Record<string, unknown>,
    occurredAt: row.occurred_at as string,
  }));
}