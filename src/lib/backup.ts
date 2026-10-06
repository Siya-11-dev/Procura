import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { databaseFile, getDb } from "@/lib/db/client";

/** Newest snapshots kept in data/backups before older ones are pruned. */
export const BACKUP_KEEP = 10;

const BACKUP_PATTERN = /^procura-.*\.db$/;

export interface BackupResult {
  /** Absolute path of the snapshot just written. */
  file: string;
  /** Requests inside the snapshot, read back from the copy itself. */
  requests: number;
  /** Older snapshots deleted to stay within BACKUP_KEEP. */
  pruned: number;
}

/** Snapshots live beside the database, so a temp database backs up to temp. */
export function backupDir(): string {
  return path.join(path.dirname(databaseFile()), "backups");
}

function snapshotName(stamp: string, attempt: number): string {
  return attempt === 0 ? `procura-${stamp}.db` : `procura-${stamp}-${attempt}.db`;
}

/**
 * Online snapshot via `VACUUM INTO`: SQLite copies the committed state,
 * including everything in the write-ahead log, into a brand new file without
 * stopping the application. The snapshot is then opened and read, so a backup
 * that cannot be queried fails here rather than at restore time.
 */
export function createBackup(now: Date = new Date()): BackupResult {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let attempt = 0;
  let target = path.join(dir, snapshotName(stamp, attempt));
  while (existsSync(target)) {
    target = path.join(dir, snapshotName(stamp, ++attempt));
  }

  const quoted = target.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${quoted}'`);

  const probe = new DatabaseSync(target);
  try {
    const row = probe
      .prepare("SELECT COUNT(*) AS count FROM requests")
      .get() as { count: number };
    return { file: target, requests: row.count, pruned: prune(dir) };
  } finally {
    probe.close();
  }
}

function prune(dir: string): number {
  const files = readdirSync(dir)
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort();
  const excess = files.length - BACKUP_KEEP;
  if (excess <= 0) return 0;

  for (const name of files.slice(0, excess)) {
    unlinkSync(path.join(dir, name));
  }
  return excess;
}
