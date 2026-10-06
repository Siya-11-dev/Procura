import { beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { setupTestDb } from "./helpers";
import {
  checkRateLimit,
  resetRateLimits,
  type RateLimitRule,
} from "@/lib/rate-limit";
import { POST } from "@/app/portal/rfq/route";

setupTestDb();
beforeEach(() => resetRateLimits());

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };

interface PostOutcome {
  digest?: string;
  status?: number;
  retryAfter?: string | null;
}

/** One mistyped invitation link, answered either by a redirect or by a 429. */
async function guess(ip: string, token = "rfqtok_not-a-real-token"): Promise<PostOutcome> {
  const form = new FormData();
  form.set("token", token);
  form.set("action", "quote");
  form.set("unitPrice", "10");
  form.set("leadTimeDays", "5");

  const request = new Request("http://localhost/portal/rfq", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": ip },
  });

  try {
    const response = await POST(request as unknown as NextRequest);
    return { status: response.status, retryAfter: response.headers.get("Retry-After") };
  } catch (error) {
    return { digest: (error as { digest?: string }).digest };
  }
}

describe("rate limit windows", () => {
  it("counts attempts and blocks past the limit", () => {
    const now = 1_000_000;
    expect(checkRateLimit("ip:one", RULE, now)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(checkRateLimit("ip:one", RULE, now)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit("ip:one", RULE, now)).toMatchObject({
      allowed: true,
      remaining: 0,
    });

    const blocked = checkRateLimit("ip:one", RULE, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(RULE.windowMs / 1000);
  });

  it("opens a fresh window once the old one has expired", () => {
    const now = 1_000_000;
    for (let i = 0; i < RULE.limit + 1; i += 1) {
      checkRateLimit("ip:two", RULE, now);
    }
    expect(checkRateLimit("ip:two", RULE, now).allowed).toBe(false);

    expect(
      checkRateLimit("ip:two", RULE, now + RULE.windowMs + 1).allowed,
    ).toBe(true);
  });

  it("keeps keys independent so one caller cannot throttle the rest", () => {
    const now = 1_000_000;
    for (let i = 0; i < RULE.limit + 1; i += 1) {
      checkRateLimit("ip:noisy", RULE, now);
    }
    expect(checkRateLimit("ip:noisy", RULE, now).allowed).toBe(false);
    expect(checkRateLimit("ip:quiet", RULE, now).allowed).toBe(true);
  });
});

describe("portal token throttling", () => {
  it("tolerates a few mistyped links, then answers 429 with a retry hint", async () => {
    // Mirrors TOKEN_GUESSING in the route: eight misses are allowed in the
    // first window, the ninth comes back as a 429 instead of a redirect.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const outcome = await guess("203.0.113.10");
      expect(outcome.digest).toContain("error=");
    }

    const blocked = await guess("203.0.113.10");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(blocked.digest).toBeUndefined();
  });

  it("throttles the guessing client only, never the next supplier", async () => {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await guess("198.51.100.7");
    }
    expect((await guess("198.51.100.7")).status).toBe(429);

    // A different supplier on another network is unaffected.
    const other = await guess("198.51.100.8");
    expect(other.digest).toContain("error=");
    expect(other.status).toBeUndefined();
  });
});
