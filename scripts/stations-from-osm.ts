// Builds src/shared/stations-data.ts from OpenStreetMap data (Overpass JSON):
//   node scripts/stations-from-osm.ts <dir>
// where <dir> holds (see the queries at the bottom):
//   all.json              every railway=station|halt in the four countries
//   st-SE.json            the same, Sweden only (Sweden's long borders are not
//                         simple to draw; the others are, see countryOf below)
//   routes.json           route=train relations with their member nodes
// The data is © OpenStreetMap contributors, ODbL.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATION_INFO as CURATED, HUB_IDS, LINES } from "../src/shared/stations-curated.ts";

type El = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[] };
type Country = "no" | "se" | "dk" | "fi";
type Out = { id: string; name: string; country: Country; lon: number; lat: number };

const dir = process.argv[2];
const load = (f: string): El[] => JSON.parse(readFileSync(join(dir, f), "utf8")).elements;
const pos = (e: El) => (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : e.center);
const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const dy = (a.lat - b.lat) * 111;
  const dx = (a.lon - b.lon) * 111 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
};

// --- stations: passenger heavy rail only
const NOT_TRAINS = new Set(["subway", "light_rail", "tram", "monorail", "funicular", "miniature"]);
const keep = (e: El) => {
  const t = e.tags ?? {};
  if (!t.name || !pos(e)) return false;
  if (NOT_TRAINS.has(t.station ?? "")) return false;
  // Metro and tram stops tagged by mode instead (Oslo's T-bane: railway=halt + subway=yes).
  if (t.train !== "yes" && [t.subway, t.light_rail, t.tram].some((v) => v === "yes" || v === "station")) return false;
  if (t.usage === "tourism" || t.tourism || t["railway:preserved"] === "yes" || t.disused || t["disused:railway"] || t.abandoned) return false;
  // Heritage and tourist railways, rail bikes, steamer quays, a theme park.
  if (/museum|museo|musei|veteran|smalspår|östra södermanlands|dvvj|hovedbanen|skånska järnvägar|chaparral/i.test(`${t.operator ?? ""} ${t.network ?? ""}`)) return false;
  if (/dressin|ångbåt|bryggan\b/i.test(t.name)) return false;
  return true;
};

const swedish = new Set(load("st-SE.json").map((e) => e.id));
/**
 * Sweden from its own query; of the rest, everything south of 57.9°N is
 * Danish (Norway ends at 57.98°N), and everything east of 20°E is Finnish
 * (Norway has no passenger railway there: Narvik is at 17.4°E).
 */
const countryOf = (e: El): Country => {
  if (swedish.has(e.id)) return "se";
  const p = pos(e)!;
  if (p.lat < 57.9) return "dk";
  if (p.lon > 20) return "fi";
  return "no";
};
const all = load("all.json").filter(keep);

/** "Mo i Rana / Måefie" → "Mo i Rana" (the first of two languages); "Sandviken station" → "Sandviken". */
const cleanName = (n: string) =>
  n
    .split(" / ")[0]
    .replace(/\s+(station|stasjon|holdeplass)$/i, "")
    .trim();

/** å/ä/æ → a, ö/ø → o (the convention of the first 122), everything else ASCII, words joined by "-". */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[åäæâà]/g, "a")
    .replace(/[öøô]/g, "o")
    .replace(/[éèê]/g, "e")
    .replace(/[ü]/g, "u")
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    // a trailing number would read as "the 2nd feature named after it"
    .replace(/-(\d+)$/, "$1");

const stations: Out[] = [];
for (const e of all) {
  const p = pos(e)!;
  const country = countryOf(e);
  const name = cleanName(e.tags!.name);
  // The same station mapped twice (node and area, or two halts): keep one.
  if (stations.some((s) => s.name === name && km(s, p) < 3)) continue;
  stations.push({ id: slug(name), name, country, lon: +p.lon.toFixed(4), lat: +p.lat.toFixed(4) });
}

// Keep the curated ids (features may already be named after them): the nearest station with that name.
for (const [id, c] of Object.entries(CURATED)) {
  const hit = stations
    .filter((s) => slug(s.name).startsWith(id) || s.name.toLowerCase().startsWith(c.name.toLowerCase()))
    .sort((a, b) => km(a, c) - km(b, c))[0];
  if (hit && km(hit, c) < 15) {
    hit.id = id;
    hit.name = c.name;
  } else stations.push({ id, name: c.name, country: c.country, lon: c.lon, lat: c.lat });
}

// Ids must be unique: same names in two places get the country (lunde, lunde-se), then a letter.
const seen = new Map<string, number>();
for (const s of stations) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
for (const s of stations) {
  if ((seen.get(s.id) ?? 0) > 1 && !CURATED[s.id]) s.id = `${s.id}-${s.country}`;
}
const final = new Map<string, Out>();
for (const s of stations) {
  let id = s.id;
  for (let i = 0; final.has(id); i++) id = `${s.id}-${"abcdefghij"[i]}`;
  final.set(id, { ...s, id });
}

