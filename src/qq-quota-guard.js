// Saver mode for the Codex 5-hour usage window: when little of it is left the
// Bot answers with a small model at low effort and stops an interest module
// that would itself spend Codex quota; once the window has recovered (or
// reset) the saved settings come back.

export function decideQqQuotaGuard(quota, {
  active = false,
  enterBelowPercent = 25,
  exitAtPercent = 50,
  now = Date.now()
} = {}) {
  const window = quota?.primary;
  const remaining = Number(window?.remainingPercent);
  if (!quota?.available || !window || !Number.isFinite(remaining) || enterBelowPercent <= 0) return null;
  if (!active) return remaining < enterBelowPercent ? "enter" : null;
  const resetsAtMs = Number(window.resetsAt) * 1000;
  const windowReset = Number.isFinite(resetsAtMs) && resetsAtMs > 0 && now >= resetsAtMs;
  return remaining >= exitAtPercent || windowReset ? "exit" : null;
}

// Only the "codex" judge runs on the Codex login; any other provider (local
// Ollama or a separate API key) keeps judging through saver mode.
export function qqQuotaSaverKeepsInterestJudge(provider) {
  return String(provider || "").trim().toLowerCase() !== "codex";
}
