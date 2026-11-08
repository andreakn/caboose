// Nordic railway stations: feature names, and the map. Each station's id is
// ASCII (å/ä/æ → a, ö/ø → o) because it is a folder, branch and script value;
// its `name` is the proper spelling, which is what the screen shows.
// The stations and the track between them come from OpenStreetMap
// (stations-data.ts, made by scripts/stations-from-osm.ts); positions are
// real, lines are drawn straight between neighbouring stops, like a metro map.
import { HUB_IDS } from "./stations-curated.ts";
import { OSM_EDGES, OSM_STATIONS } from "./stations-data.ts";

export type Country = "no" | "se" | "dk" | "fi";
export type Station = { name: string; country: Country; lon: number; lat: number };

/** Every station a feature can be named after (about 1,800). */
export const STATION_INFO: Record<string, Station> = OSM_STATIONS;
export const STATIONS = Object.keys(STATION_INFO);

/** Distance in degrees of latitude, longitude squeezed by the latitude's cosine (good enough at this scale). */
export function distance(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * k, a.lat - b.lat);
}

/** The station nearest a point. */
export function nearestStation(p: { lon: number; lat: number }): string {
  let best = STATIONS[0];
  for (const s of STATIONS) if (distance(p, STATION_INFO[s]) < distance(p, STATION_INFO[best])) best = s;
  return best;
}

/** Track between neighbouring stations. */
export const EDGES: [string, string][] = OSM_EDGES;

/** Big stations always labelled on the map, so it can be read before any dot appears. */
export const LANDMARKS: { id: string; label: string }[] = Object.values(HUB_IDS).filter((h) => STATION_INFO[h.id]);

/** The country outlines, much simplified (lon, lat), for the map's background. */
export const COUNTRIES: Record<Country, [number, number][][]> = {
  no: [
    [
      [7.05, 57.98], [8.0, 58.15], [8.8, 58.45], [10.0, 59.0], [10.5, 59.6], [10.7, 59.9], [11.0, 59.3], [11.4, 59.1],
      [12.3, 60.0], [12.6, 61.0], [12.2, 62.0], [12.1, 63.0], [12.2, 64.0], [14.3, 65.0], [15.5, 66.0], [16.4, 67.5],
      [18.1, 68.5], [20.5, 69.06], [21.0, 69.3], [22.4, 68.9], [24.0, 68.6], [25.8, 69.0], [27.0, 69.9], [27.9, 70.1],
      [28.8, 69.7], [29.2, 69.5], [30.9, 69.6], [31.1, 70.3], [28.5, 71.0], [25.8, 71.1], [23.0, 70.6], [19.0, 70.1],
      [16.0, 69.0], [14.5, 68.2], [13.0, 67.2], [12.5, 66.0], [11.0, 64.9], [10.0, 64.0], [8.6, 63.5], [7.0, 62.8],
      [5.0, 62.0], [5.0, 61.0], [4.9, 60.0], [5.5, 59.0], [5.6, 58.5], [6.5, 58.1],
    ],
  ],
  se: [
    [
      [11.2, 58.9], [11.9, 57.7], [12.5, 56.6], [12.9, 55.6], [14.2, 55.4], [14.6, 56.1], [16.0, 56.2], [16.6, 57.0],
      [16.5, 58.0], [17.5, 59.0], [18.9, 59.6], [17.5, 60.6], [17.3, 61.5], [17.4, 62.4], [19.0, 63.4], [20.5, 63.8],
      [21.5, 64.8], [22.2, 65.6], [24.1, 65.8], [23.6, 66.4], [23.7, 67.0], [23.4, 68.0], [22.4, 68.4], [20.5, 69.06],
      [18.1, 68.5], [16.4, 67.5], [15.5, 66.0], [14.3, 65.0], [12.2, 64.0], [12.1, 63.0], [12.2, 62.0], [12.6, 61.0],
      [12.3, 60.0], [11.4, 59.1],
    ],
  ],
  fi: [
    [
      [22.95, 59.82], [25.0, 60.15], [26.9, 60.45], [27.8, 60.55], [29.4, 61.2], [31.5, 62.9], [30.0, 63.8], [29.9, 64.8],
      [29.6, 65.8], [29.9, 67.0], [28.7, 68.2], [28.4, 68.9], [28.8, 69.7], [27.9, 70.1], [27.0, 69.9], [25.8, 69.0],
      [24.0, 68.6], [22.4, 68.9], [21.0, 69.3], [20.5, 69.06], [22.4, 68.4], [23.4, 68.0], [23.7, 67.0], [23.6, 66.4],
      [24.1, 65.8], [25.3, 65.0], [24.5, 64.5], [23.0, 63.8], [21.6, 63.1], [21.3, 62.3], [21.5, 61.3], [21.4, 60.7],
      [22.3, 60.3],
    ],
  ],
  dk: [
    [
      [8.6, 54.9], [9.9, 54.8], [10.0, 55.3], [9.6, 55.5], [9.8, 55.9], [10.2, 56.1], [10.6, 56.4], [10.3, 56.9],
      [10.6, 57.74], [9.9, 57.6], [9.0, 57.1], [8.2, 56.9], [8.1, 56.5], [8.15, 55.6], [8.45, 55.47], [8.6, 55.1],
    ],
    [[9.7, 55.5], [10.2, 55.6], [10.8, 55.3], [10.6, 55.05], [10.0, 55.05], [9.75, 55.25]],
    [[11.1, 55.35], [11.5, 55.2], [12.2, 55.2], [12.6, 55.6], [12.6, 56.05], [12.0, 56.1], [11.6, 55.9], [11.1, 55.7]],
  ],
};

/** A feature's name on screen: "bodo" → "Bodø", "finse-2" → "Finse 2"; anything else as it is. */
export function stationLabel(id: string): string {
  const m = id.match(/^(.+?)(?:-(\d+))?$/);
  const s = m ? STATION_INFO[m[1]] : undefined;
  return s ? (m![2] ? `${s.name} ${m![2]}` : s.name) : id;
}

/** The station a feature name comes from ("finse-2" → "finse"), if it is one. */
export function stationOf(id: string): string | undefined {
  const base = id.replace(/-\d+$/, "");
  return STATION_INFO[base] ? base : undefined;
}
