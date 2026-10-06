import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireRoles } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import { appendAudit } from "@/lib/db/audit";
import { runSourcingPipeline } from "@/lib/pipeline";

const RERUN_ROLES: readonly Role[] = ["procurement_lead", "admin"];

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/requests/[id]/rerun">,
) {
  await bootstrap();
  const auth = await requireRoles(RERUN_ROLES);
  if (auth.error) return authErrorResponse(auth.error);

  const { id } = await ctx.params;
  appendAudit({
    requestId: id,
    actor: auth.actor.id,
    actorRole: auth.actor.role,
    action: "request.rerun",
    entityType: "request",
    entityId: id,
    detail: {},
  });
  const result = await runSourcingPipeline(id, {
    id: auth.actor.id,
    name: auth.actor.name,
    role: auth.actor.role,
  });
  return Response.json(result, { status: result.error ? 500 : 200 });
}
