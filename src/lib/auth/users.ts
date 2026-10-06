import { compareSync, hashSync } from "bcryptjs";
import { getDb } from "@/lib/db/client";
import { newId, nowIso } from "@/lib/util";
import { isRole, type Role } from "./roles";
import { DEMO_PASSWORD } from "./demo-password";

export { DEMO_PASSWORD };

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: string | null;
  active: boolean;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  password_hash: string;
  active: number;
  created_at: string;
}

function toUser(row: UserRow): User {
  // A row with an unrecognised role is surfaced as the least privileged role
  // rather than trusted, so a bad seed or manual edit fails closed.
  const role = isRole(row.role) ? row.role : "requester";
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    department: row.department,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function findUserByEmail(email: string): UserRow | null {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) as UserRow | undefined;
  return row ?? null;
}

export function getUser(id: string): User | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
  return row ? toUser(row) : null;
}

export function listUsers(): User[] {
  const rows = getDb()
    .prepare("SELECT * FROM users ORDER BY name")
    .all() as unknown as UserRow[];
  return rows.map(toUser);
}

export function verifyPassword(hashValue: string, password: string): boolean {
  try {
    return compareSync(password, hashValue);
  } catch {
    return false;
  }
}

export function hashPassword(password: string): string {
  return hashSync(password, 12);
}

export function createUser(input: {
  email: string;
  name: string;
  role: Role;
  password: string;
  department?: string | null;
}): User {
  const id = newId("usr");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, name, role, department, password_hash, active, created_at)
       VALUES (?,?,?,?,?,?,1,?)`,
    )
    .run(
      id,
      input.email.toLowerCase().trim(),
      input.name,
      input.role,
      input.department ?? null,
      hashPassword(input.password),
      now,
    );
  return { ...input, id, department: input.department ?? null, active: true, createdAt: now };
}

export function emailTaken(email: string): boolean {
  return getDb()
    .prepare("SELECT 1 AS present FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) !== undefined;
}

/** Replace a stored password hash. Used only by the CLI recovery path. */
export function setPasswordHash(id: string, password: string): boolean {
  return (
    getDb()
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(password), id).changes > 0
  );
}

/** Move an account between roles. Used only by the admin surface. */
export function setUserRole(id: string, role: Role): boolean {
  return (
    getDb().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id)
      .changes > 0
  );
}

/**
 * Enable or disable an account. A disabled account keeps its history and its
 * audit entries but can no longer authenticate, so revoking access never
 * erases who did what.
 */
export function setUserActive(id: string, active: boolean): boolean {
  return (
    getDb()
      .prepare("UPDATE users SET active = ? WHERE id = ?")
      .run(active ? 1 : 0, id).changes > 0
  );
}

export function countActiveAdmins(excludingUserId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    )
    .get(excludingUserId) as { n: number };
  return row.n;
}

/**
 * Demo accounts, one per role. The password is fixed and public by design so the
 * seeded dataset stays reproducible; a real deployment must override it and
 * source credentials from the identity provider instead.
 */
const DEMO_USERS: { email: string; name: string; role: Role; department: string }[] = [
  {
    // Not one of the demo personas: this account exists so a fresh database has
    // someone who can reach /admin/users and promote a self-registered account.
    // Seeding it last keeps the demo roles listed first on the page.
    email: "admin@procura.co.za",
    name: "Platform Administrator",
    role: "admin",
    department: "IT & Systems",
  },
  {
    email: "nomsa.khumalo@procura.co.za",
    name: "Nomsa Khumalo",
    role: "procurement_lead",
    department: "Procurement",
  },
  {
    email: "riaan.steyn@procura.co.za",
    name: "Riaan Steyn",
    role: "finance_director",
    department: "Finance",
  },
  {
    email: "thandiwe.mokoena@procura.co.za",
    name: "Thandiwe Mokoena",
    role: "cfo",
    department: "Finance",
  },
  {
    email: "daniel.fischer@procura.co.za",
    name: "Daniel Fischer",
    role: "ceo",
    department: "Executive",
  },
  {
    email: "lerato.mabaso@procura.co.za",
    name: "Lerato Mabaso",
    role: "compliance_officer",
    department: "Risk & Compliance",
  },
  {
    email: "amahle.dlamini@procura.co.za",
    name: "Amahle Dlamini",
    role: "requester",
    department: "Product & Design",
  },
];

export function seedUsers(): void {
  // Inserted one at a time and skipped if present, rather than bailing out when
  // any user exists. An early return would mean a database seeded before the admin
  // account was added could never acquire one, which would leave a deployment
  // with no way to promote anybody.
  for (const user of DEMO_USERS) {
    if (emailTaken(user.email)) continue;
    createUser({ ...user, password: DEMO_PASSWORD });
  }
}
