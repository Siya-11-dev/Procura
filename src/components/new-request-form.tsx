"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  submitRequestAction,
  type ActionState,
} from "@/app/actions";
import { EXAMPLE_REQUEST } from "@/lib/demo";
import { DEPARTMENTS } from "@/lib/org";

const initialState: ActionState = { ok: false, message: "" };

const ACCEPTED_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".log",
];

export function NewRequestForm({
  defaultName = "",
  defaultEmail = "",
  defaultDepartment = "",
}: {
  defaultName?: string;
  defaultEmail?: string;
  defaultDepartment?: string;
}) {
  const [state, formAction, pending] = useActionState(
    submitRequestAction,
    initialState,
  );
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<{ name: string; size: number }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const errors = state.fieldErrors ?? {};

  // The action returns rather than redirecting when it has something to report
  // about the attachments, so navigation is done from the client instead.
  useEffect(() => {
    if (state.redirectTo) router.push(state.redirectTo);
  }, [state.redirectTo, router]);

  return (
    <form action={formAction} className="space-y-6">
      <input
        type="file"
        name="documents"
        multiple
        ref={fileInput}
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(event) => {
          const list = Array.from(event.target.files ?? []);
          setChosen(
            list.map((file) => ({ name: file.name, size: file.size })),
          );
        }}
        className="sr-only"
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Title"
          name="title"
          placeholder="Replace the design studio laptops"
          error={errors.title}
          required
        />
        <div>
          <label
            htmlFor="requesterDepartment"
            className="text-sm font-medium text-ink-200"
          >
            Department
          </label>
          <select
            id="requesterDepartment"
            name="requesterDepartment"
            required
            defaultValue={
              DEPARTMENTS.includes(defaultDepartment as (typeof DEPARTMENTS)[number])
                ? defaultDepartment
                : DEPARTMENTS[0]
            }
            className={`mt-2 w-full rounded-lg border bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100 focus:bg-ink-900 ${
              errors.requesterDepartment ? "border-risk-500" : "border-ink-600"
            }`}
          >
            {DEPARTMENTS.map((department) => (
              <option key={department} value={department}>
                {department}
              </option>
            ))}
          </select>
          {errors.requesterDepartment ? (
            <p className="mt-1.5 text-xs text-risk-500">
              {errors.requesterDepartment}
            </p>
          ) : null}
        </div>
        <Field
          label="Your name"
          name="requesterName"
          placeholder="Amahle Dlamini"
          defaultValue={defaultName}
          error={errors.requesterName}
          required
        />
        <Field
          label="Email"
          name="requesterEmail"
          type="email"
          placeholder="you@procura.co.za"
          defaultValue={defaultEmail}
          error={errors.requesterEmail}
          required
        />
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label
            htmlFor="rawDescription"
            className="text-sm font-medium text-ink-200"
          >
            What do you need?{" "}
            <span className="text-ink-400">
              — write it the way you would in an email to a colleague
            </span>
          </label>
          <button
            type="button"
            onClick={() => setDescription(EXAMPLE_REQUEST)}
            className="rounded-md border border-ink-600 px-2.5 py-1 text-xs text-ink-300 transition hover:border-ink-400 hover:text-ink-100"
          >
            Use an example
          </button>
        </div>
        <textarea
          id="rawDescription"
          name="rawDescription"
          rows={7}
          required
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="40 ergonomic sit-stand desks, 1600x800mm, black frame, cable tray included. ISO 9001 and B-BBEE Level 2 only. About R300,000, needed in 6 weeks."
          className={`mt-2 w-full resize-y rounded-lg border bg-ink-900/70 px-3.5 py-3 text-sm leading-relaxed text-ink-100 placeholder:text-ink-500 focus:bg-ink-900 ${
            errors.rawDescription ? "border-risk-500" : "border-ink-600"
          }`}
        />
        {errors.rawDescription ? (
          <p className="mt-1.5 text-xs text-risk-500">{errors.rawDescription}</p>
        ) : (
          <p className="mt-1.5 text-xs text-ink-400">
            The Request Agent reads this text. Quantities, specifications,
            certifications, budget and deadlines you do not state explicitly are
            inferred and recorded as assumptions.
          </p>
        )}
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label className="text-sm font-medium text-ink-200">
            Attachments{" "}
            <span className="font-normal text-ink-400">
              — optional, read by the Request Agent
            </span>
          </label>
          {chosen.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setChosen([]);
                if (fileInput.current) fileInput.current.value = "";
              }}
              className="rounded-md border border-ink-600 px-2.5 py-1 text-xs text-ink-300 transition hover:border-ink-400 hover:text-ink-100"
            >
              Clear
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="mt-2 w-full rounded-lg border border-dashed border-ink-600 px-3.5 py-4 text-left text-sm text-ink-400 transition hover:border-ink-400 hover:text-ink-200"
        >
          {chosen.length === 0
            ? "Choose a spec sheet, quote or requirements file"
            : `${chosen.length} file${chosen.length === 1 ? "" : "s"} selected`}
        </button>
        {chosen.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {chosen.map((file) => (
              <li
                key={file.name}
                className="flex justify-between gap-3 text-xs text-ink-300"
              >
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-ink-500">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-ink-400">
            Procura reads plain text, markdown, CSV, TSV and JSON files. Anything
            else is still stored against the request as evidence, but will be
            marked as not read rather than guessed at.
          </p>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Quantity"
          name="quantity"
          type="number"
          min="0"
          step="1"
          placeholder="40"
          error={errors.quantity}
          hint="Leave blank and the agent will find it"
        />
        <div>
          <label
            htmlFor="unit"
            className="text-sm font-medium text-ink-200"
          >
            Unit
          </label>
          <select
            id="unit"
            name="unit"
            defaultValue="units"
            className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100"
          >
            {[
              "units",
              "laptop",
              "chair",
              "desk",
              "seat",
              "service",
              "item",
              "shipment",
            ].map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Budget"
          name="budgetAmount"
          type="number"
          min="0"
          step="100"
          placeholder="300000"
          error={errors.budgetAmount}
        />
        <div>
          <label
            htmlFor="currency"
            className="text-sm font-medium text-ink-200"
          >
            Currency
          </label>
          <select
            id="currency"
            name="currency"
            defaultValue="ZAR"
            className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100"
          >
            {["ZAR", "USD", "EUR", "GBP"].map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Needed by"
          name="neededBy"
          type="date"
          error={errors.neededBy}
          hint="Blank means lead time is scored, not enforced"
        />
        <div>
          <label htmlFor="urgency" className="text-sm font-medium text-ink-200">
            Urgency
          </label>
          <select
            id="urgency"
            name="urgency"
            defaultValue="normal"
            className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100"
          >
            <option value="low">Low — no fixed date</option>
            <option value="normal">Normal — this quarter</option>
            <option value="high">High — needed soon</option>
            <option value="critical">Critical — blocking work</option>
          </select>
        </div>
        <div>
          <label htmlFor="quoteMode" className="text-sm font-medium text-ink-200">
            How quotes are collected
          </label>
          <select
            id="quoteMode"
            name="quoteMode"
            defaultValue="simulated"
            className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100"
          >
            <option value="simulated">Simulated — agents answer instantly</option>
            <option value="portal">
              Supplier portal — real suppliers answer through their own link
            </option>
          </select>
          <p className="mt-1.5 text-xs text-ink-500">
            Portal mode pauses the run until responses land.
          </p>
        </div>
      </div>

      {state.message ? (
        <p
          className={`rounded-lg border px-3.5 py-2.5 text-sm ${
            state.ok
              ? "border-gain-500/40 bg-gain-500/10 text-gain-500"
              : "border-risk-500/40 bg-risk-500/10 text-risk-500"
          }`}
        >
          {state.message}
          {state.rejectedDocuments?.length ? (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs">
              {state.rejectedDocuments.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending
            ? "Running nine agents…"
            : "Send to the agents"}
        </button>
        <p className="text-xs text-ink-400">
          Sourcing, comparison, risk, negotiation and approval routing all run
          before you see the result.
        </p>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  error,
  hint,
  type = "text",
  ...rest
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  min?: string;
  step?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="text-sm font-medium text-ink-200">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        {...rest}
        className={`mt-2 w-full rounded-lg border bg-ink-900/70 px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:bg-ink-900 ${
          error ? "border-risk-500" : "border-ink-600"
        }`}
      />
      {error ? (
        <p className="mt-1.5 text-xs text-risk-500">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}
