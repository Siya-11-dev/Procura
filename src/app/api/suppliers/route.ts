import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireAuth } from "@/lib/auth/guard";
import { listSuppliers } from "@/lib/db/repository";

export async function GET() {
  await bootstrap();
  const auth = await requireAuth();
  if (auth.error) return authErrorResponse(auth.error);
  return Response.json({ suppliers: listSuppliers() });
}
