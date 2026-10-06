import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setupTestDb } from "./helpers";
import { BACKUP_KEEP, backupDir, createBackup } from "@/lib/backup";
import {
  createRequest,
  listRequests,
  listSuppliers,
  type NewRequest,
} from "@/lib/db/repository";

setupTestDb();

const REQUEST: NewRequest = {
  title: "Task chairs for the studio",
  rawDescription: "We need 10 task chairs for the studio, black mesh.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Design",
  unit: "chair",
  quantity: 10,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

function count(file: string, table: string): number {
  const db = new DatabaseSync(file);
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

describe("database backups", () => {
  it("writes a snapshot beside the database that holds the same rows", () => {
    createRequest(REQUEST);

    const result = createBackup();

    expect(existsSync(result.file)).toBe(true);
    expect(result.file.startsWith(backupDir())).toBe(true);
    expect(result.file).toMatch(/[\\/]procura-.*\.db$/);

    expect(count(result.file, "requests")).toBe(listRequests().length);
    expect(count(result.file, "suppliers")).toBe(listSuppliers().length);
    expect(result.requests).toBe(listRequests().length);
  });

  it("prunes to the newest snapshots once the retention window is full", () => {
    for (let i = 0; i < BACKUP_KEEP + 2; i += 1) createBackup();

    const files = readdirSync(backupDir()).filter((name) =>
      name.startsWith("procura-"),
    );
    expect(files).toHaveLength(BACKUP_KEEP);
  });

  it("numbers snapshots that land in the same millisecond", () => {
    const now = new Date();
    const first = createBackup(now);
    const second = createBackup(now);

    expect(second.file).not.toBe(first.file);
    expect(existsSync(first.file)).toBe(true);
    expect(existsSync(second.file)).toBe(true);
  });
});
