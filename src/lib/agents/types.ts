import type { AgentName, ProcurementRequest } from "@/lib/domain/types";

export interface AgentContext {
  request: ProcurementRequest;
  /** Deterministic PRNG scoped to this request, so reruns are reproducible. */
  rng: () => number;
}

export interface AgentResult<TOutput> {
  summary: string;
  output: TOutput;
  /** Structured payload rendered in the audit trail. */
  detail: unknown;
}

export interface Agent<TInput, TOutput> {
  name: AgentName;
  run(
    context: AgentContext,
    input: TInput,
  ): Promise<AgentResult<TOutput>> | AgentResult<TOutput>;
}

export const SHIP_TO = "Procura Head Office, 1 Meridian Park, Sandton, Johannesburg, 2196";
