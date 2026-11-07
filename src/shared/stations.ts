// Nordic railway stations: feature names, and the map. Each station's id is
// ASCII (å/ä/æ → a, ö/ø → o) because it is a folder, branch and script value;
// its `name` is the proper spelling, which is what the screen shows.
// Positions are approximate (longitude, latitude); lines are drawn as
// straight connections between stops, like a metro map.

export type Country = "no" | "se" | "dk" | "fi";
export type Station = { name: string; country: Country; lon: number; lat: number };

/** Stations a feature can be named after. */
export const STATION_INFO: Record<string, Station> = {
  // Norway
  finse: { name: "Finse", country: "no", lon: 7.5, lat: 60.6 },
  myrdal: { name: "Myrdal", country: "no", lon: 7.12, lat: 60.73 },
  flam: { name: "Flåm", country: "no", lon: 7.11, lat: 60.86 },
  dombas: { name: "Dombås", country: "no", lon: 9.12, lat: 62.07 },
  hjerkinn: { name: "Hjerkinn", country: "no", lon: 9.55, lat: 62.22 },
  kongsvoll: { name: "Kongsvoll", country: "no", lon: 9.62, lat: 62.3 },
  oppdal: { name: "Oppdal", country: "no", lon: 9.69, lat: 62.59 },
  roros: { name: "Røros", country: "no", lon: 11.39, lat: 62.57 },
  voss: { name: "Voss", country: "no", lon: 6.42, lat: 60.63 },
  geilo: { name: "Geilo", country: "no", lon: 8.21, lat: 60.53 },
  gol: { name: "Gol", country: "no", lon: 8.94, lat: 60.7 },
  haugastol: { name: "Haugastøl", country: "no", lon: 7.87, lat: 60.51 },
  ustaoset: { name: "Ustaoset", country: "no", lon: 8.05, lat: 60.5 },
  bodo: { name: "Bodø", country: "no", lon: 14.4, lat: 67.28 },
  fauske: { name: "Fauske", country: "no", lon: 15.39, lat: 67.26 },
  mosjoen: { name: "Mosjøen", country: "no", lon: 13.19, lat: 65.84 },
  narvik: { name: "Narvik", country: "no", lon: 17.43, lat: 68.44 },
  hamar: { name: "Hamar", country: "no", lon: 11.07, lat: 60.79 },
  otta: { name: "Otta", country: "no", lon: 9.54, lat: 61.77 },
  dovre: { name: "Dovre", country: "no", lon: 9.24, lat: 61.99 },
  bjorli: { name: "Bjorli", country: "no", lon: 8.2, lat: 62.26 },
  andalsnes: { name: "Åndalsnes", country: "no", lon: 7.69, lat: 62.57 },
  storen: { name: "Støren", country: "no", lon: 10.29, lat: 63.03 },
  steinkjer: { name: "Steinkjer", country: "no", lon: 11.5, lat: 64.01 },
  levanger: { name: "Levanger", country: "no", lon: 11.31, lat: 63.75 },
  egersund: { name: "Egersund", country: "no", lon: 6.0, lat: 58.45 },
  nelaug: { name: "Nelaug", country: "no", lon: 8.63, lat: 58.66 },
  lunde: { name: "Lunde", country: "no", lon: 9.1, lat: 59.3 },
  kongsberg: { name: "Kongsberg", country: "no", lon: 9.65, lat: 59.67 },
  drammen: { name: "Drammen", country: "no", lon: 10.2, lat: 59.74 },
  halden: { name: "Halden", country: "no", lon: 11.39, lat: 59.12 },
  larvik: { name: "Larvik", country: "no", lon: 10.03, lat: 59.05 },
  elverum: { name: "Elverum", country: "no", lon: 11.56, lat: 60.88 },
  kongsvinger: { name: "Kongsvinger", country: "no", lon: 12.0, lat: 60.19 },
  tynset: { name: "Tynset", country: "no", lon: 10.78, lat: 62.28 },
  grong: { name: "Grong", country: "no", lon: 12.31, lat: 64.46 },
  snasa: { name: "Snåsa", country: "no", lon: 12.38, lat: 64.25 },
  bo: { name: "Bø", country: "no", lon: 9.06, lat: 59.41 },
  // Sweden
  abisko: { name: "Abisko", country: "se", lon: 18.83, lat: 68.35 },
  kiruna: { name: "Kiruna", country: "se", lon: 20.23, lat: 67.86 },
  gallivare: { name: "Gällivare", country: "se", lon: 20.66, lat: 67.13 },
  boden: { name: "Boden", country: "se", lon: 21.69, lat: 65.83 },
  lulea: { name: "Luleå", country: "se", lon: 22.15, lat: 65.58 },
  jokkmokk: { name: "Jokkmokk", country: "se", lon: 19.83, lat: 66.61 },
  arvidsjaur: { name: "Arvidsjaur", country: "se", lon: 19.17, lat: 65.59 },
  ostersund: { name: "Östersund", country: "se", lon: 14.64, lat: 63.18 },
  storlien: { name: "Storlien", country: "se", lon: 12.1, lat: 63.32 },
  are: { name: "Åre", country: "se", lon: 13.08, lat: 63.4 },
  sundsvall: { name: "Sundsvall", country: "se", lon: 17.31, lat: 62.39 },
  gavle: { name: "Gävle", country: "se", lon: 17.14, lat: 60.67 },
  uppsala: { name: "Uppsala", country: "se", lon: 17.64, lat: 59.86 },
  mora: { name: "Mora", country: "se", lon: 14.54, lat: 61.0 },
  falun: { name: "Falun", country: "se", lon: 15.63, lat: 60.61 },
  karlstad: { name: "Karlstad", country: "se", lon: 13.5, lat: 59.38 },
  kil: { name: "Kil", country: "se", lon: 13.32, lat: 59.5 },
  hallsberg: { name: "Hallsberg", country: "se", lon: 15.11, lat: 59.07 },
  nassjo: { name: "Nässjö", country: "se", lon: 14.69, lat: 57.65 },
  alvesta: { name: "Alvesta", country: "se", lon: 14.56, lat: 56.9 },
  hassleholm: { name: "Hässleholm", country: "se", lon: 13.77, lat: 56.16 },
  lund: { name: "Lund", country: "se", lon: 13.19, lat: 55.7 },
  malmo: { name: "Malmö", country: "se", lon: 13.0, lat: 55.61 },
  ystad: { name: "Ystad", country: "se", lon: 13.82, lat: 55.43 },
  kalmar: { name: "Kalmar", country: "se", lon: 16.36, lat: 56.66 },
  linkoping: { name: "Linköping", country: "se", lon: 15.62, lat: 58.41 },
  norrkoping: { name: "Norrköping", country: "se", lon: 16.18, lat: 58.59 },
  orebro: { name: "Örebro", country: "se", lon: 15.21, lat: 59.27 },
  katrineholm: { name: "Katrineholm", country: "se", lon: 16.21, lat: 58.99 },
  bastutrask: { name: "Bastuträsk", country: "se", lon: 20.04, lat: 64.79 },
  vannas: { name: "Vännäs", country: "se", lon: 19.75, lat: 63.91 },
  krylbo: { name: "Krylbo", country: "se", lon: 16.21, lat: 60.13 },
  // Denmark
  fredericia: { name: "Fredericia", country: "dk", lon: 9.75, lat: 55.57 },
  odense: { name: "Odense", country: "dk", lon: 10.39, lat: 55.4 },
  nyborg: { name: "Nyborg", country: "dk", lon: 10.8, lat: 55.31 },
  korsor: { name: "Korsør", country: "dk", lon: 11.14, lat: 55.33 },
  roskilde: { name: "Roskilde", country: "dk", lon: 12.09, lat: 55.64 },
  hillerod: { name: "Hillerød", country: "dk", lon: 12.31, lat: 55.93 },
  helsingor: { name: "Helsingør", country: "dk", lon: 12.61, lat: 56.04 },
  esbjerg: { name: "Esbjerg", country: "dk", lon: 8.45, lat: 55.47 },
  struer: { name: "Struer", country: "dk", lon: 8.59, lat: 56.49 },
  skagen: { name: "Skagen", country: "dk", lon: 10.59, lat: 57.72 },
  frederikshavn: { name: "Frederikshavn", country: "dk", lon: 10.54, lat: 57.44 },
  aalborg: { name: "Aalborg", country: "dk", lon: 9.92, lat: 57.05 },
  aarhus: { name: "Aarhus", country: "dk", lon: 10.2, lat: 56.15 },
  randers: { name: "Randers", country: "dk", lon: 10.04, lat: 56.46 },
  viborg: { name: "Viborg", country: "dk", lon: 9.4, lat: 56.45 },
  tinglev: { name: "Tinglev", country: "dk", lon: 9.25, lat: 54.94 },
  padborg: { name: "Padborg", country: "dk", lon: 9.36, lat: 54.82 },
  tonder: { name: "Tønder", country: "dk", lon: 8.86, lat: 54.93 },
  ribe: { name: "Ribe", country: "dk", lon: 8.76, lat: 55.33 },
  kolding: { name: "Kolding", country: "dk", lon: 9.47, lat: 55.49 },
  vejle: { name: "Vejle", country: "dk", lon: 9.53, lat: 55.71 },
  horsens: { name: "Horsens", country: "dk", lon: 9.85, lat: 55.86 },
  skjern: { name: "Skjern", country: "dk", lon: 8.5, lat: 55.95 },
  thisted: { name: "Thisted", country: "dk", lon: 8.69, lat: 56.96 },
  // Finland
  kolari: { name: "Kolari", country: "fi", lon: 23.8, lat: 67.33 },
  rovaniemi: { name: "Rovaniemi", country: "fi", lon: 25.72, lat: 66.5 },
  kemijarvi: { name: "Kemijärvi", country: "fi", lon: 27.43, lat: 66.71 },
  oulu: { name: "Oulu", country: "fi", lon: 25.47, lat: 65.01 },
  kajaani: { name: "Kajaani", country: "fi", lon: 27.73, lat: 64.23 },
  kuopio: { name: "Kuopio", country: "fi", lon: 27.68, lat: 62.89 },
  iisalmi: { name: "Iisalmi", country: "fi", lon: 27.19, lat: 63.56 },
  joensuu: { name: "Joensuu", country: "fi", lon: 29.76, lat: 62.6 },
  pieksamaki: { name: "Pieksämäki", country: "fi", lon: 27.13, lat: 62.3 },
  seinajoki: { name: "Seinäjoki", country: "fi", lon: 22.84, lat: 62.79 },
  haapamaki: { name: "Haapamäki", country: "fi", lon: 24.46, lat: 62.25 },
  riihimaki: { name: "Riihimäki", country: "fi", lon: 24.77, lat: 60.74 },
  toijala: { name: "Toijala", country: "fi", lon: 23.87, lat: 61.17 },
  tampere: { name: "Tampere", country: "fi", lon: 23.76, lat: 61.5 },
  turku: { name: "Turku", country: "fi", lon: 22.27, lat: 60.45 },
  hanko: { name: "Hanko", country: "fi", lon: 22.95, lat: 59.82 },
  karjaa: { name: "Karjaa", country: "fi", lon: 23.66, lat: 60.07 },
  lahti: { name: "Lahti", country: "fi", lon: 25.66, lat: 60.98 },
  kouvola: { name: "Kouvola", country: "fi", lon: 26.7, lat: 60.87 },
  kotka: { name: "Kotka", country: "fi", lon: 26.94, lat: 60.47 },
  imatra: { name: "Imatra", country: "fi", lon: 28.77, lat: 61.17 },
  savonlinna: { name: "Savonlinna", country: "fi", lon: 28.88, lat: 61.87 },
  parikkala: { name: "Parikkala", country: "fi", lon: 29.5, lat: 61.55 },
  ylivieska: { name: "Ylivieska", country: "fi", lon: 24.55, lat: 64.07 },
  kokkola: { name: "Kokkola", country: "fi", lon: 23.13, lat: 63.84 },
  vaasa: { name: "Vaasa", country: "fi", lon: 21.62, lat: 63.1 },
  mikkeli: { name: "Mikkeli", country: "fi", lon: 27.27, lat: 61.69 },
  kontiomaki: { name: "Kontiomäki", country: "fi", lon: 27.72, lat: 64.34 },
};

