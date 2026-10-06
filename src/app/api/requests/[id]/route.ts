import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireAuth } from "@/lib/auth/guard";
import { getRequestBundle } from "@/lib/queries";

export async function GET(_request: Request, ctx: RouteContext<"/api/requests/[id]">) {
  await bootstrap();
  const auth = await requireAuth();
  if (auth.error) return authErrorResponse(auth.error);
  const { id } = await ctx.params;
  const bundle = getRequestBundle(id);
  if (!bundle) {
    return Response.json({ error: "Request not found." }, { status: 404 });
  }
  return Response.json(bundle);
}
