import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireAuth } from "@/lib/auth/guard";
import { decideApproval } from "@/lib/pipeline";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/requests/[id]/approvals">,
) {
  await bootstrap();
  const auth = await requireAuth();
  if (auth.error) return authErrorResponse(auth.error);
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const stepId = typeof body.stepId === "string" ? body.stepId : "";
  if (!stepId) {
    return Response.json({ error: "stepId is required." }, { status: 422 });
  }

  const result = await decideApproval(
    id,
    stepId,
    body.decision === "rejected" ? "rejected" : "approved",
    typeof body.note === "string" ? body.note : "",
    {
      id: auth.actor.id,
      name: auth.actor.name,
      role: auth.actor.role,
    },
  );

  const status = !result.ok
    ? result.code === "forbidden"
      ? 403
      : 409
    : 200;
  return Response.json(result, { status });
}
