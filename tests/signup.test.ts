import { describe, it, expect } from "vitest";
import { setupTestDb } from "./helpers";
import { signupUser, SIGNUP_ROLE } from "@/lib/auth/signup";
import { changeUserRole, setAccountActive } from "@/lib/auth/admin";
import {
  createUser,
  findUserByEmail,
  getUser,
  setUserRole,
  verifyPassword,
} from "@/lib/auth/users";
import { listUserAudit } from "@/lib/auth/user-audit";
import { getDb } from "@/lib/db/client";

setupTestDb();

const GOOD = {
  name: "Thandiwe Mokoena",
  email: "new.person@procura.co.za",
  password: "a-long-enough-password",
};

describe("signup", () => {
  it("creates an active requester account", () => {
    const result = signupUser(GOOD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.user.role).toBe("requester");
    expect(result.user.active).toBe(true);

    const stored = getUser(result.user.id);
    expect(stored?.role).toBe(SIGNUP_ROLE);
    expect(stored?.active).toBe(true);
  });

  it("stores the password hashed, never in the clear", () => {
    const result = signupUser(GOOD);
    expect(result.ok).toBe(true);

    const row = findUserByEmail(GOOD.email)!;
    expect(row.password_hash).not.toContain(GOOD.password);
    expect(verifyPassword(row.password_hash, GOOD.password)).toBe(true);
    expect(verifyPassword(row.password_hash, "wrong-password-entirely")).toBe(false);
  });

  // The property that matters most: an anonymous POST must not be able to grant
  // itself approval authority, no matter what it sends.
  it.each([
    "ceo",
    "admin",
    "cfo",
    "finance_director",
    "procurement_lead",
    "compliance_officer",
  ])("ignores a submitted role of %s", (claimed) => {
    const result = signupUser({ ...GOOD, email: `x-${claimed}@procura.co.za`, role: claimed });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = getUser(result.user.id);
    expect(stored?.role).toBe("requester");
  });

  it("refuses a duplicate email", () => {
    expect(signupUser(GOOD).ok).toBe(true);
    const second = signupUser({ ...GOOD, name: "Someone Else" });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.fieldErrors?.email).toBeDefined();
  });

  it.each([
    ["short password", { ...GOOD, password: "short" }],
    ["invalid email", { ...GOOD, email: "not-an-email" }],
    ["blank name", { ...GOOD, name: "  " }],
  ])("rejects %s", (_label, input) => {
    const result = signupUser(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors ?? {}).length).toBeGreaterThan(0);
  });

  it("records the registration in the account log", () => {
    const result = signupUser(GOOD);
    expect(result.ok).toBe(true);

    const entries = listUserAudit();
    const registration = entries.find((entry) => entry.action === "user.registered");
    expect(registration).toBeDefined();
    expect(registration?.subjectEmail).toBe(GOOD.email);
    expect(registration?.detail.role).toBe("requester");
  });

  it("leaves no account behind when the audit write fails", () => {
    getDb().exec("DROP TABLE user_audit");

    expect(() => signupUser(GOOD)).toThrow();

    // The transaction has to undo the insert too, not just the log entry.
    expect(findUserByEmail(GOOD.email)).toBeNull();
  });

  it("does not write to the request-scoped audit chain", () => {
    signupUser(GOOD);
    // audit_log.request_id is a foreign key to requests(id), so a registration
    // cannot and must not appear there.
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as {
      n: number;
    };
    expect(row.n).toBe(0);
  });
});

