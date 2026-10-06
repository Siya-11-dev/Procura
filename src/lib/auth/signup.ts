import { z } from "zod";
import { withTransaction } from "@/lib/db/client";
import { createUser, emailTaken, type User } from "./users";
import { appendUserAudit } from "./user-audit";

/**
 * Self-service registration.
 *
 * The one invariant this module exists to enforce: a signup always produces a
 * `requester`, no matter what the request body claims. Approval authority is
 * what makes the pipeline meaningful, and if an anonymous POST could grant
 * itself `ceo` then the whole approval chain would be advisory. The submitted
 * role is deliberately not read from the form at all rather than validated,
 * because a validation rule is one refactor away from becoming optional.
 *
 * Promotion is a separate, admin-only action in `src/app/admin/users`.
 */

export const SIGNUP_ROLE = "requester" as const;

/**
 * Password policy. Length is the dominant factor in practice, so the floor is
 * 12 rather than the 8 the login schema accepts: login must keep admitting
 * older accounts, signup should not keep creating weak ones.
 */
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(200, "That password is too long.");

export const signupSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name.").max(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .max(254),
  password: passwordSchema,
  department: z.string().trim().max(120).optional(),
});

export type SignupResult =
  | { ok: true; user: User }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Register an account and record that it happened.
 *
 * The two writes share a transaction: a user row with no registration entry
 * would be an account whose origin cannot be explained, and an unexplained
 * account holding approval authority is the thing worth catching.
 */
export function signupUser(raw: {
  name: unknown;
  email: unknown;
  password: unknown;
  department?: unknown;
  /** Accepted and ignored. Present so a caller cannot be surprised by its absence. */
  role?: unknown;
}): SignupResult {
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");
      // First issue per field wins: showing "too short" under "too weak" is noise.
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, error: "Check the highlighted fields.", fieldErrors };
  }

  const { name, email, password, department } = parsed.data;

  if (emailTaken(email)) {
    // Stated plainly rather than hidden behind a generic failure: unlike a login
    // attempt, this is not an attempt to defeat someone guessing a credential.
    // Preventing enumeration of the existing user list is a separate concern.
    return {
      ok: false,
      error: "An account already exists for that email address.",
      fieldErrors: { email: "Already registered." },
    };
  }

  try {
    const user = withTransaction(() => {
      const created = createUser({
        name,
        email,
        // Hardcoded. Not `raw.role`, not a validated field: the constant is the
        // whole point of this function.
        role: SIGNUP_ROLE,
        password,
        department: department || null,
      });

      // Self-registered, so the actor is the account itself. It has no authority
      // yet, which is exactly what `actorRole: requester` records.
      appendUserAudit({
        subjectId: created.id,
        subjectEmail: created.email,
        actor: created.id,
        actorRole: SIGNUP_ROLE,
        action: "user.registered",
        detail: { name: created.name, role: SIGNUP_ROLE },
      });

      return created;
    });
    return { ok: true, user };
  } catch (error) {
    // A concurrent signup for the same address loses the UNIQUE race here. That
    // is the same outcome as the check above, not an internal failure.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return {
        ok: false,
        error: "An account already exists for that email address.",
        fieldErrors: { email: "Already registered." },
      };
    }
    throw error;
  }
}