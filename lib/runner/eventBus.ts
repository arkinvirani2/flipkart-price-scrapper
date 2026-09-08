/**
 * In-process pub/sub feeding the SSE endpoints.
 *
 * Deliberately tiny: one Node process owns the runner, so there is nothing to
 * broker between machines. Subscribers are SSE connections, and they come and
 * go as browser tabs open and close.
 */

import type { JobEvent } from '@/types/dashboard';

type Listener = (event: JobEvent) => void;

interface BusState {
  listeners: Map<string, Set<Listener>>;
}

const state: BusState = ((globalThis as Record<string, unknown>).__eventBus as BusState) ?? {
  listeners: new Map<string, Set<Listener>>(),
};
(globalThis as Record<string, unknown>).__eventBus = state;

/** Channel every job also publishes to, so a dashboard can watch all batches at once. */
export const ALL_JOBS = '*';

export function subscribe(channel: string, listener: Listener): () => void {
  const set = state.listeners.get(channel) ?? new Set<Listener>();
  set.add(listener);
  state.listeners.set(channel, set);

  return () => {
    set.delete(listener);
    if (set.size === 0) state.listeners.delete(channel);
  };
}

/** Publish to a job's channel and the global one. A throwing listener is dropped, not propagated. */
export function publish(jobId: string, event: JobEvent): void {
  for (const channel of [jobId, ALL_JOBS]) {
    const set = state.listeners.get(channel);
    if (!set) continue;

    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A dead SSE connection must not interrupt a scrape.
        set.delete(listener);
      }
    }
  }
}

export function subscriberCount(channel: string): number {
  return state.listeners.get(channel)?.size ?? 0;
}

/**
 * Forget every subscriber.
 *
 * Used by the full reset, where the jobs those SSE streams are watching no
 * longer exist. The connections themselves are not closed here — the browser is
 * about to reload — but they must stop receiving events for batches that have
 * been deleted, or a stale stream would repopulate a viewer that just reset.
 */
export function clearSubscribers(): void {
  state.listeners.clear();
}
