/**
 * Minimal structured logger for the extraction pipeline.
 * Every line is single-line JSON so Vercel log drains / `next dev` output
 * stay greppable. Correlate browser ↔ server via `requestId`
 * (also returned in the API response `debug` block).
 */

export function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function logStep(requestId: string, stage: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    requestId,
    stage,
    ...fields,
  });
  // eslint-disable-next-line no-console
  console.log(`[reel-to-map] ${line}`);
}

/** Call at the start of a stage, then `done()` to log its duration. */
export function startTimer(requestId: string, stage: string): (extra?: Record<string, unknown>) => void {
  const t0 = Date.now();
  return (extra: Record<string, unknown> = {}) =>
    logStep(requestId, stage, { durationMs: Date.now() - t0, ...extra });
}
