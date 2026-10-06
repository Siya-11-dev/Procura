/**
 * Create, promote, suspend or recover a user from the terminal.
 *
 * Exists so test roles can be set up without clicking through the admin page,
 * and so access can be recovered if the last admin is locked out. Every mutation
 * goes through the same library code the admin UI uses, so the guard rails and
 * the append-only account log apply identically.
 *
 *   npm run user:create -- --list
 *   npm run user:create -- --email you@co.za --name "Your Name" --role cfo
 *   npm run user:create -- --email you@co.za --role admin
 *   npm run user:create -- --email you@co.za --deactivate
 *   npm run user:create -- --email you@co.za --activate
 *   npm run user:create -- --email you@co.za --password "new-password"
 *
 * Note there is no --role on a signup: `--role` here is a deliberate terminal
 * act, not something a browser form can do.
 */
import { bootstrap } from "@/lib/bootstrap";
import { createUser, findUserByEmail, listUsers } from "@/lib/auth/users";
import { appendUserAudit } from "@/lib/auth/user-audit";
import { isRole, type Role } from "@/lib/auth/roles";
import { withTransaction } from "@/lib/db/client";
import {
  activateByEmail,
  deactivateByEmail,
  setPassword,
  setRoleByEmail,
  type CliResult,
} from "./lib/user-admin";

const CLI_ACTOR = "cli";

function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function stop(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function report(result: CliResult): never {
  if (result.ok) {
    console.log(`\n  ${result.message}\n`);
    process.exit(0);
  }
  stop(result.message);
}

const args = parseArgs(process.argv.slice(2));

await bootstrap();

if (args.list) {
  const users = listUsers();
  console.log(`\n  ${users.length} account${users.length === 1 ? "" : "s"}:\n`);
  for (const user of users) {
    const state = user.active ? "active" : "suspended";
    console.log(
      `  ${user.email.padEnd(38)} ${user.role.padEnd(20)} ${state.padEnd(10)} ${user.name}`,
    );
  }
  console.log("");
  process.exit(0);
}

const rawEmail = typeof args.email === "string" ? args.email.toLowerCase().trim() : "";
if (!rawEmail.includes("@") || rawEmail.length > 254) {
  stop("Provide --email with a valid address.");
}
const email = rawEmail;

const existing = findUserByEmail(email);

if (args.deactivate) report(deactivateByEmail(email));
if (args.activate) report(activateByEmail(email));

const role = typeof args.role === "string" ? args.role : null;
if (role !== null && !isRole(role)) {
  stop(`Unknown role "${role}". Run with --list to see valid ones.`);
}
const newRole: Role = isRole(role) ? role : "requester";

const suppliedPassword =
  typeof args.password === "string" ? args.password : null;
if (args.password === true) {
  stop('--password needs a value, e.g. --password "my-long-password".');
}

if (existing) {
  // An existing account is only ever modified, never recreated, so its history
  // and any audit references stay intact. Each requested change is applied in
  // turn and the first failure stops, so a partial command cannot look complete.
  if (suppliedPassword) report(setPassword(email, suppliedPassword));
  if (role) report(setRoleByEmail(email, newRole));
  if (!suppliedPassword && !role) {
    stop(`${email} already exists. Pass --password, --role, --activate or --deactivate.`);
  }
}

const password = suppliedPassword ?? "Procura!2026";
if (password.length < 12) {
  stop("Passwords must be at least 12 characters.");
}

const name =
  typeof args.name === "string" ? args.name : email.split("@")[0].replace(/[._]/g, " ");
const department = typeof args.department === "string" ? args.department : null;

const created = withTransaction(() => {
  const user = createUser({
    email,
    // A name is required by the schema. Falling back to the local part of the
    // address keeps the CLI usable without --name, but it reads badly in the
    // audit trail, so prefer passing it.
    name: name || "Unnamed user",
    role: newRole,
    password,
    department,
  });
  appendUserAudit({
    subjectId: user.id,
    subjectEmail: user.email,
    actor: CLI_ACTOR,
    actorRole: newRole,
    action: "user.registered",
    detail: { name: user.name, role: newRole, via: "cli" },
  });
  return user;
});

console.log(
  `\n  Created ${created.email} as ${newRole}.\n  Sign in at /login using the password you provided.\n`,
);