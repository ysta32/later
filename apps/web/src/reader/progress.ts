export interface ProgressTracker {
  update(fraction: number): void;
  flush(): void;
  /** Send `fraction` now through `sender` (e.g. keepalive on pagehide) unless it equals the last persisted value. */
  sendNow(fraction: number, sender: (fraction: number) => void): void;
  dispose(): void;
}

export function clampFraction(f: number): number {
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

/** Scroll fraction of the document: 0 at top, 1 at bottom. */
export function scrollFraction(el: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : clampFraction(el.scrollTop / max);
}

/**
 * Sends at most one value per `delay` ms (trailing), skipping values equal to the last sent.
 * flush() sends immediately (used on unload).
 */
export function createProgressTracker(
  send: (fraction: number) => void,
  initial = 0,
  delay = 3000,
): ProgressTracker {
  let lastSent = clampFraction(initial);
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending !== null && Math.abs(pending - lastSent) > 0.001) {
      lastSent = pending;
      send(pending);
    }
    pending = null;
  };
  return {
    update(f) {
      pending = clampFraction(f);
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, delay);
    },
    flush,
    sendNow(f, sender) {
      const v = clampFraction(f);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      if (Math.abs(v - lastSent) > 0.001) {
        lastSent = v;
        sender(v);
      }
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** PATCH progress with keepalive so it survives page unload (sendBeacon cannot PATCH). */
export function sendProgressKeepalive(id: string, fraction: number): void {
  void fetch(`/api/articles/${id}`, {
    method: "PATCH",
    credentials: "include",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ progress: clampFraction(fraction) }),
  }).catch(() => {
    /* best effort; next session resumes from last saved value */
  });
}
