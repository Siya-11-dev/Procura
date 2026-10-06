import { bootstrap } from "@/lib/bootstrap";
import { authErrorResponse, requireAuth } from "@/lib/auth/guard";
import { createRequest, getRequest, listRequests } from "@/lib/db/repository";
import { runSourcingPipeline } from "@/lib/pipeline";
import type { Currency, Urgency } from "@/lib/domain/types";

export async function GET() {
  await bootstrap();
  const auth = await requireAuth();
  if (auth.error) return authErrorResponse(auth.error);
  return Response.json({ requests: listRequests() });
}

export async function POST(request: Request) {
  await bootstrap();
  const auth = await requireAuth();
  if (auth.error) return authErrorResponse(auth.error);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const title = str(body.title);
  const rawDescription = str(body.rawDescription);
  const requesterName = str(body.requesterName);
  const requesterEmail = str(body.requesterEmail);
  const requesterDepartment = str(body.requesterDepartment);

  if (title.length < 5 || rawDescription.length < 20 || !requesterEmail) {
    return Response.json(
      {
        error:
          "title, rawDescription (min 20 characters) and requesterEmail are required.",
      },
      { status: 422 },
    );
  }

  const created = createRequest({
    title,
    rawDescription,
    requesterName: requesterName || auth.actor.name,
    requesterEmail,
    requesterDepartment: requesterDepartment || "Unassigned",
    unit: str(body.unit) || "units",
    quantity: num(body.quantity),
    currency: (str(body.currency) || "ZAR") as Currency,
    budgetAmount: num(body.budgetAmount),
    neededBy: str(body.neededBy) || null,
    urgency: (str(body.urgency) || "normal") as Urgency,
  });

  const result = await runSourcingPipeline(created.id, {
    id: auth.actor.id,
    name: auth.actor.name,
    role: auth.actor.role,
  });
  return Response.json(
    { request: getRequest(created.id) ?? created, pipeline: result },
    { status: 201 },
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
