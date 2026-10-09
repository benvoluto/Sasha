// Client-safe helpers for the limiter's 429 (no server imports): background
// hooks use them to wait quietly and try again.

import { isRateLimitedBody } from "./contract";

/**
 * How long a 429 asks the client to wait (ms): the body's
 * retry_after_seconds, else the Retry-After header, else `fallbackMs`. Null
 * for any other status.
 */
export function retryAfterMs(status: number, body: unknown, header: string | null, fallbackMs = 60_000): number | null {
  if (status !== 429) return null;
  const fromBody = isRateLimitedBody(body) ? Number(body.retry_after_seconds) : NaN;
  const fromHeader = header === null ? NaN : Number(header);
  const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : null;
  return seconds === null ? fallbackMs : Math.ceil(seconds * 1000);
}
