// Placeholder workspace names: railway stations, Norwegian ones first.
export const STATIONS = [
  "finse", "myrdal", "flam", "dombas", "hjerkinn", "kongsvoll", "oppdal", "roros",
  "voss", "geilo", "gol", "haugastol", "ustaoset", "bodo", "fauske", "mosjoen",
  "narvik", "hamar", "otta", "dovre", "lesja", "bjorli", "andalsnes", "storen",
  "steinkjer", "levanger", "egersund", "nelaug", "bo", "lunde", "kongsberg", "drammen",
  "paddington", "euston", "waterloo", "marylebone", "victoria", "fenchurch", "kingscross", "stpancras",
  "shinjuku", "umeda", "shibuya", "hakata", "tenjin", "atocha", "termini", "centrale",
  "perrache", "nord", "lyonpart", "zurich", "bern", "chur", "zermatt", "andermatt",
  "grandcentral", "union", "southstation", "pennstation", "flinders", "roma", "napoli", "brig",
  "mallaig", "fortwilliam", "inverness", "thurso", "kyle", "penzance", "keswick", "settle",
];

/** A station not in `taken`; falls back to "<station>-2", "-3"... once all are used. */
export function pickStation(taken: Set<string>, random = Math.random): string {
  const free = STATIONS.filter((s) => !taken.has(s));
  if (free.length) return free[Math.floor(random() * free.length)];
  for (let n = 2; ; n++) {
    const s = `${STATIONS[Math.floor(random() * STATIONS.length)]}-${n}`;
    if (!taken.has(s)) return s;
  }
}
