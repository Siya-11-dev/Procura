import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireRoles } from "@/lib/auth/guard";
import type { Role } from "@/lib/auth/roles";
import { getPurchaseOrder } from "@/lib/db/repository";
import { submitInvoice } from "@/lib/pipeline";
import { round, todayIso } from "@/lib/util";

const INVOICE_ROLES: readonly Role[] = ["finance_director", "cfo", "admin"];

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/requests/[id]/invoice">,
) {
  await bootstrap();
  const auth = await requireRoles(INVOICE_ROLES);
  if (auth.error) return authErrorResponse(auth.error);
  const { id } = await ctx.params;

  const po = getPurchaseOrder(id);
  if (!po) {
    return Response.json(
      { error: "No purchase order has been issued for this request." },
      { status: 409 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const invoiceNumber =
    typeof body.invoiceNumber === "string" ? body.invoiceNumber.trim() : "";
  const invoiceAmount = Number(body.invoiceAmount);
  const taxAmount =
    body.taxAmount === undefined || body.taxAmount === null
      ? round(invoiceAmount * 0.15, 2)
      : Number(body.taxAmount);
  const receivedDate =
    typeof body.receivedDate === "string" && body.receivedDate
      ? body.receivedDate
      : todayIso();

  if (invoiceNumber.length < 3) {
    return Response.json({ error: "invoiceNumber is required." }, { status: 422 });
  }
  if (!Number.isFinite(invoiceAmount) || invoiceAmount <= 0) {
    return Response.json(
      { error: "invoiceAmount must be a positive number." },
      { status: 422 },
    );
  }
  if (!Number.isFinite(taxAmount) || taxAmount < 0) {
    return Response.json(
      { error: "taxAmount must be zero or a positive number." },
      { status: 422 },
    );
  }

  const result = await submitInvoice(
    id,
    {
      invoiceNumber,
      invoiceAmount: round(invoiceAmount, 2),
      taxAmount: round(taxAmount, 2),
      receivedDate,
    },
    {
      id: auth.actor.id,
      name: auth.actor.name,
      role: auth.actor.role,
    },
  );

  return Response.json(result, { status: result.error ? 500 : 200 });
}
