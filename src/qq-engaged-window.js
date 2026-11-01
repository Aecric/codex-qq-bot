// After the Bot answers an @ in a group it keeps watching the next N human
// messages there, and the interest judge looks at each one, so a running
// conversation can continue without a fresh @. Every Bot reply delivered while
// the window is open starts a new N-message window. The state can be
// snapshotted to disk so a Hub restart does not cut a conversation off; a
// window untouched for `idleMs` lapses.

export function createQqEngagedWindows({ size = 30, idleMs = 30 * 60_000, now = Date.now, onChange = () => {} } = {}) {
  const normalizeSize = (value) => Math.max(0, Math.round(Number(value) || 0));
  let windowSize = normalizeSize(size);
  const windowsByGroupId = new Map();
  const live = (id) => {
    const entry = windowsByGroupId.get(id);
    if (!entry) return null;
    if (now() - entry.at > idleMs) {
      windowsByGroupId.delete(id);
      return null;
    }
    return entry;
  };
  const set = (id, remaining) => {
    if (remaining > 0) windowsByGroupId.set(id, { remaining, at: now() });
    else windowsByGroupId.delete(id);
    onChange();
  };
  return {
    get size() {
      return windowSize;
    },
    // Applies a new size at runtime; open windows never exceed it, and a zero
    // size closes them.
    resize(value) {
      windowSize = normalizeSize(value);
      let changed = false;
      for (const [id, entry] of windowsByGroupId) {
        if (entry.remaining <= windowSize) continue;
        changed = true;
        if (windowSize > 0) entry.remaining = windowSize;
        else windowsByGroupId.delete(id);
      }
      if (changed) onChange();
    },
    open(groupId) {
      if (windowSize > 0 && groupId) set(String(groupId), windowSize);
    },
    renewIfActive(groupId) {
      const id = String(groupId || "");
      if (!live(id)) return false;
      set(id, windowSize);
      return true;
    },
    // Counts one watched human message; null once the window is closed.
    consume(groupId) {
      const id = String(groupId || "");
      const entry = live(id);
      if (!entry) return null;
      set(id, entry.remaining - 1);
      return { remaining: entry.remaining - 1, size: windowSize };
    },
    remaining(groupId) {
      return live(String(groupId || ""))?.remaining || 0;
    },
    snapshot() {
      return Object.fromEntries([...windowsByGroupId].filter(([id]) => live(id)));
    },
    restore(data = {}) {
      for (const [id, entry] of Object.entries(data && typeof data === "object" ? data : {})) {
        const remaining = Math.min(windowSize, Math.max(0, Math.round(Number(entry?.remaining) || 0)));
        const at = Number(entry?.at);
        if (remaining > 0 && Number.isFinite(at)) windowsByGroupId.set(id, { remaining, at });
      }
    }
  };
}
