"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ROLES, ROLE_LABEL, type Role } from "@/lib/auth/roles";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: string | null;
  active: boolean;
  createdAt: string;
  isSelf: boolean;
}

export function UserAdminTable({
  users,
  disabledReason,
}: {
  users: AdminUserRow[];
  disabledReason: string | null;
}) {
  if (disabledReason) {
    return (
      <div className="rounded-xl border border-warn-500/30 bg-warn-500/5 p-5">
        <p className="text-sm text-warn-500">{disabledReason}</p>
      </div>
    );
  }

  const activeAdminCount = users.filter(
    (candidate) => candidate.role === "admin" && candidate.active,
  ).length;

  return (
    <div className="divide-y divide-ink-800">
      {users.map((user) => (
        <UserRow key={user.id} user={user} activeAdminCount={activeAdminCount} />
      ))}
    </div>
  );
}

function UserRow({
  user,
  activeAdminCount,
}: {
  user: AdminUserRow;
  activeAdminCount: number;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function changeRole(nextRole: string) {
    setMessage(null);
    startTransition(async () => {
      const { changeUserRoleAction } = await import("@/app/admin/users/actions");
      const result = await changeUserRoleAction(user.id, nextRole);
      setMessage(result.message);
      router.refresh();
    });
  }

  function toggleActive() {
    setMessage(null);
    startTransition(async () => {
      const { setAccountActiveAction } = await import("@/app/admin/users/actions");
      const result = await setAccountActiveAction(user.id, !user.active);
      setMessage(result.message);
      router.refresh();
    });
  }

  const lastActiveAdmin =
    user.role === "admin" && user.active && activeAdminCount === 1;

  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-4">
      <div className="min-w-56 flex-1">
        <p className="text-sm font-medium text-ink-100">
          {user.name}
          {user.isSelf && (
            <span className="ml-2 text-xs text-ink-500">(you)</span>
          )}
        </p>
        <p className="text-xs text-ink-500">{user.email}</p>
        {user.department ? (
          <p className="text-xs text-ink-600">{user.department}</p>
        ) : null}
      </div>

      <span
        className={`rounded-full px-2.5 py-1 text-xs font-medium ${
          user.active
            ? "bg-gain-500/15 text-gain-500"
            : "bg-ink-700 text-ink-400"
        }`}
      >
        {user.active ? "Active" : "Suspended"}
      </span>

      <select
        value={user.role}
        disabled={pending || (user.isSelf && lastActiveAdmin)}
        onChange={(event) => changeRole(event.target.value)}
        aria-label={`Role for ${user.name}`}
        className="rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100 focus:border-brand-400 focus:outline-none disabled:opacity-50"
      >
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </select>

      <button
        type="button"
        disabled={pending || user.isSelf}
        onClick={toggleActive}
        className="rounded-lg border border-ink-600 px-3.5 py-2 text-sm text-ink-300 transition hover:border-ink-400 hover:text-ink-100 disabled:opacity-40 disabled:hover:border-ink-600 disabled:hover:text-ink-300"
      >
        {user.active ? "Suspend" : "Restore"}
      </button>

      {message ? (
        <p className="w-full text-xs text-ink-400">{message}</p>
      ) : null}
    </div>
  );
}