/**
 * The organisation's departments. Used for the request form's department picker
 * and for new account registrations, so one source of truth stays in sync with
 * the departments the requester agent is told to expect.
 */
export const DEPARTMENTS = [
  "Design",
  "Engineering",
  "Executive",
  "Facilities",
  "Finance",
  "Legal",
  "Marketing",
  "People Operations",
  "Procurement",
  "Product & Design",
  "Risk & Compliance",
  "Sales",
  "Technology",
] as const;

export type Department = (typeof DEPARTMENTS)[number];

export function isDepartment(value: unknown): value is Department {
  return (
    typeof value === "string" &&
    (DEPARTMENTS as readonly string[]).includes(value)
  );
}