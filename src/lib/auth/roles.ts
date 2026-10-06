/**
 * Roles carried by application users.
 *
 * These map onto the roles named by the approval agent's delegation chain, so an
 * approval step can only be decided by someone holding the required role. A
 * single account may hold several roles when one person legitimately covers more
 * than one level of authority.
 */
export const ROLES = [
  "requester",
  "procurement_lead",
  "finance_director",
  "cfo",
  "ceo",
  "compliance_officer",
  "admin",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  requester: "Requester",
  procurement_lead: "Procurement Lead",
  finance_director: "Finance Director",
  cfo: "Chief Financial Officer",
  ceo: "Chief Executive Officer",
  compliance_officer: "Compliance Officer",
  admin: "Administrator",
};

/** Approval-chain role label -> the account roles allowed to decide that step. */
export const ROLE_TO_APPROVAL_STEP: Record<string, Role[]> = {
  "Procurement Lead": ["procurement_lead", "admin"],
  "Finance Director": ["finance_director", "admin"],
  "Chief Financial Officer": ["cfo", "admin"],
  "Chief Executive Officer": ["ceo", "admin"],
  "Compliance & Risk Review": ["compliance_officer", "admin"],
  Compliance: ["compliance_officer", "admin"],
  // Decided by the budget owner's office: spending past a departmental ceiling
  // is a finance decision, not a procurement one.
  "Budget Exception": ["finance_director", "cfo", "ceo", "admin"],
};

/** Roles that may create a request, alongside the dedicated requester role. */
export const REQUEST_CREATOR_ROLES: Role[] = [
  "requester",
  "procurement_lead",
  "finance_director",
  "cfo",
  "ceo",
  "admin",
];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
