/**
 * Lab-only speed-up for recovery/watchdog timings (restart waits, boot grace,
 * SSH retry, cooldowns). PC_TEST_TIME_SCALE=0.05 makes a 30 s wait 1.5 s so the
 * P5 lab checks finish in minutes. It is IGNORED when NODE_ENV=production (the
 * image sets it), so it can never shorten a live node's grace periods.
 */
export function scaled(ms: number): number {
  if (process.env.NODE_ENV === 'production') return ms
  const f = Number(process.env.PC_TEST_TIME_SCALE)
  if (!Number.isFinite(f) || f <= 0 || f >= 1) return ms
  return Math.max(1, Math.round(ms * f))
}
