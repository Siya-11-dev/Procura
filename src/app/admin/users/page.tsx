import { bootstrap } from "@/lib/bootstrap";
import { requireRoles } from "@/lib/auth/guard";
import { getUser, listUsers } from "@/lib/auth/users";
import { listUserAudit } from "@/lib/auth/user-audit";
import { isRole } from "@/lib/auth/roles";
import { Panel, PanelHeader } from "@/components/ui";
import { UserAdminTable, type AdminUserRow } from "./user-admin-table";

export default async function AdminUsersPage() {
  await bootstrap();

  // The proxy only checks that a session exists, so the role gate happens here,
  // in the page, before any account data is read.
  const auth = await requireRoles(["admin"]);
  if (auth.error) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Panel>
          <PanelHeader title="Accounts" />
          <div className="p-5">
            <p className="text-sm text-ink-300">{auth.error.message}</p>
          </div>
        </Panel>
      </main>
    );
  }

  // Re-read the caller rather than trusting the session's role snapshot: an
  // account suspended moments ago still holds a valid JWT.
  const caller = getUser(auth.actor.id);
  if (!caller?.active || caller.role !== "admin") {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Panel>
          <PanelHeader title="Accounts" />
          <div className="p-5">
            <p className="text-sm text-ink-300">
              This account is no longer an active administrator.
            </p>
          </div>
        </Panel>
      </main>
    );
  }

  const users: AdminUserRow[] = listUsers().map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: isRole(user.role) ? user.role : "requester",
    department: user.department,
    active: user.active,
    createdAt: user.createdAt,
    isSelf: user.id === caller.id,
  }));

  const audit = listUserAudit(25);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-100">
          Accounts
        </h1>
        <p className="mt-1 text-sm text-ink-400">
          Everyone who can sign in, and the approval authority each one holds.
        </p>
      </div>

      <Panel>
        <PanelHeader
          title={`${users.length} account${users.length === 1 ? "" : "s"}`}
          hint="Sign-ups start as Requester. Promote someone here to let them approve steps or raise purchase orders."
        />
        <UserAdminTable users={users} disabledReason={null} />
      </Panel>

      <Panel>
        <PanelHeader
          title="Account history"
          hint="Append-only. Registrations, role changes and suspensions."
        />
        <div className="p-5">
          {audit.length === 0 ? (
            <p className="text-sm text-ink-500">No account changes recorded yet.</p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {audit.map((entry) => (
                <li key={entry.seq} className="py-2.5 text-sm">
                  <span className="text-ink-200">{describe(entry.action)}</span>{" "}
                  <span className="text-ink-400">{entry.subjectEmail}</span>
                  {entry.detail.from && entry.detail.to ? (
                    <span className="text-ink-500">
                      {" "}
                      ({String(entry.detail.from)} → {String(entry.detail.to)})
                    </span>
                  ) : null}
                  <span className="ml-2 text-xs text-ink-600">
                    {new Date(entry.occurredAt).toLocaleString("en-ZA")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </main>
  );
}

function describe(action: string): string {
  switch (action) {
    case "user.registered":
      return "Registered";
    case "user.role_changed":
      return "Role changed for";
    case "user.activated":
      return "Access restored for";
    case "user.deactivated":
      return "Access revoked for";
    default:
      return action;
  }
}

export const dynamic = "force-dynamic";