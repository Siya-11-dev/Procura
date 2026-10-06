import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA, runMigrations } from "./schema";

const DB_DIR = path.join(process.cwd(), "data");

declare global {
  var __procuraDb: DatabaseSync | undefined;
}

/**
 * Depth of the currently open transaction on this connection. Tracked here
 * rather than asked of SQLite because a nested call has to join the outer
 * transaction via a savepoint instead of issuing a second BEGIN.
 */
let transactionDepth = 0;

// Tests point PROCURA_DB_PATH at a temporary file so a run never touches the
// developer's working database. Node caches the handle on globalThis, so the
// override is only honoured on first open.
function dbPath(): string {
  return process.env.PROCURA_DB_PATH ?? path.join(DB_DIR, "procura.db");
}

function open(): DatabaseSync {
  const target = dbPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Wait for a competing writer rather than failing immediately. Without this,
  // two concurrent writers surface as SQLITE_BUSY the moment one holds the
  // write lock, which is exactly the case BEGIN IMMEDIATE below creates.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  runMigrations(db);
  transactionDepth = 0;
  return db;
}

/**
 * Release the connection so the file can be deleted or reopened elsewhere.
 * Scripts that run against a temporary database must call this before removing
 * it; Windows refuses to unlink a file that is still open.
 */
export function closeDb(): void {
  if (globalThis.__procuraDb) {
    globalThis.__procuraDb.close();
    globalThis.__procuraDb = undefined;
  }
  transactionDepth = 0;
}

/** Pointed at a fresh path (used by tests); reopens the database cleanly. */
export function resetDbForTests(pathValue: string): void {
  process.env.PROCURA_DB_PATH = pathValue;
  closeDb();
}

export function getDb(): DatabaseSync {
  if (!globalThis.__procuraDb) {
    globalThis.__procuraDb = open();
  }
  return globalThis.__procuraDb;
}

export function inTransaction(): boolean {
  return transactionDepth > 0;
}

/**
 * Run `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * Synchronous by design, because the driver is synchronous and because holding a
 * write lock across an `await` would block every other writer for the duration
 * of a network call. Every agent follows the same shape for this reason: all of
 * its writes finish before it awaits anything, so the write burst can be wrapped
 * whole and the lock is only ever held for microseconds.
 *
 * Uses BEGIN IMMEDIATE so the write lock is taken up front. That is what makes
 * the audit chain safe to extend: a read-then-append of the previous hash cannot
 * interleave with another writer, because the second one blocks at BEGIN until
 * the first has committed.
 *
 * Nested calls join the outer transaction through a savepoint, so a helper can
 * be wrapped by its caller without either having to know about the other.
 */
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  const nested = transactionDepth > 0;
  const savepoint = `procura_sp_${transactionDepth}`;

  if (nested) {
    db.exec(`SAVEPOINT ${savepoint}`);
  } else {
    db.exec("BEGIN IMMEDIATE");
  }
  transactionDepth += 1;

  let result: T;
  try {
    result = fn();
  } catch (error) {
    transactionDepth -= 1;
    try {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
    } catch {
      // The transaction was already unwound by SQLite; the original error is
      // the one worth surfacing.
    }
    throw error;
  }

  transactionDepth -= 1;
  if (nested) {
    db.exec(`RELEASE ${savepoint}`);
  } else {
    db.exec("COMMIT");
  }
  return result;
}
