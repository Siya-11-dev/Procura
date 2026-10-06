import { bootstrap } from "@/lib/bootstrap";
import { listRequests } from "@/lib/db/repository";
import { verifyAuditChain } from "@/lib/db/audit";
await bootstrap();
const requests = listRequests();
console.log("requests:", requests.length);
for (const r of requests) console.log(" ", r.id, r.status, "|", r.title);
const chain = verifyAuditChain();
console.log("audit entries:", chain.entries, "valid:", chain.valid);
