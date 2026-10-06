/**
 * Fixed-window counter for throttling credential guessing on the supplier
 * portal. Deliberately in-memory: the portal is one process, a lost counter
 * only ever fails open, and persisting attempt history would put attacker data
 * in the procurement database for no security gain.
 */

export interface RateLimitRule {
  /** Attempts allowed inside one window, counting the first one. */
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Attempts left in this window after the one just counted. */
  remaining: number;
  /** Seconds until the window resets; only meaningful when blocked. */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Count one attempt against `key`. The first attempt opens a window, later
 * attempts ride it until the window expires, after which the key starts fresh.
 * `now` is injectable so tests can cross a window without sleeping.
 */
export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): RateLimitVerdict {
  prune(now);

  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: Math.max(0, rule.limit - 1), retryAfterSec: 0 };
  }

  bucket.count += 1;
  if (bucket.count > rule.limit) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - bucket.count),
    retryAfterSec: 0,
  };
}

/** Drops every counter; tests use it so files cannot bleed into each other. */
export function resetRateLimits(): void {
  buckets.clear();
}
