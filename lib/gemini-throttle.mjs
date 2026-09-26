/**
 * Shared Gemini call gap. Advisor and the flight debrief use one bucket
 * so they do not exceed the free-tier rate together.
 * GEMINI_MIN_INTERVAL_MS overrides the default (6000 ms). Read on each call.
 */
let lastGeminiCallAt = 0;

export function geminiMinIntervalMs() {
  return Math.max(0, Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 6000));
}

export async function throttleGemini() {
  const minGap = geminiMinIntervalMs();
  const now = Date.now();
  const gap = now - lastGeminiCallAt;
  if (gap < minGap) {
    await new Promise((r) => setTimeout(r, minGap - gap));
  }
  lastGeminiCallAt = Date.now();
}
