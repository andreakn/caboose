// Feature names: Nordic railway stations (ids are ASCII; the proper names,
// positions and lines are in shared/stations.ts).
import { STATIONS } from "../../shared/stations.ts";

export { STATIONS };

/** A station not in `taken`; falls back to "<station>-2", "-3"... once all are used. */
export function pickStation(taken: Set<string>, random = Math.random): string {
  const free = STATIONS.filter((s) => !taken.has(s));
  if (free.length) return free[Math.floor(random() * free.length)];
  for (let n = 2; ; n++) {
    const s = `${STATIONS[Math.floor(random() * STATIONS.length)]}-${n}`;
    if (!taken.has(s)) return s;
  }
}
