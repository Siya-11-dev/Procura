import { withTransaction } from "@/lib/db/client";
import { isRole, type Role } from "@/lib/auth/roles";
import {
  countActiveAdmins,
  findUserByEmail,
  getUser,
  setUserActive,
  setUserRole,
} from "@/lib/auth/users";
import { appendUserAudit } from "@/lib/auth/user-audit";
import type { SessionActor } from "@/lib/auth/guard";

/**
 * Account administration.
 *
 * Every action re-authorises the caller against the database rather than the
 * session. The role in a JWT is a snapshot from sign-in, so an admin who has
 * since been demoted or suspended would otherwise keep administering accounts
 * until their token expired.
 *
 * The guard rules exist to stop one accident: the last active admin removing
 * their own authority and leaving nobody able to restore it.
 */

export interface AdminResult {
  ok: boolean;
  message: string;
}

export async function changeUserRole(
  actor: SessionActor,
  userId: string,
  nextRole: string,
): Promise<AdminResult> {
  if (!isRole(nextRole)) {
    return { ok: false, message: "That is not a valid role." };
  }

  const target = getUser(userId);
  if (!target) return { ok: false, message: "Account not found." };

  const caller = getUser(actor.id);
  if (!caller || !caller.active || caller.role !== "admin") {
    return { ok: false, message: "Only an active administrator can change roles." };
  }

  if (target.id === caller.id && nextRole !== "admin") {
    return {
      ok: false,
      message: "You cannot remove your own administrator role.",
    };
  }

  if (target.role === "admin" && nextRole !== "admin") {
    // The person doing the demotion is an active admin and is not the target,
    // so one other admin always remains. Guarded because it is the one change
    // that can orphan the whole admin surface.
    if (countActiveAdmins(target.id) === 0) {
      return {
        ok: false,
        message: "That is the last active administrator. Promote someone else first.",
      };
    }
  }

  withTransaction(() => {
    setUserRole(target.id, nextRole);
    appendUserAudit({
      subjectId: target.id,
      subjectEmail: target.email,
      actor: caller.id,
      actorRole: caller.role,
      action: "user.role_changed",
      detail: { from: target.role, to: nextRole },
    });
  });

  // Cache revalidation is left to the caller: this module is also loaded by the
  // CLI, where importing next/cache would drag the framework in for nothing.
  return {
    ok: true,
    message: `${target.name} is now ${nextRole.replace(/_/g, " ")}.`,
  };
}

export async function setAccountActive(
  actor: SessionActor,
  userId: string,
  active: boolean,
): Promise<AdminResult> {
  const target = getUser(userId);
  if (!target) return { ok: false, message: "Account not found." };

  const caller = getUser(actor.id);
  if (!caller || !caller.active || caller.role !== "admin") {
    return { ok: false, message: "Only an active administrator can do this." };
  }

  if (target.id === caller.id && !active) {
    return { ok: false, message: "You cannot suspend your own account." };
  }

  if (!active && target.role === "admin" && countActiveAdmins(target.id) === 0) {
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
      actor: caller.id,
      actorRole: caller.role,
      action: active ? "user.activated" : "user.deactivated",
      detail: { previousRole: target.role },
    });
  });

  return {
    ok: true,
    message: active
      ? `${target.name}'s access was restored.`
      : `${target.name}'s access was revoked. Their history is retained.`,
  };
}

/**
 * CLI helper, exposed so the terminal tool and the page share one path.
 * Actor is the named admin, resolved by email rather than trusted as input.
 */
export function promoteByEmailForCli(input: {
  actorEmail: string;
  subjectEmail: string;
  nextRole: Role;
}): AdminResult {
  const callerRow = findUserByEmail(input.actorEmail);
  const caller = callerRow ? getUser(callerRow.id) : null;
  if (!caller || !caller.active || caller.role !== "admin") {
    return {
      ok: false,
      message: `${input.actorEmail} is not an active administrator.`,
    };
  }

  const subjectRow = findUserByEmail(input.subjectEmail);
  const target = subjectRow ? getUser(subjectRow.id) : null;
  if (!target) return { ok: false, message: `${input.subjectEmail} has no account.` };

  if (target.role === "admin" && input.nextRole !== "admin" && countActiveAdmins(target.id) === 0) {
    return { ok: false, message: "That is the last active administrator." };
  }

  withTransaction(() => {
    setUserRole(target.id, input.nextRole);
    appendUserAudit({
      subjectId: target.id,
      subjectEmail: target.email,
      actor: caller.id,
      actorRole: caller.role,
      action: "user.role_changed",
      detail: { from: target.role, to: input.nextRole, via: "cli" },
    });
  });

  return {
    ok: true,
    message: `${target.name} (${target.email}) is now ${input.nextRole.replace(/_/g, " ")}.`,
  };
}