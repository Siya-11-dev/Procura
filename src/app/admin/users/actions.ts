"use server";

import { revalidatePath } from "next/cache";
import { requireRoles } from "@/lib/auth/guard";
import {
  changeUserRole,
  setAccountActive,
  type AdminResult,
} from "@/lib/auth/admin";

const ADMIN_ROLES = ["admin"] as const;

/**
 * Server actions for the account table.
 *
 * `requireRoles` is the coarse gate; the library functions re-check the caller
 * against the database. Both run on every call, so neither can be forgotten by a
 * later caller the way an in-page check could.
 *
 * Cache revalidation lives here rather than in the library so the CLI can share
 * that code without loading next/cache.
 */
export async function changeUserRoleAction(
  userId: string,
  nextRole: string,
): Promise<AdminResult> {
  const auth = await requireRoles(ADMIN_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const result = await changeUserRole(auth.actor, userId, nextRole);
  if (result.ok) revalidatePath("/admin/users");
  return result;
}

export async function setAccountActiveAction(
  userId: string,
  active: boolean,
): Promise<AdminResult> {
  const auth = await requireRoles(ADMIN_ROLES);
  if (auth.error) return { ok: false, message: auth.error.message };

  const result = await setAccountActive(auth.actor, userId, active);
  if (result.ok) revalidatePath("/admin/users");
  return result;
}