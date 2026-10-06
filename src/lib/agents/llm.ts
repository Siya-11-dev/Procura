/**
 * Optional LLM bridge.
 *
 * Procura runs on deterministic rules by default so the pipeline is
 * reproducible and works with no API key. Set the environment variables below
 * to let the agents that benefit from free-form reasoning (request
 * understanding, negotiation language, invoice narratives) call a real model.
 * Any failure degrades to the rule-based path rather than failing the request.
 */

const API_KEY = process.env.PROCURA_LLM_API_KEY;
const BASE_URL = process.env.PROCURA_LLM_BASE_URL ?? "https://api.openai.com/v1";
const MODEL = process.env.PROCURA_LLM_MODEL ?? "gpt-4o-mini";

export function llmEnabled(): boolean {
  return Boolean(API_KEY);
}

export function llmModelName(): string {
  return llmEnabled() ? MODEL : "rule-based engine";
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Rewrite a rule-based agent summary as a polished narrative for a human
 * approver. The rule summary is the source of truth: whenever the model is
 * disabled, times out, or returns anything that is missing or wildly different
 * in length, the original summary is returned verbatim so the pipeline never
 * depends on the LLM being reachable.
 */
export async function narrateSummary(opts: {
  agent: string;
  title: string;
  facts: string;
  fallback: string;
  maxLength?: number;
}): Promise<string> {
  if (!llmEnabled()) return opts.fallback;
  const result = await completeJson<{ summary: string }>(
    `You are the ${opts.agent} agent in a procurement pipeline at a South African company. Rewrite the summary below as a concise, professional, first-person note for a human approver. Keep every number, name, date and amount exactly as given; do not invent or omit figures; do not mention that you are AI. Keep it under ${opts.maxLength ?? 240} characters. Respond with JSON {"summary": string}.`,
    `Request: ${opts.title}\nFacts:\n${opts.facts}\nCurrent summary:\n${opts.fallback}`,
    0.2,
  );
  const summary = result?.summary?.trim().replace(/\s+/g, " ");
  if (!summary || summary.length < 10 || summary.length > (opts.maxLength ?? 240)) {
    return opts.fallback;
  }
  return summary;
}

export async function completeJson<T>(
  system: string,
  user: string,
  temperature = 0.2,
): Promise<T | null> {
  if (!API_KEY) return null;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}
