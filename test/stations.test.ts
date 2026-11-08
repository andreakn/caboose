// Station names and the map's data hold together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { distance, NEAR_CHOICES, pickStation } from "../src/main/core/stations.ts";
import { STATION_INFO as CURATED } from "../src/shared/stations-curated.ts";
import { COUNTRIES, EDGES, LANDMARKS, STATION_INFO, STATIONS, stationLabel, stationOf } from "../src/shared/stations.ts";

test("ids are ASCII and unique (folders, branches); names are spelled properly", () => {
  for (const id of STATIONS) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, id);
  for (const id of STATIONS) assert.doesNotMatch(id, /-\d+$/, `${id} would read as "the 2nd feature named after it"`);
  assert.equal(stationLabel("bodo"), "Bodø");
  assert.equal(stationLabel("andalsnes"), "Åndalsnes");
  assert.equal(stationLabel("ostersund"), "Östersund");
  assert.equal(stationLabel("seinajoki-2"), "Seinäjoki 2");
  assert.equal(stationLabel("my-own-name"), "my-own-name");
  assert.equal(stationOf("korsor-3"), "korsor");
  assert.equal(stationOf("oslo-s"), "oslo-s");
});

test("the first 122 keep their ids, so existing features keep their names", () => {
  for (const id of Object.keys(CURATED)) assert.ok(STATION_INFO[id], id);
  assert.ok(STATIONS.length > 1500, `${STATIONS.length} stations`);
});

test("every edge joins two known stations, every place is in the Nordics", () => {
  for (const [a, b] of EDGES) assert.ok(STATION_INFO[a] && STATION_INFO[b], `${a}–${b}`);
  for (const [id, p] of Object.entries(STATION_INFO)) assert.ok(p.lon > 4 && p.lon < 32 && p.lat > 54.5 && p.lat < 71.5, id);
  assert.equal(LANDMARKS.length, 10, "every landmark is a station in the data");
  assert.deepEqual(Object.keys(COUNTRIES).sort(), ["dk", "fi", "no", "se"]);
});

test("picking a name never repeats one in use", () => {
  const taken = new Set(STATIONS.slice(1));
  assert.equal(pickStation(taken), STATIONS[0]);
  assert.match(pickStation(new Set(STATIONS), undefined, () => 0), new RegExp(`^${STATIONS[0]}-2$`));
});

test("with a home area, names spread outwards from it as features are made", () => {
  const home = { lon: 10.4, lat: 63.43 }; // Trondheim
  const taken = new Set<string>();
  const order: number[] = [];
  for (let i = 0; i < 30; i++) {
    const s = pickStation(taken, home, () => 0);
    order.push(distance(home, STATION_INFO[s]));
    taken.add(s);
  }
  assert.ok(order[0] < 0.05, "the first is at home");
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], "each next one is no closer");
  // A little variety: any of the few nearest free ones.
  const nearest = [...STATIONS].sort((a, b) => distance(home, STATION_INFO[a]) - distance(home, STATION_INFO[b])).slice(0, NEAR_CHOICES);
  assert.equal(pickStation(new Set(), home, () => 0.999), nearest.at(-1));
  assert.ok(nearest.includes(pickStation(new Set(), home)));
});
