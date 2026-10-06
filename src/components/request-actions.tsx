"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  decideApprovalAction,
  rerunPipelineAction,
  submitInvoiceAction,
} from "@/app/actions";
import type { RequestBundle } from "@/lib/queries";
import { formatMoney } from "@/lib/util";
import { Panel, PanelHeader, Pill } from "./ui";

export function DecisionBar({ bundle }: { bundle: RequestBundle }) {
  return bundle.pendingApproval ? (
    <ApprovalDecision bundle={bundle} />
  ) : (
    <RerunButton requestId={bundle.request.id} />
  );
}

function ApprovalDecision({ bundle }: { bundle: RequestBundle }) {
  const step = bundle.pendingApproval!;
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function decide(decision: "approved" | "rejected") {
    setMessage(null);
    startTransition(async () => {
      const result = await decideApprovalAction(
        bundle.request.id,
        step.id,
        decision,
        note.trim() || (decision === "approved" ? "Approved." : "Rejected."),
      );
      setMessage(result.message);
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-warn-500/30 bg-warn-500/5 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="warn">decision required</Pill>
        <p className="text-sm font-medium text-ink-100">
          {step.role} · {step.approverName}
        </p>
        <p className="text-sm text-ink-400">
          {step.thresholdAmount === 0
            ? "compliance gate, no monetary limit"
            : step.thresholdAmount > 1_000_000_000_000
              ? "unlimited authority"
              : `approves up to ${formatMoney(step.thresholdAmount, bundle.request.currency)}`}
        </p>
      </div>

      {bundle.purchaseOrder ? (
        <p className="mt-2 text-sm text-ink-300">
          Purchase order {bundle.purchaseOrder.poNumber} has been raised for{" "}
          <span className="font-mono">
            {formatMoney(bundle.purchaseOrder.totalAmount, bundle.request.currency)}
          </span>{" "}
          with {bundle.purchaseOrder.supplierName}. This decision is recorded
          against the agent audit trail.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Decision note (optional, but recorded)"
          className="min-w-64 flex-1 rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500"
        />
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("approved")}
          className="rounded-lg bg-gain-500 px-4 py-2 text-sm font-medium text-ink-950 transition hover:brightness-110 disabled:opacity-60"
        >
          {pending ? "Recording…" : "Approve"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("rejected")}
          className="rounded-lg border border-risk-500/40 px-4 py-2 text-sm font-medium text-risk-500 transition hover:bg-risk-500/10 disabled:opacity-60"
        >
          Reject
        </button>
      </div>

      {message ? <p className="mt-3 text-sm text-ink-300">{message}</p> : null}
    </div>
  );
}

export function RerunButton({ requestId }: { requestId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await rerunPipelineAction(requestId);
          router.refresh();
        })
      }
      className="rounded-lg border border-ink-600 px-3.5 py-2 text-sm text-ink-300 transition hover:border-ink-400 hover:text-ink-100 disabled:opacity-60"
    >
      {pending ? "Re-running agents…" : "Re-run the agents"}
    </button>
  );
}

export function InvoiceForm({
  requestId,
  poNumber,
  invoiceAmount,
  taxAmount,
  currency,
}: {
  requestId: string;
  poNumber: string;
  invoiceAmount: number;
  taxAmount: number;
  currency: string;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState(invoiceAmount.toFixed(2));
  const [tax, setTax] = useState(taxAmount.toFixed(2));
  const [receivedDate, setReceivedDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    setResult(null);
    startTransition(async () => {
      const response = await submitInvoiceAction(requestId, {
        invoiceNumber,
        invoiceAmount: Number.parseFloat(amount) || 0,
        taxAmount: Number.parseFloat(tax) || 0,
        receivedDate,
      });
      setResult({ ok: response.ok, message: response.message });
      router.refresh();
    });
  }

  return (
    <Panel>
      <PanelHeader
        title="Submit the supplier invoice"
        hint={`Matched three ways against ${poNumber} — the numbers below are prefilled to a clean invoice`}
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Invoice number"
            value={invoiceNumber}
            onChange={setInvoiceNumber}
            placeholder="INV-2026-0412"
          />
          <Field
            label={`Amount excl. VAT (${currency})`}
            value={amount}
            onChange={setAmount}
            inputMode="decimal"
          />
          <Field
            label={`VAT (${currency})`}
            value={tax}
            onChange={setTax}
            inputMode="decimal"
          />
          <Field
            label="Received"
            value={receivedDate}
            onChange={setReceivedDate}
            type="date"
          />
        </div>

        <p className="rounded-lg border border-ink-700 bg-ink-800/40 px-3.5 py-2.5 text-xs text-ink-400">
          The Invoice Agent compares the invoice against the purchase order line,
          unit price and total. Try raising the amount to see it catch
          overbilling — a clean match pays out, a query is held for a human, a
          mismatch is rejected.
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400 disabled:opacity-60"
          >
            {pending ? "Matching…" : "Run the three-way match"}
          </button>
          {result ? (
            <p
              className={`text-sm ${
                result.ok ? "text-gain-500" : "text-risk-500"
              }`}
            >
              {result.message}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: "decimal" | "text";
}) {
  return (
    <div>
      <label className="text-xs font-medium text-ink-300">{label}</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        inputMode={inputMode}
        className="mt-1.5 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2 font-mono text-sm text-ink-100 placeholder:text-ink-500"
      />
    </div>
  );
}