describe("role administration", () => {
  it("lets an active admin promote a signup to an approver", async () => {
    const admin = createUser({
      email: "admin@procura.co.za",
      name: "Admin",
      role: "admin",
      password: "a-long-enough-password",
    });
    const signup = signupUser(GOOD)!;
    if (!signup.ok) throw new Error("expected signup to succeed");

    const result = await changeUserRole(
      { id: admin.id, name: "Admin", role: "admin", email: admin.email },
      signup.user.id,
      "cfo",
    );

    expect(result.ok).toBe(true);
    expect(getUser(signup.user.id)?.role).toBe("cfo");
  });

  it("refuses a non-admin", async () => {
    const lead = createUser({
      email: "lead@procura.co.za",
      name: "Lead",
      role: "procurement_lead",
      password: "a-long-enough-password",
    });
    const target = signupUser(GOOD)!;
    if (!target.ok) throw new Error("expected signup to succeed");

    const result = await changeUserRole(
      { id: lead.id, name: "Lead", role: "procurement_lead", email: lead.email },
      target.user.id,
      "ceo",
    );

    expect(result.ok).toBe(false);
    expect(getUser(target.user.id)?.role).toBe("requester");
  });

  it("refuses a caller who has since been demoted, despite a valid session", async () => {
    const demoted = createUser({
      email: "was-admin@procura.co.za",
      name: "Was Admin",
      role: "admin",
      password: "a-long-enough-password",
    });
    const target = signupUser(GOOD)!;
    if (!target.ok) throw new Error("expected signup to succeed");

    // Demoted after signing in. The actor passed below still claims admin,
    // which is exactly the stale snapshot a JWT carries until it expires.
    setUserRole(demoted.id, "requester");

    const result = await changeUserRole(
      {
        id: demoted.id,
        name: "Was Admin",
        role: "admin",
        email: demoted.email,
      },
      target.user.id,
      "cfo",
    );

    expect(result.ok).toBe(false);
    expect(getUser(target.user.id)?.role).toBe("requester");
  });

  it("refuses an unknown role", async () => {
    const admin = createUser({
      email: "admin2@procura.co.za",
      name: "Admin",
      role: "admin",
      password: "a-long-enough-password",
    });
    const target = signupUser(GOOD)!;
    if (!target.ok) throw new Error("expected signup to succeed");

    const result = await changeUserRole(
      { id: admin.id, name: "Admin", role: "admin", email: admin.email },
      target.user.id,
      "superuser",
    );

    expect(result.ok).toBe(false);
    expect(getUser(target.user.id)?.role).toBe("requester");
  });

  it("stops an admin from demoting themselves", async () => {
    const admin = createUser({
      email: "self@procura.co.za",
      name: "Self",
      role: "admin",
      password: "a-long-enough-password",
    });

    const result = await changeUserRole(
      { id: admin.id, name: "Self", role: "admin", email: admin.email },
      admin.id,
      "requester",
    );

    expect(result.ok).toBe(false);
    expect(getUser(admin.id)?.role).toBe("admin");
  });

  it("refuses to remove the last active administrator", async () => {
    const first = createUser({
      email: "only-admin@procura.co.za",
      name: "Only Admin",
      role: "admin",
      password: "a-long-enough-password",
    });

    // No second admin exists, so this is the last one.
    const result = await changeUserRole(
      { id: first.id, name: "Only Admin", role: "admin", email: first.email },
      first.id,
      "requester",
    );

    expect(result.ok).toBe(false);
    expect(getUser(first.id)?.role).toBe("admin");
  });

  it("allows a demotion once a second admin exists", async () => {
    const first = createUser({
      email: "admin-a@procura.co.za",
      name: "Admin A",
      role: "admin",
      password: "a-long-enough-password",
    });
    const second = createUser({
      email: "admin-b@procura.co.za",
      name: "Admin B",
      role: "admin",
      password: "a-long-enough-password",
    });

    const result = await changeUserRole(
      { id: second.id, name: "Admin B", role: "admin", email: second.email },
      first.id,
      "requester",
    );

    expect(result.ok).toBe(true);
    expect(getUser(first.id)?.role).toBe("requester");
  });

  it("stops an admin from suspending themselves", async () => {
    const admin = createUser({
      email: "suspend-self@procura.co.za",
      name: "Suspend Self",
      role: "admin",
      password: "a-long-enough-password",
    });

    const result = await setAccountActive(
      { id: admin.id, name: "Suspend Self", role: "admin", email: admin.email },
      admin.id,
      false,
    );

    expect(result.ok).toBe(false);
    expect(getUser(admin.id)?.active).toBe(true);
  });

  it("suspends an account without touching its history", async () => {
    const admin = createUser({
      email: "admin3@procura.co.za",
      name: "Admin",
      role: "admin",
      password: "a-long-enough-password",
    });
    const target = signupUser(GOOD)!;
    if (!target.ok) throw new Error("expected signup to succeed");

    const result = await setAccountActive(
      { id: admin.id, name: "Admin", role: "admin", email: admin.email },
      target.user.id,
      false,
    );

    expect(result.ok).toBe(true);
    const stored = getUser(target.user.id);
    expect(stored?.active).toBe(false);
    // The account and its audit trail survive; only sign-in is refused.
    expect(stored?.email).toBe(GOOD.email);
    expect(
      listUserAudit().some((entry) => entry.subjectId === target.user.id),
    ).toBe(true);
  });

  it("records every role change with who made it", async () => {
    const admin = createUser({
      email: "admin4@procura.co.za",
      name: "Admin",
      role: "admin",
      password: "a-long-enough-password",
    });
    const target = signupUser(GOOD)!;
    if (!target.ok) throw new Error("expected signup to succeed");

    await changeUserRole(
      { id: admin.id, name: "Admin", role: "admin", email: admin.email },
      target.user.id,
      "procurement_lead",
    );

    const entry = listUserAudit().find((row) => row.action === "user.role_changed");
    expect(entry?.actor).toBe(admin.id);
    expect(entry?.detail.from).toBe("requester");
    expect(entry?.detail.to).toBe("procurement_lead");
  });
});

describe("account audit log", () => {
  it("forbids updates and deletes at the storage layer", () => {
    signupUser(GOOD);
    const db = getDb();

    expect(() =>
      db.prepare("UPDATE user_audit SET action = 'tampered'").run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM user_audit").run()).toThrow(/append-only/);
  });
});