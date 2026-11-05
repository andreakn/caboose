// Placeholder workspace names: Nordic railway stations, in ASCII so they are
// safe as folder and branch names everywhere (å/ä/æ → a, ö/ø → o).
export const STATIONS = [
  // Norway
  "finse", "myrdal", "flam", "dombas", "hjerkinn", "kongsvoll", "oppdal", "roros",
  "voss", "geilo", "gol", "haugastol", "ustaoset", "bodo", "fauske", "mosjoen",
  "narvik", "hamar", "otta", "dovre", "bjorli", "andalsnes", "storen", "steinkjer",
  "levanger", "egersund", "nelaug", "lunde", "kongsberg", "drammen", "halden", "larvik",
  "elverum", "kongsvinger", "tynset", "grong", "snasa", "bo",
  // Sweden
  "abisko", "kiruna", "gallivare", "boden", "lulea", "jokkmokk", "arvidsjaur", "ostersund",
  "storlien", "are", "sundsvall", "gavle", "uppsala", "mora", "falun", "karlstad",
  "kil", "hallsberg", "nassjo", "alvesta", "hassleholm", "lund", "malmo", "ystad",
  "kalmar", "linkoping", "norrkoping", "orebro", "katrineholm", "bastutrask", "vannas", "krylbo",
  // Denmark
  "fredericia", "odense", "nyborg", "korsor", "roskilde", "hillerod", "helsingor", "esbjerg",
  "struer", "skagen", "frederikshavn", "aalborg", "aarhus", "randers", "viborg", "tinglev",
  "padborg", "tonder", "ribe", "kolding", "vejle", "horsens", "skjern", "thisted",
  // Finland
  "kolari", "rovaniemi", "kemijarvi", "oulu", "kajaani", "kuopio", "iisalmi", "joensuu",
  "pieksamaki", "seinajoki", "haapamaki", "riihimaki", "toijala", "tampere", "turku", "hanko",
  "karjaa", "lahti", "kouvola", "kotka", "imatra", "savonlinna", "parikkala", "ylivieska",
  "kokkola", "vaasa", "mikkeli", "kontiomaki",
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
