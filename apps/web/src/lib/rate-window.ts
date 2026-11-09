// A fixed-memory request counter: at most `max` requests per key in any `windowMs`. Kept in this
// server's memory, so a restart forgets it and several servers would each count separately.
// shortcut: in-memory only, one server; move to the database or a proxy if the app is ever scaled out.

const PRUNE_ABOVE = 5000;

export type WindowLimiter = { allow: (key: string, nowMs: number) => boolean };

/** Counts this request, then says whether it is within the limit. Refused requests count too. */
export const createWindowLimiter = (max: number, windowMs: number): WindowLimiter => {
  const hits = new Map<string, number[]>();
  const prune = (nowMs: number): void => {
    for (const [key, times] of hits) {
      if (times.every((t) => nowMs - t >= windowMs)) hits.delete(key);
    }
  };
  return {
    allow: (key, nowMs) => {
      if (hits.size > PRUNE_ABOVE) prune(nowMs);
      const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
      recent.push(nowMs);
      hits.set(key, recent);
      return recent.length <= max;
    },
  };
};
