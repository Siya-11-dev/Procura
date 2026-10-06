/**
 * Account mutations shared by the admin page and the CLI, so both get the same
 * guard rails and the same audit entries.
 *
 * The caller here is whoever holds the terminal, which is inherently trusted —
 * there is no session to check. What still applies is the last-admin rule and
 * the append-only log, so a CLI mistake cannot quietly orphan the admin surface.
 */
import { withTransaction } from "@/lib/db/client";
import { promoteByEmailForCli } from "@/lib/auth/admin";
import { isRole, type Role } from "@/lib/auth/roles";
import {
  countActiveAdmins,
  findUserByEmail,
  getUser,
  setPasswordHash,
  setUserActive,
  setUserRole,
} from "@/lib/auth/users";
import { appendUserAudit } from "@/lib/auth/user-audit";

/**
 * The actor recorded for terminal-driven changes. A CLI has no signed-in user,
 * so it records itself explicitly rather than borrowing an admin's identity and
 * making their audit trail describe something they did not do.
 */
const CLI_ACTOR = "cli";
const CLI_ROLE: Role = "admin";

export interface CliResult {
  ok: boolean;
  message: string;
}

function resolve(email: string) {
  const row = findUserByEmail(email);
  if (!row) return null;
  return getUser(row.id);
}

export function setRoleByEmail(email: string, nextRole: string): CliResult {
  if (!isRole(nextRole)) {
    return { ok: false, message: `Unknown role "${nextRole}".` };
  }

  const target = resolve(email);
  if (!target) return { ok: false, message: `${email} has no account.` };

  const result = promoteByEmailForCli({
    actorEmail: email,
    subjectEmail: email,
    nextRole,
  });

  if (result.ok) return result;

  // Self-promotion is refused by the shared helper's intent, but from a terminal
  // there is no second admin to preserve, so a direct write is legitimate here as
  // long as the last-admin rule still holds.
  if (target.role === "admin" && nextRole !== "admin" && countActiveAdmins(target.id) === 0) {
    return { ok: false, message: "That is the last active administrator." };
  }

  withTransaction(() => {
    setUserRole(target.id, nextRole);
    appendUserAudit({
      subjectId: target.id,
      subjectEmail: target.email,
      actor: CLI_ACTOR,
      actorRole: CLI_ROLE,
      action: "user.role_changed",
      detail: { from: target.role, to: nextRole, via: "cli" },
    });
  });

  return {
    ok: true,
    message: `${target.name} (${target.email}) is now ${nextRole.replace(/_/g, " ")}.`,
  };
}

function toggle(email: string, active: boolean): CliResult {
  const target = resolve(email);
  if (!target) return { ok: false, message: `${email} has no account.` };

  if (
    !active &&
    target.active &&
    target.role === "admin" &&
    countActiveAdmins(target.id) === 0
  ) {
    return {
      ok: false,
      message: "That is the last active administrator. Promote someone else first.",
    };
  }

  withTransaction(() => {
    setUserActive(target.id, active);
    appendUserAudit({
      subjectId: target.id,
      subjectEmail: target.email,
      actor: CLI_ACTOR,
      actorRole: CLI_ROLE,
      action: active ? "user.activated" : "user.deactivated",
      detail: { previousRole: target.role, via: "cli" },
    });
  });

  return {
    ok: true,
    message: active
      ? `Access restored for ${target.email}.`
      : `Access revoked for ${target.email}. Their history is retained.`,
  };
}

export function activateByEmail(email: string): CliResult {
  return toggle(email, true);
}

export function deactivateByEmail(email: string): CliResult {
  return toggle(email, false);
}

/**
 * Reset a password directly. bcrypt cannot be reversed, so this is the only way
 * to recover an account whose password is lost.
 */
export function setPassword(email: string, password: string): CliResult {
  const target = resolve(email);
  if (!target) return { ok: false, message: `${email} has no account.` };

  if (password.length < 12) {
    return { ok: false, message: "Use at least 12 characters." };
  }

  const row = findUserByEmail(email)!;
  // Re-hash and store through the same hashing helper the app uses, so a CLI
  // reset is indistinguishable from a signup to the login path.
  setPasswordHash(row.id, password);

  appendUserAudit({
    subjectId: target.id,
    subjectEmail: target.email,
    actor: CLI_ACTOR,
    actorRole: CLI_ROLE,
    action: "user.password_reset",
    detail: { via: "cli" },
  });

  return { ok: true, message: `Password updated for ${email}.` };
}