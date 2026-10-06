import { BACKUP_KEEP, createBackup } from "@/lib/backup";

/**
 * Snapshot the live database into data/backups/ without stopping the app.
 *
 *   npm run db:backup
 *
 * Restore: stop the app, delete data/procura.db-wal and data/procura.db-shm,
 * then copy the chosen snapshot over data/procura.db.
 */
const result = createBackup();

console.log(`backup written : ${result.file}`);
console.log(`requests inside: ${result.requests}`);
console.log(`old backups pruned to keep the newest ${BACKUP_KEEP}: ${result.pruned}`);
console.log("");
console.log("restore:");
console.log("  1. stop the app");
console.log("  2. delete data/procura.db-wal and data/procura.db-shm");
console.log("  3. copy the snapshot over data/procura.db");
