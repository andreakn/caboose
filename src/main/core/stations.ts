// Feature names: Nordic railway stations (ids are ASCII; the proper names,
// positions and lines are in shared/stations.ts).
import { distance, STATION_INFO, STATIONS } from "../../shared/stations.ts";
import type { HomeArea } from "../../shared/types.ts";

export { distance, STATIONS };

/** How many of the nearest free stations a name is drawn from: near home, but not the same order for everyone. */
export const NEAR_CHOICES = 4;

/**
 * A station not in `taken`. With a home area, one of the few nearest free
 * ones, so names spread outwards from home as features are made; without,
 * any. Falls back to "<station>-2", "-3"... once all are used.
 */
export function pickStation(taken: Set<string>, home?: HomeArea, random = Math.random): string {
  const free = STATIONS.filter((s) => !taken.has(s));
  if (free.length && home) {
    const near = free
      .map((s) => ({ s, d: distance(home, STATION_INFO[s]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAR_CHOICES);
    return near[Math.floor(random() * near.length)].s;
  }
  if (free.length) return free[Math.floor(random() * free.length)];
  for (let n = 2; ; n++) {
    const s = `${STATIONS[Math.floor(random() * STATIONS.length)]}-${n}`;
    if (!taken.has(s)) return s;
  }
}
