import type { AppDeps } from "./app.ts";
import { Repo } from "./repo.ts";
import { refreshUserFeeds } from "./routes/feeds.ts";

/** Feed refresh interval in minutes from LATER_FEED_INTERVAL_MIN (default 30, minimum 1). */
export function feedIntervalMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1)
    throw new Error(`LATER_FEED_INTERVAL_MIN must be a number >= 1, got "${raw}"`);
  return n;
}

/**
 * Periodically refresh every user's feeds. Runs never overlap (a slow cycle skips the next tick).
 * Returns a stop function. Started from index.ts only.
 */
export function startFeedScheduler(deps: AppDeps, intervalMin: number): () => void {
  const repo = new Repo(deps.db);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const userId of repo.feedUserIds()) {
        try {
          await refreshUserFeeds(repo, deps, userId);
        } catch (err) {
          console.error("[later] feed refresh failed for user", userId, err);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMin * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