// --- lines: consecutive stops of every train route, then express hops dropped
const routes = load("routes.json");
const nodes = new Map(routes.filter((e) => e.type === "node").map((e) => [e.id, e]));
const list = [...final.values()];
const nearest = (p: { lat: number; lon: number }, name?: string) => {
  let best: Out | undefined;
  let d = Infinity;
  for (const s of list) {
    const k = km(s, p) - (name && s.name === name ? 1 : 0);
    if (k < d) [best, d] = [s, k];
  }
  return d < 1.5 ? best : undefined;
};
const edges = new Map<string, [string, string]>();
let routeCount = 0;
for (const r of routes.filter((e) => e.type === "relation")) {
  const stops = (r.members ?? []).filter((m) => m.type === "node" && /^stop/.test(m.role)).map((m) => nodes.get(m.ref)).filter((n): n is El => Boolean(n));
  const ids = stops.map((n) => nearest(pos(n)!, n.tags?.name)?.id).filter((x): x is string => Boolean(x));
  const seq = ids.filter((id, i) => id !== ids[i - 1]);
  if (seq.length > 1) routeCount++;
  for (let i = 1; i < seq.length; i++) {
    const [a, b] = [seq[i - 1], seq[i]].sort();
    edges.set(`${a}|${b}`, [a, b]);
  }
}
// Where OSM has no train routes mapped, the hand-drawn main lines fill in: an
// edge between two of their stops is added unless the OSM track already
// links them by a path not much longer than the straight line.
const hubId = (id: string) => HUB_IDS[id]?.id ?? id;
const graph = () => {
  const g = new Map<string, Set<string>>();
  for (const [a, b] of edges.values()) {
    g.set(a, (g.get(a) ?? new Set()).add(b));
    g.set(b, (g.get(b) ?? new Set()).add(a));
  }
  return g;
};
/** The shortest track distance from a to b (km), Dijkstra, or Infinity. */
const trackKm = (g: Map<string, Set<string>>, a: string, b: string, limit: number) => {
  const dist = new Map([[a, 0]]);
  const todo = new Set([a]);
  while (todo.size) {
    let cur = "";
    let best = Infinity;
    for (const x of todo) if (dist.get(x)! < best) [cur, best] = [x, dist.get(x)!];
    todo.delete(cur);
    if (cur === b) return best;
    if (best > limit) return Infinity;
    for (const n of g.get(cur) ?? []) {
      const d = best + km(final.get(cur)!, final.get(n)!);
      if (d < (dist.get(n) ?? Infinity)) {
        dist.set(n, d);
        todo.add(n);
      }
    }
  }
  return Infinity;
};
let filled = 0;
{
  const g = graph();
  for (const l of LINES) {
    const stops = l.stops.map(hubId).filter((id) => final.has(id));
    for (let i = 1; i < stops.length; i++) {
      const [a, b] = [stops[i - 1], stops[i]].sort();
      if (edges.has(`${a}|${b}`)) continue;
      const straight = km(final.get(a)!, final.get(b)!);
      if (trackKm(g, a, b, straight * 1.6) <= straight * 1.6) continue;
      edges.set(`${a}|${b}`, [a, b]);
      g.set(a, (g.get(a) ?? new Set()).add(b));
      g.set(b, (g.get(b) ?? new Set()).add(a));
      filled++;
    }
  }
}

// An express hop A–C is dropped when A–B–C exists and is not much longer.
const st = (id: string) => final.get(id)!;
const adj = new Map<string, Set<string>>();
for (const [a, b] of edges.values()) {
  adj.set(a, (adj.get(a) ?? new Set()).add(b));
  adj.set(b, (adj.get(b) ?? new Set()).add(a));
}
let dropped = 0;
for (const [key, [a, b]] of [...edges.entries()].sort((x, y) => km(st(y[1][0]), st(y[1][1])) - km(st(x[1][0]), st(x[1][1])))) {
  const direct = km(st(a), st(b));
  const via = [...(adj.get(a) ?? [])].find((c) => c !== b && adj.get(c)?.has(b) && km(st(a), st(c)) + km(st(c), st(b)) < direct * 1.25);
  if (via) {
    edges.delete(key);
    adj.get(a)!.delete(b);
    adj.get(b)!.delete(a);
    dropped++;
  }
}

const byCountry = list.reduce<Record<string, number>>((m, s) => ((m[s.country] = (m[s.country] ?? 0) + 1), m), {});
const linked = new Set([...edges.values()].flat());
console.log(`stations ${final.size}`, byCountry, `routes ${routeCount}, edges ${edges.size} (${filled} filled in from the hand-drawn lines, ${dropped} express hops dropped), stations on a line ${linked.size}`);

const sorted = [...final.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(
  join("src", "shared", "stations-data.ts"),
  `// Generated by scripts/stations-from-osm.ts from OpenStreetMap (© OpenStreetMap contributors, ODbL). Do not edit.
import type { Station } from "./stations.ts";

export const OSM_STATIONS: Record<string, Station> = {
${sorted.map((s) => `  ${JSON.stringify(s.id)}: { name: ${JSON.stringify(s.name)}, country: "${s.country}", lon: ${s.lon}, lat: ${s.lat} },`).join("\n")}
};

/** Track between neighbouring stations, from the stops of every train route. */
export const OSM_EDGES: [string, string][] = [
${[...edges.values()].sort().map(([a, b]) => `  [${JSON.stringify(a)}, ${JSON.stringify(b)}],`).join("\n")}
];
`,
);

/* Overpass queries (overpass-api.de or a mirror):
all.json:
  [out:json][timeout:300];
  (area["ISO3166-1"="NO"][admin_level=2];area["ISO3166-1"="SE"][admin_level=2];area["ISO3166-1"="DK"][admin_level=2];area["ISO3166-1"="FI"][admin_level=2];)->.a;
  nwr["railway"~"^(station|halt)$"](area.a); out center tags;
st-SE.json: the same with only "SE".
routes.json:
  [out:json][timeout:600][bbox:54.5,4,71.5,32];
  rel["route"="train"]; out body; node(r); out body;
*/
