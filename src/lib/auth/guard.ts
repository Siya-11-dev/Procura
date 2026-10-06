import { auth } from "@/auth";
import { ROLE_LABEL, isRole, type Role } from "./roles";

/** HTTP response for a failed auth check, for use by route handlers. */
export function authErrorResponse(error: { status: 401 | 403; message: string }): Response {
  return Response.json({ error: error.message }, { status: error.status });
}

export interface SessionActor {
  id: string;
  name: string;
  role: Role;
  email: string;
}

export interface AuthFailure {
  /** Matches an HTTP status: 401 unauthenticated, 403 unauthorised. */
  status: 401 | 403;
  message: string;
}

export type AuthResult = { actor: SessionActor; error: null } | { actor: null; error: AuthFailure };

/**
 * Resolve the current session into a trusted actor, never trusting anything the
 * client passed in. Every server action and API route starts with this.
 */
export async function requireAuth(): Promise<AuthResult> {
  const session = await auth();
  const user = session?.user;
  if (!user?.email) {
    return { actor: null, error: { status: 401, message: "Sign in to continue." } };
  }
  const role = isRole(user.role) ? user.role : "requester";
  return {
    actor: {
      id: (user.id as string) ?? user.email,
      name: user.name ?? user.email,
      role,
      email: user.email,
    },
    error: null,
  };
}

const ALL_ROLES = new Set<string>([
  "requester",
  "procurement_lead",
  "finance_director",
  "cfo",
  "ceo",
  "compliance_officer",
  "admin",
]);

/**
 * Gate that limits an action to a set of roles. Protecting data implies knowing
 * who is allowed to touch it, so an explicit allow-list is required everywhere
 * except plain "any signed-in employee may act" cases.
 */
export async function requireRoles(allowed: readonly Role[]): Promise<AuthResult> {
  const base = await requireAuth();
  if (base.error) return base;

  const actor = base.actor;
  if (!allowed.includes(actor.role)) {
    const wanted = allowed.map((role) => ROLE_LABEL[role]).join(" or ");
    return {
      actor: null,
      error: {
        status: 403,
        message: `Your role (${ROLE_LABEL[actor.role]}) cannot do this. This action is limited to ${wanted}.`,
      },
    };
  }
  return { actor, error: null };
}

export function rolesLabel(roles: readonly Role[]): string {
  return roles.map((role) => ROLE_LABEL[role]).join(", ");
}

export { ALL_ROLES };