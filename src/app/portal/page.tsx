import { bootstrap } from "@/lib/bootstrap";
import {
  findRfqInvitationByToken,
  getQuote,
  getRequest,
  getRequestSpec,
  getSupplier,
  updateRfqInvitation,
} from "@/lib/db/repository";
import { CATEGORY_LABEL } from "@/lib/domain/types";
import { formatDate, formatMoney, nowIso, todayIso } from "@/lib/util";

export const dynamic = "force-dynamic";

interface PortalPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function param(params: Record<string, string | string[] | undefined>, name: string): string {
  const value = params[name];
  return typeof value === "string" ? value : "";
}

function Banner({ tone, children }: { tone: "ok" | "bad"; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 text-sm ${
        tone === "ok"
          ? "border-gain-500/40 bg-gain-500/10 text-gain-500"
          : "border-risk-500/40 bg-risk-500/10 text-risk-500"
      }`}
    >
      {children}
    </div>
  );
}

function Gate({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto max-w-xl py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-ink-500">
        Procura supplier portal
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink-100">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-400">{body}</p>
      <p className="mt-6 text-xs text-ink-500">
        Your invitation link contains a private token. Open the link exactly as it was
        sent to you; there is nothing to sign in to.
      </p>
    </main>
  );
}

/**
 * The supplier-facing side of an RFQ. A token in the query string is the whole
 * credential: opening it records that the invitation was seen, and the form
 * posts back to `/portal/rfq`, which is where the response is validated.
 */
export default async function SupplierPortalPage({ searchParams }: PortalPageProps) {
  const params = await searchParams;
  const token = param(params, "token");
  const done = param(params, "done");
  const error = param(params, "error");

  await bootstrap();

  const invitation = token ? findRfqInvitationByToken(token) : null;
  if (!token) {
    return (
      <Gate
        title="This page needs your invitation link"
        body="Open the request-for-quotation link that Procura sent you. Each supplier gets its own private link, so the page cannot show anything without one."
      />
    );
  }
  if (!invitation) {
    return (
      <Gate
        title="That link is not valid"
        body="The invitation may have been mistyped, or the link may have been superseded by a newer one. Ask your contact at Procura to resend it."
      />
    );
  }

  // The first open is a fact about the supplier relationship: from here on the
  // invitation is no longer untouched, and procurement can see it was read.
  if (invitation.status === "invited") {
    updateRfqInvitation(invitation.id, { status: "viewed", viewedAt: nowIso() });
  }

  const request = getRequest(invitation.requestId);
  const spec = request ? getRequestSpec(request.id) : null;
  const supplier = getSupplier(invitation.supplierId);
  if (!request || !spec || !supplier) {
    return (
      <Gate
        title="This request is no longer available"
        body="The request behind this invitation has been withdrawn or rebuilt. Nothing can be quoted against it any more."
      />
    );
  }

  const submitted = invitation.quoteId ? getQuote(invitation.quoteId) : null;
  const windowClosed =
    invitation.status === "expired" ||
    invitation.status === "quoted" ||
    invitation.status === "declined" ||
    invitation.expiresAt < todayIso() ||
    request.status !== "awaiting_quotes";

  return (
    <main className="mx-auto max-w-3xl py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-ink-500">
            Procura supplier portal
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-100">
            Request for quotation {request.reference}
          </h1>
        </div>
        <p className="text-sm text-ink-400">
          Quoting as <span className="text-ink-200">{supplier.name}</span>
        </p>
      </div>

      <div className="mt-6 space-y-4">
        {done === "quote" ? (
          <Banner tone="ok">
            Quotation submitted. Procura will compare it with the other responses and
            come back to you if it is shortlisted.
          </Banner>
        ) : null}
        {done === "decline" ? (
          <Banner tone="ok">
            Response recorded as a decline. Thank you for coming back to us either way.
          </Banner>
        ) : null}
        {error ? <Banner tone="bad">{error}</Banner> : null}
      </div>

      <section className="mt-6 rounded-xl border border-ink-700 bg-ink-900/60 p-6">
        <h2 className="text-lg font-medium text-ink-100">{request.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-300">{spec.summary}</p>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Category</dt>
            <dd className="mt-1 text-ink-200">
              {spec.category in CATEGORY_LABEL
                ? CATEGORY_LABEL[spec.category]
                : spec.category}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Quantity</dt>
            <dd className="mt-1 text-ink-200">
              {spec.quantity.toLocaleString("en-ZA")} {spec.unit}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Budget</dt>
            <dd className="mt-1 text-ink-200">
              {spec.budgetAmount
                ? `${request.currency} ${formatMoney(spec.budgetAmount, request.currency)}`
                : "Not stated"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-500">Needed by</dt>
            <dd className="mt-1 text-ink-200">
              {spec.neededBy ? formatDate(spec.neededBy) : "As soon as possible"}
            </dd>
          </div>
        </dl>

        {spec.specifications.length > 0 ? (
          <div className="mt-5 border-t border-ink-800 pt-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">Specifications</p>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-300">
              {spec.specifications.map((item) => (
                <li key={item.label}>
                  <span className="text-ink-200">{item.label}:</span> {item.value}
                  {item.required ? <span className="text-risk-500"> *</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {spec.mustHave.length > 0 ? (
          <div className="mt-4 border-t border-ink-800 pt-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">Must have</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-300">
              {spec.mustHave.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-4 border-t border-ink-800 pt-4">
          <p className="text-xs uppercase tracking-wide text-ink-500">Delivery</p>
          <p className="mt-1.5 text-sm text-ink-300">{spec.deliveryRequirement}</p>
        </div>
      </section>

      {submitted ? (
        <section className="mt-6 rounded-xl border border-gain-500/30 bg-gain-500/5 p-6">
          <h2 className="text-lg font-medium text-gain-500">Your quotation is in</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Unit price</dt>
              <dd className="mt-1 text-ink-100">
                {formatMoney(submitted.unitPrice, submitted.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Total</dt>
              <dd className="mt-1 text-ink-100">
                {formatMoney(submitted.totalPrice, submitted.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Lead time</dt>
              <dd className="mt-1 text-ink-100">{submitted.leadTimeDays} days</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-500">Terms</dt>
              <dd className="mt-1 text-ink-100">{submitted.paymentTerms}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-ink-500">
            Submitted {formatDate(submitted.receivedAt)}. Valid for {submitted.validityDays}{" "}
            days. The response window closes {formatDate(invitation.expiresAt)}.
          </p>
        </section>
      ) : null}

      {invitation.status === "declined" ? (
        <section className="mt-6 rounded-xl border border-ink-700 bg-ink-900/40 p-6">
          <h2 className="text-lg font-medium text-ink-200">You declined this request</h2>
          <p className="mt-2 text-sm text-ink-400">{invitation.declineReason}</p>
        </section>
      ) : null}

      {!submitted && invitation.status !== "declined" ? (
        windowClosed ? (
          <section className="mt-6 rounded-xl border border-warn-500/30 bg-warn-500/5 p-6">
            <h2 className="text-lg font-medium text-warn-500">
              The response window is closed
            </h2>
            <p className="mt-2 text-sm text-ink-400">
              Responses to this request were accepted until {formatDate(invitation.expiresAt)}.
              Late quotations cannot be added, but your contact at Procura can tell you
              whether the request is still live.
            </p>
          </section>
        ) : (
          <section className="mt-6 rounded-xl border border-ink-700 bg-ink-900/60 p-6">
            <h2 className="text-lg font-medium text-ink-100">Your quotation</h2>
            <p className="mt-1 text-sm text-ink-400">
              Prices in {request.currency}, excluding VAT where applicable. Respond by{" "}
              {formatDate(invitation.expiresAt)}.
            </p>

            <form method="post" action="/portal/rfq" className="mt-5">
              <input type="hidden" name="token" value={invitation.token} />
              <input type="hidden" name="action" value="quote" />

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-ink-200">Unit price</span>
                  <input
                    type="number"
                    name="unitPrice"
                    min="0.01"
                    step="0.01"
                    required
                    placeholder="0.00"
                    className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-200">Delivery cost</span>
                  <input
                    type="number"
                    name="shippingCost"
                    min="0"
                    step="0.01"
                    defaultValue="0"
                    className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-200">Lead time (days)</span>
                  <input
                    type="number"
                    name="leadTimeDays"
                    min="1"
                    step="1"
                    required
                    placeholder="14"
                    className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-200">Payment terms</span>
                  <select
                    name="paymentTerms"
                    defaultValue="30 days"
                    className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                  >
                    <option value="30 days">30 days</option>
                    <option value="45 days">45 days</option>
                    <option value="60 days">60 days</option>
                    <option value="50% deposit">50% deposit</option>
                    <option value="On delivery">On delivery</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-ink-200">Warranty (months)</span>
                  <select
                    name="warrantyMonths"
                    defaultValue="12"
                    className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                  >
                    <option value="0">None</option>
                    <option value="12">12</option>
                    <option value="24">24</option>
                    <option value="36">36</option>
                    <option value="60">60</option>
                  </select>
                </label>
              </div>

              <label className="mt-4 block text-sm">
                <span className="text-ink-200">Notes (optional)</span>
                <textarea
                  name="notes"
                  rows={3}
                  placeholder="Anything the buyer should know about this offer"
                  className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                />
              </label>

              <button
                type="submit"
                className="mt-5 rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-400"
              >
                Submit quotation
              </button>
            </form>

            <div className="mt-8 border-t border-ink-800 pt-5">
              <h3 className="text-sm font-medium text-ink-200">Not able to quote?</h3>
              <form method="post" action="/portal/rfq" className="mt-3">
                <input type="hidden" name="token" value={invitation.token} />
                <input type="hidden" name="action" value="decline" />
                <label className="block text-sm">
                  <span className="sr-only">Reason for declining</span>
                  <textarea
                    name="reason"
                    rows={2}
                    required
                    placeholder="Reason for declining (kept on the request record)"
                    className="w-full rounded-lg border border-ink-600 bg-ink-950/70 px-3 py-2.5 text-sm text-ink-100"
                  />
                </label>
                <button
                  type="submit"
                  className="mt-3 rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-300 transition hover:border-risk-500/60 hover:text-risk-500"
                >
                  Decline this request
                </button>
              </form>
            </div>
          </section>
        )
      ) : null}

      <p className="mt-8 text-xs text-ink-500">
        Everything you submit is recorded against {request.reference} on the Procura audit
        trail. Questions? Reply to the invitation email.
      </p>
    </main>
  );
}
