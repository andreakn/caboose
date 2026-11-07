// Station names and the map's data hold together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickStation } from "../src/main/core/stations.ts";
import { COUNTRIES, HUBS, LINES, STATION_INFO, STATIONS, stationLabel, stationOf } from "../src/shared/stations.ts";

test("ids are ASCII (folders, branches); names are spelled properly", () => {
  for (const id of STATIONS) assert.match(id, /^[a-z]+$/, id);
  assert.equal(stationLabel("bodo"), "Bodø");
  assert.equal(stationLabel("andalsnes"), "Åndalsnes");
  assert.equal(stationLabel("ostersund"), "Östersund");
  assert.equal(stationLabel("seinajoki-2"), "Seinäjoki 2");
  assert.equal(stationLabel("my-own-name"), "my-own-name");
  assert.equal(stationOf("korsor-3"), "korsor");
  assert.equal(stationOf("oslo"), undefined, "hubs are not feature names");
});

test("every station is on a line, every stop exists, every place is in the Nordics", () => {
  const onLines = new Set(LINES.flatMap((l) => l.stops));
  for (const id of STATIONS) assert.ok(onLines.has(id), `${id} is on no line`);
  for (const l of LINES) for (const s of l.stops) assert.ok(STATION_INFO[s] || HUBS[s], `${l.name}: unknown stop ${s}`);
  for (const p of [...Object.values(STATION_INFO), ...Object.values(HUBS)]) {
    assert.ok(p.lon > 4 && p.lon < 32 && p.lat > 54.5 && p.lat < 71.5, p.name);
  }
  assert.deepEqual(Object.keys(COUNTRIES).sort(), ["dk", "fi", "no", "se"]);
});

test("picking a name never repeats one in use", () => {
  const taken = new Set(STATIONS.slice(1));
  assert.equal(pickStation(taken), STATIONS[0]);
  assert.match(pickStation(new Set(STATIONS), () => 0), new RegExp(`^${STATIONS[0]}-2$`));
});
