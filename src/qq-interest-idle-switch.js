// Picks the interest-judge provider by whether the owner is at the computer:
// while they use it the judge runs on the active provider (local Codex) so the
// local model's memory and GPU stay free; once the machine has been idle for a
// while it moves to the idle provider (local Ollama). Quota saver mode pins
// the idle provider because the active one would spend Codex quota.

export const QQ_INTEREST_IDLE_SWITCH_ACTIVE_BELOW_SECONDS = 30;

export function decideQqInterestIdleProvider(idleSeconds, {
  current,
  activeProvider = "codex",
  idleProvider = "ollama",
  idleAfterSeconds = 300,
  activeBelowSeconds = QQ_INTEREST_IDLE_SWITCH_ACTIVE_BELOW_SECONDS,
  pinIdleProvider = false
} = {}) {
  let next = null;
  if (pinIdleProvider) next = idleProvider;
  else if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return null;
  else if (idleSeconds < activeBelowSeconds) next = activeProvider;
  else if (idleSeconds >= idleAfterSeconds) next = idleProvider;
  return next && next !== current ? next : null;
}

// Polls the host idle time and applies provider changes one at a time. A
// failed read keeps the current provider.
export function createQqInterestIdleSwitch({
  readIdleSeconds,
  getOptions,
  apply,
  intervalMs = 10_000,
  onError = () => {}
}) {
  let timer = null;
  let running = null;
  let stopped = true;
  const tick = async () => {
    try {
      const options = getOptions();
      const idleSeconds = options.pinIdleProvider ? null : await readIdleSeconds();
      const next = decideQqInterestIdleProvider(idleSeconds, options);
      if (next) await apply(next, { idleSeconds });
    } catch (error) {
      onError(error);
    }
  };
  const run = () => {
    if (!running) running = tick().finally(() => { running = null; });
    return running;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => run().finally(schedule), intervalMs);
    timer.unref?.();
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      run().finally(schedule);
    },
    refresh: run,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    }
  };
}