export const STATIONS = Object.keys(STATION_INFO);

/** Junctions the lines run through (always on the map; never feature names). */
export const HUBS: Record<string, Station> = {
  oslo: { name: "Oslo", country: "no", lon: 10.75, lat: 59.91 },
  bergen: { name: "Bergen", country: "no", lon: 5.33, lat: 60.39 },
  trondheim: { name: "Trondheim", country: "no", lon: 10.4, lat: 63.43 },
  stavanger: { name: "Stavanger", country: "no", lon: 5.73, lat: 58.97 },
  stockholm: { name: "Stockholm", country: "se", lon: 18.06, lat: 59.33 },
  goteborg: { name: "Göteborg", country: "se", lon: 11.97, lat: 57.71 },
  kobenhavn: { name: "København", country: "dk", lon: 12.57, lat: 55.68 },
  helsinki: { name: "Helsinki", country: "fi", lon: 24.94, lat: 60.17 },
  kemi: { name: "Kemi", country: "fi", lon: 24.56, lat: 65.74 },
  tornio: { name: "Tornio", country: "fi", lon: 24.15, lat: 65.84 },
};

/** Railway lines as stops in order (stations and hubs). */
export const LINES: { name: string; stops: string[] }[] = [
  // Norway
  { name: "Bergensbanen", stops: ["oslo", "gol", "geilo", "ustaoset", "haugastol", "finse", "myrdal", "voss", "bergen"] },
  { name: "Flåmsbana", stops: ["myrdal", "flam"] },
  { name: "Dovrebanen", stops: ["oslo", "hamar", "otta", "dovre", "dombas", "hjerkinn", "kongsvoll", "oppdal", "storen", "trondheim"] },
  { name: "Raumabanen", stops: ["dombas", "bjorli", "andalsnes"] },
  { name: "Rørosbanen", stops: ["hamar", "elverum", "tynset", "roros", "storen"] },
  { name: "Nordlandsbanen", stops: ["trondheim", "levanger", "steinkjer", "snasa", "grong", "mosjoen", "fauske", "bodo"] },
  { name: "Sørlandsbanen", stops: ["oslo", "drammen", "kongsberg", "bo", "lunde", "nelaug", "egersund", "stavanger"] },
  { name: "Vestfoldbanen", stops: ["drammen", "larvik"] },
  { name: "Østfoldbanen", stops: ["oslo", "halden", "goteborg"] },
  { name: "Kongsvingerbanen", stops: ["oslo", "kongsvinger", "kil", "karlstad", "hallsberg"] },
  { name: "Meråkerbanen", stops: ["trondheim", "storlien", "are", "ostersund", "sundsvall"] },
  { name: "Ofotbanen", stops: ["narvik", "abisko", "kiruna", "gallivare", "boden", "lulea"] },
  // Sweden
  { name: "Inlandsbanan", stops: ["gallivare", "jokkmokk", "arvidsjaur", "ostersund", "mora"] },
  { name: "Stambanan genom Norrland", stops: ["boden", "bastutrask", "vannas", "sundsvall", "gavle", "uppsala", "stockholm"] },
  { name: "Dalabanan", stops: ["mora", "falun", "krylbo", "uppsala"] },
  { name: "Godsstråket", stops: ["krylbo", "orebro", "hallsberg"] },
  { name: "Västra stambanan", stops: ["goteborg", "hallsberg", "katrineholm", "stockholm"] },
  { name: "Södra stambanan", stops: ["katrineholm", "norrkoping", "linkoping", "nassjo", "alvesta", "hassleholm", "lund", "malmo"] },
  { name: "Kust till kust", stops: ["alvesta", "kalmar"] },
  { name: "Ystadbanan", stops: ["malmo", "ystad"] },
  { name: "Västkustbanan", stops: ["goteborg", "lund"] },
  { name: "Haparandabanan", stops: ["boden", "tornio", "kemi"] },
  // Denmark
  { name: "Øresundsbanen", stops: ["malmo", "kobenhavn"] },
  { name: "Kystbanen", stops: ["kobenhavn", "helsingor"] },
  { name: "Nordbanen", stops: ["kobenhavn", "hillerod", "helsingor"] },
  { name: "Vestbanen", stops: ["kobenhavn", "roskilde", "korsor", "nyborg", "odense", "fredericia"] },
  { name: "Østjyske længdebane", stops: ["padborg", "tinglev", "kolding", "fredericia", "vejle", "horsens", "aarhus", "randers", "aalborg", "frederikshavn", "skagen"] },
  { name: "Esbjergbanen", stops: ["kolding", "esbjerg"] },
  { name: "Marskbanen", stops: ["tinglev", "tonder", "ribe", "esbjerg"] },
  { name: "Vestjyske længdebane", stops: ["esbjerg", "skjern", "struer", "thisted"] },
  { name: "Langå–Struer", stops: ["randers", "viborg", "struer"] },
  // Finland
  { name: "Pääradat", stops: ["helsinki", "riihimaki", "toijala", "tampere", "seinajoki", "kokkola", "ylivieska", "oulu", "kemi", "rovaniemi", "kemijarvi"] },
  { name: "Kolarin rata", stops: ["tornio", "kolari"] },
  { name: "Vaasan rata", stops: ["seinajoki", "vaasa"] },
  { name: "Haapamäen rata", stops: ["seinajoki", "haapamaki", "tampere"] },
  { name: "Savon rata", stops: ["riihimaki", "lahti", "kouvola", "mikkeli", "pieksamaki", "kuopio", "iisalmi", "kajaani", "kontiomaki", "oulu"] },
  { name: "Karjalan rata", stops: ["kouvola", "imatra", "parikkala", "joensuu"] },
  { name: "Savonlinnan rata", stops: ["parikkala", "savonlinna"] },
  { name: "Pieksämäki–Joensuu", stops: ["pieksamaki", "joensuu"] },
  { name: "Kotkan rata", stops: ["kouvola", "kotka"] },
  { name: "Rantarata", stops: ["helsinki", "karjaa", "turku"] },
  { name: "Hangon rata", stops: ["karjaa", "hanko"] },
  { name: "Turku–Toijala", stops: ["turku", "toijala"] },
];

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
