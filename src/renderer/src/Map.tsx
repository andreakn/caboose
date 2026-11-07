import { useEffect, useState } from "react";
import { COUNTRIES, EDGES, LANDMARKS, STATION_INFO, STATIONS, stationLabel, stationOf } from "../../shared/stations.ts";
import type { Feature, FeatureOverview, StationVisit } from "../../shared/types.ts";
import { allMerged, useOverview } from "./Overview.tsx";

/**
 * Where a station stands, as on the feature's dot: green while active, brown
 * while GitHub checks run, purple once merged; when it has ended, light
 * purple (merged, archived), grey (merged, deleted) or red (abandoned).
 */
export type StationState = "active" | "busy" | "merged" | "aborted" | "archived" | "deleted";

export const STATE_LABELS: Record<StationState, string> = {
  active: "active",
  busy: "GitHub checks running",
  merged: "merged",
  aborted: "abandoned (not merged)",
  archived: "merged and archived",
  deleted: "merged and deleted",
};

/** A live feature's state from its overview. */
export function liveState(f: Feature, ov: FeatureOverview | null | undefined): StationState {
  const merged = allMerged(ov);
  if (f.archived) return merged ? "archived" : "aborted";
  if (merged) return "merged";
  const checking = ov?.repos.some((r) => r.pr && (r.pr.state === "OPEN" || r.pr.state === "DRAFT") && r.pr.checks.state === "pending");
  return checking ? "busy" : "active";
}

const visitState = (v: StationVisit): StationState => (!v.merged ? "aborted" : v.ended === "archived" ? "archived" : "deleted");

// A schematic projection: longitude squeezed by the latitude's cosine, so the Nordics keep their shape.
const LON0 = 4;
const LAT0 = 71.5;
const SCALE = 60;
const K = Math.cos((63 * Math.PI) / 180);
const X = (lon: number) => (lon - LON0) * K * SCALE;
const Y = (lat: number) => (LAT0 - lat) * SCALE;
const WIDTH = X(32);
const HEIGHT = Y(54.4);
/** Labels moved down a little where two places sit close (Tornio and Kemi). */
const LABEL_DROP: Record<string, number> = { kemi: 10, "tornio-itainen": -4 };
/** All the track as one path: one element instead of 1,400 keeps the map light. */
const TRACK = EDGES.map(([a, b]) => {
  const [p, q] = [STATION_INFO[a], STATION_INFO[b]];
  return `M${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}L${X(q.lon).toFixed(1)},${Y(q.lat).toFixed(1)}`;
}).join("");

/** The Nordics as a metro map: lines always, a station's dot once a feature has been named after it. */
export function MapView(props: { features: Feature[]; visits: StationVisit[]; onOpen: (featureId: string) => void }) {
  // Live features report their state from their own overview.
  const [live, setLive] = useState<Record<string, StationState>>({});
  const report = (id: string, s: StationState) => setLive((m) => (m[id] === s ? m : { ...m, [id]: s }));

  // Per station: the newest live feature, else the newest ended one.
  const byStation = new Map<string, { label: string; state?: StationState; title?: string; featureId?: string; uses: number; when: string }>();
  for (const v of props.visits) {
    const id = stationOf(v.station);
    if (!id) continue;
    const prev = byStation.get(id);
    byStation.set(id, {
      label: stationLabel(v.station),
      state: visitState(v),
      title: v.title,
      uses: (prev?.uses ?? 0) + 1,
      when: `${visitState(v) === "aborted" ? "ended" : STATE_LABELS[visitState(v)]} ${v.endedAt.slice(0, 10)}`,
    });
  }
  for (const f of [...props.features].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const id = stationOf(f.name);
    if (!id) continue;
    const prev = byStation.get(id);
    byStation.set(id, { label: stationLabel(f.name), state: live[f.id], title: f.title, featureId: f.id, uses: (prev?.uses ?? 0) + 1, when: `since ${f.createdAt.slice(0, 10)}` });
  }

  const counts: Partial<Record<StationState, number>> = {};
  for (const s of byStation.values()) if (s.state) counts[s.state] = (counts[s.state] ?? 0) + 1;

  return (
    <div className="settings map-page">
      {props.features.map((f) => (
        <LiveProbe key={f.id} f={f} report={report} />
      ))}
      <header className="ws-header">
        <h1>Map</h1>
        <span className="muted">
          {byStation.size} of {STATIONS.length} stations visited
        </span>
      </header>
      <div className="map-legend">
        {(Object.keys(STATE_LABELS) as StationState[]).map((s) => (
          <span key={s} className="map-legend-item">
            <span className={`map-dot st-${s}`} />
            {STATE_LABELS[s]}
            {counts[s] ? <b>{counts[s]}</b> : null}
          </span>
        ))}
      </div>
      <div className="map-frame">
        <svg className="nordic-map" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map of the Nordic railway stations">
          <rect className="map-sea" x={0} y={0} width={WIDTH} height={HEIGHT} />
          {Object.entries(COUNTRIES).map(([c, shapes]) =>
            shapes.map((pts, i) => (
              <polygon key={`${c}${i}`} className={`map-land land-${c}`} points={pts.map(([lon, lat]) => `${X(lon)},${Y(lat)}`).join(" ")} />
            )),
          )}
          <path className="map-line" d={TRACK} />
          {LANDMARKS.map(({ id, label }) => {
            const h = STATION_INFO[id];
            return (
              <g key={id} className="map-hub">
                <circle cx={X(h.lon)} cy={Y(h.lat)} r={4.5} />
                <text x={X(h.lon) + 7} y={Y(h.lat) + 3.5 + (LABEL_DROP[id] ?? 0)}>
                  {label}
                </text>
              </g>
            );
          })}
          {[...byStation.entries()].map(([id, s]) => {
            const p = STATION_INFO[id];
            const state = s.state ?? "active";
            return (
              <g
                key={id}
                className={`map-station${s.featureId ? " live" : ""}`}
                onClick={() => s.featureId && props.onOpen(s.featureId)}
              >
                <title>
                  {`${s.label}${s.title ? ` · ${s.title}` : ""}\n${STATE_LABELS[state]} · ${s.when}${s.uses > 1 ? `\nused ${s.uses} times` : ""}`}
                </title>
                <circle className={`map-dot st-${state}`} cx={X(p.lon)} cy={Y(p.lat)} r={6.5} />
                <text x={X(p.lon) + 9} y={Y(p.lat) + 4}>
                  {s.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted small map-credit">Stations and track: © OpenStreetMap contributors (ODbL). Lines drawn straight between neighbouring stops.</p>
    </div>
  );
}

/** Asks a live feature's overview for its state (PRs merged, checks running) and reports it. */
function LiveProbe({ f, report }: { f: Feature; report: (id: string, s: StationState) => void }) {
  const { ov } = useOverview(f);
  const state = liveState(f, ov);
  useEffect(() => report(f.id, state), [f.id, state]);
  return null;
}
