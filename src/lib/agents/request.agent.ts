import {
  readableDocumentCorpus,
  setRequestSpec,
  updateRequest,
  type RequestSpec,
} from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";
import { clamp, round } from "@/lib/util";
import { completeJson, llmEnabled } from "./llm";
import { parseRequestText, type ParsedRequest } from "./parsing";
import type { Agent, AgentContext, AgentResult } from "./types";

interface RequestAgentOutput {
  spec: RequestSpec;
}

const LLM_SYSTEM = `You are a procurement intake analyst for a South African company.
Read an employee's purchase request and return strict JSON with these keys:
{
  "summary": string,
  "category": one of ["it-hardware","software","office-furniture","facilities","marketing","professional-services","logistics","lab-equipment","general"],
  "unit": string,
  "quantity": number,
  "specifications": [{"label": string, "value": string, "required": boolean}],
  "requiredCertifications": string[],
  "mustHave": string[],
  "niceToHave": string[],
  "clarifications": string[],
  "assumptions": string[]
}
Only state what the requester actually asked for. Put genuine gaps in clarifications
and anything you had to infer in assumptions. Currency is ${"ZAR"} unless the text says otherwise.
Text under "--- attachment: <name> ---" came from a file the requester attached; treat it as
part of the request, and prefer it over a contradicting guess in the typed description.`;

export const requestAgent: Agent<null, RequestAgentOutput> = {
  name: "request",
  async run(
    context: AgentContext,
  ): Promise<AgentResult<RequestAgentOutput>> {
    const { request } = context;
    // Read straight from the database rather than through the agent context so a
    // rerun re-reads the attachments without the pipeline having to thread them
    // through every step.
    const { corpus, readCount, unreadCount } = readableDocumentCorpus(request.id);
    const rules = parseRequestText(request, corpus);

    let spec: RequestSpec = {
      ...rules,
      completeness: round(rules.completeness, 2),
      parsingMode: "rules",
    };

    if (llmEnabled()) {
      const source = corpus
        ? `${request.rawDescription}\n\nAttached documents:\n${corpus}`
        : request.rawDescription;
      const enhanced = await enhanceWithLlm(source, rules);
      if (enhanced) spec = enhanced;
    }

    // The parsed spec is the source the rest of the pipeline reads from, and the
    // request columns are what the UI and budgets read. They must never disagree
    // about what was ordered.
    withTransaction(() => {
      setRequestSpec(request.id, spec);
      updateRequest(request.id, {
        category: spec.category,
        unit: spec.unit,
        quantity: spec.quantity,
        budgetAmount: request.budgetAmount ?? spec.budgetAmount,
        neededBy: request.neededBy ?? spec.neededBy,
        urgency: spec.urgency,
      });
    });

    const inferred: string[] = [];
    if (request.budgetAmount === null && spec.budgetAmount !== null) {
      inferred.push("budget");
    }
    if (request.neededBy === null && spec.neededBy !== null) {
      inferred.push("required delivery date");
    }

    const gapNote =
      spec.completeness < 0.7
        ? ` ${spec.clarifications.length} gap${spec.clarifications.length === 1 ? "" : "s"} flagged for the requester.`
        : " Request is complete enough to source without a clarification round-trip.";
    const inferenceNote =
      inferred.length > 0
        ? ` Read the ${inferred.join(" and ")} out of ${readCount > 0 ? "the request and its attachments" : "the text"}.`
        : "";

    let documentNote = "";
    if (readCount > 0) {
      documentNote = ` Read ${readCount} attached document${readCount === 1 ? "" : "s"}.`;
    }
    if (unreadCount > 0) {
      // Never let a stored-but-unread attachment pass as if it had been read.
      documentNote += ` ${unreadCount} attachment${unreadCount === 1 ? " was" : "s were"} stored but could not be read, so ${unreadCount === 1 ? "it was" : "they were"} excluded from this reading.`;
    }

    return {
      summary: `Understood as ${spec.category.replace(/-/g, " ")}: ${spec.quantity} ${spec.unit}${spec.quantity === 1 ? "" : "s"}.${documentNote}${inferenceNote}${gapNote}`,
      output: { spec },
      detail: spec,
    };
  },
};

async function enhanceWithLlm(
  rawDescription: string,
  baseline: ParsedRequest,
): Promise<RequestSpec | null> {
  const result = await completeJson<Partial<RequestSpec>>(
    LLM_SYSTEM,
    rawDescription,
  );
  if (!result) return null;

  const merged: RequestSpec = {
    ...baseline,
    ...result,
    summary: result.summary ?? baseline.summary,
    category: result.category ?? baseline.category,
    unit: result.unit ?? baseline.unit,
    quantity:
      typeof result.quantity === "number" && result.quantity > 0
        ? result.quantity
        : baseline.quantity,
    specifications: result.specifications ?? baseline.specifications,
    requiredCertifications:
      result.requiredCertifications ?? baseline.requiredCertifications,
    mustHave: result.mustHave ?? baseline.mustHave,
    niceToHave: result.niceToHave ?? baseline.niceToHave,
    clarifications: result.clarifications ?? baseline.clarifications,
    assumptions: result.assumptions ?? baseline.assumptions,
    // Blocking codes come from the rules pass, not from the model: whether a
    // quantity can be read out of the text is a fact, not a summarisation.
    blockingClarifications: baseline.blockingClarifications,
    completeness: clamp(result.completeness ?? baseline.completeness, 0.1, 1),
    parsingMode: "llm",
  };

  return merged;
}
