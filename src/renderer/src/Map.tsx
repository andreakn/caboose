import { type ReactNode, useEffect, useRef, useState } from "react";
import { COUNTRIES, EDGES, LANDMARKS, nearestStation, STATION_INFO, STATIONS, stationLabel, stationOf } from "../../shared/stations.ts";
import type { Feature, FeatureOverview, HomeArea, StationVisit } from "../../shared/types.ts";
import { deployProgress } from "../../shared/stages.ts";
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

/** Every tracked repo is tagged for its last stage (e.g. in prod). */
export function shippedAll(repos: { name: string; stages?: string[]; release?: { stage: string; tags: string[] }[] }[]): boolean {
  const progress = deployProgress(repos);
  const last = progress.at(-1);
  return Boolean(last && last.total > 0 && last.done === last.total);
}

/** An ended feature's releases as repos with stages (as the overview gives them). */
const visitRepos = (v: StationVisit) => (v.releases ?? []).map((r) => ({ name: r.repo, stages: r.stages, release: r.release }));

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
/** Back from the map to degrees. */
const LON = (x: number) => x / (K * SCALE) + LON0;
const LAT = (y: number) => LAT0 - y / SCALE;
/** How far the home area's halo reaches, in degrees of latitude (only a hint: names spread from the point). */
const HOME_HALO = 0.45;
const WIDTH = X(32);
const HEIGHT = Y(54.4);
/** Labels moved down a little where two places sit close (Tornio and Kemi). */
const LABEL_DROP: Record<string, number> = { kemi: 10, "tornio-itainen": -4 };
type View = { x: number; y: number; w: number; h: number };
const FULL: View = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
const MAX_ZOOM = 30;
/** Keeps the view over the map (a little slack at the edges). */
const clamp = (v: View): View => ({
  ...v,
  x: Math.min(Math.max(v.x, -v.w * 0.25), WIDTH - v.w * 0.75),
  y: Math.min(Math.max(v.y, -v.h * 0.25), HEIGHT - v.h * 0.75),
});
/** All the track as one path: one element instead of 1,400 keeps the map light. */
const TRACK = EDGES.map(([a, b]) => {
  const [p, q] = [STATION_INFO[a], STATION_INFO[b]];
  return `M${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}L${X(q.lon).toFixed(1)},${Y(q.lat).toFixed(1)}`;
}).join("");

/** "near Trondheim S": the home area in words. */
export const homeLabel = (h: HomeArea) => `near ${stationLabel(nearestStation(h))}`;

/**
 * The Nordics with their track, zoomable (scroll, double-click, the buttons)
 * and draggable. `children` draws on top (given the zoom, to keep sizes on
 * screen); with `onPick`, a click picks a point instead of reaching them.
 */
export function MapCanvas(props: { home?: HomeArea; onPick?: (p: HomeArea) => void; children?: (k: number) => ReactNode }) {
  // Zoom and pan: the svg's viewBox. Dots, labels and lines keep their size on screen.
  const [view, setView] = useState(FULL);
  const viewRef = useRef(view);
  viewRef.current = view;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const k = WIDTH / view.w;
  /** A point on screen as a point on the map. */
  const toMap = (clientX: number, clientY: number) => new DOMPoint(clientX, clientY).matrixTransform(svgRef.current!.getScreenCTM()!.inverse());
  /** Zooms by `factor` (< 1 is in) around a point on screen, or the middle. */
  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const v = viewRef.current;
    let cx = v.x + v.w / 2;
    let cy = v.y + v.h / 2;
    if (clientX !== undefined && clientY !== undefined) {
      const p = toMap(clientX, clientY);
      [cx, cy] = [p.x, p.y];
    }
    const w = Math.min(WIDTH, Math.max(WIDTH / MAX_ZOOM, v.w * factor));
    const f = w / v.w;
    // Several wheel events can arrive before React renders: each builds on the last.
    viewRef.current = clamp({ x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f, w, h: (w * HEIGHT) / WIDTH });
    setView(viewRef.current);
  };
  // Scrolling zooms (a pinch on a trackpad too); React's own wheel handler cannot prevent the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX, e.clientY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);
  const home = props.home;

  return (
    <div className="map-frame">
      <div className="map-zoom">
        <button title="Zoom in (or scroll)" onClick={() => zoomAt(1 / 1.6)}>
          +
        </button>
        <button title="Zoom out" onClick={() => zoomAt(1.6)}>
          −
        </button>
        <button title="The whole map" disabled={k === 1} onClick={() => setView(FULL)}>
          ⟲
        </button>
      </div>
      <svg
        ref={svgRef}
        className={`nordic-map${drag.current ? " dragging" : ""}${props.onPick ? " picking" : ""}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Map of the Nordic railway stations"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          const scale = svgRef.current!.getScreenCTM()!.a;
          setView(clamp({ ...d.view, x: d.view.x - dx / scale, y: d.view.y - dy / scale }));
        }}
        onPointerUp={() => {
          if (drag.current?.moved) suppressClick.current = true;
          drag.current = null;
        }}
        onClickCapture={(e) => {
          // A drag is not a click on whatever was under the pointer; picking is not opening a station.
          if (suppressClick.current) {
            suppressClick.current = false;
            e.stopPropagation();
            return;
          }
          if (!props.onPick) return;
          e.stopPropagation();
          const p = toMap(e.clientX, e.clientY);
          props.onPick({ lon: LON(p.x), lat: LAT(p.y) });
        }}
        onDoubleClick={(e) => zoomAt(1 / 2, e.clientX, e.clientY)}
      >
        <rect className="map-sea" x={-WIDTH} y={-HEIGHT} width={WIDTH * 3} height={HEIGHT * 3} />
        {Object.entries(COUNTRIES).map(([c, shapes]) =>
          shapes.map((pts, i) => (
            <polygon key={`${c}${i}`} className={`map-land land-${c}`} points={pts.map(([lon, lat]) => `${X(lon)},${Y(lat)}`).join(" ")} />
          )),
        )}
        {home && <circle className="map-home-area" cx={X(home.lon)} cy={Y(home.lat)} r={HOME_HALO * SCALE} />}
        <path className="map-line" d={TRACK} />
        {LANDMARKS.map(({ id, label }) => {
          const h = STATION_INFO[id];
          return (
            <g key={id} className="map-hub">
              <circle cx={X(h.lon)} cy={Y(h.lat)} r={4.5 / k} />
              <text x={X(h.lon) + 7 / k} y={Y(h.lat) + (3.5 + (LABEL_DROP[id] ?? 0)) / k} style={{ fontSize: 11 / k }}>
                {label}
              </text>
            </g>
          );
        })}
        {props.children?.(k)}
        {home && (
          <g className="map-home">
            <title>{`Home area, ${homeLabel(home)}: new features are named after the stations nearest it first`}</title>
            <path d={`M${X(home.lon)},${Y(home.lat)}l${-7 / k},${-7 / k}v${-9 / k}h${14 / k}v${9 / k}z`} />
            <path className="map-home-roof" d={`M${X(home.lon) - 9 / k},${Y(home.lat) - 15 / k}l${9 / k},${-7 / k}l${9 / k},${7 / k}`} />
          </g>
        )}
      </svg>
    </div>
  );
}

/** The Nordics as a metro map: lines always, a station's dot once a feature has been named after it. */
export function MapView(props: { features: Feature[]; visits: StationVisit[]; home?: HomeArea; onHome: (h: HomeArea | null) => void; onOpen: (featureId: string) => void }) {
  const [picking, setPicking] = useState(false);
  // Live features report their state from their own overview.
  const [live, setLive] = useState<Record<string, StationState>>({});
  const report = (id: string, s: StationState) => setLive((m) => (m[id] === s ? m : { ...m, [id]: s }));
  // Features that have reached the last release stage everywhere they are tracked (a gold ring).
  const [liveShipped, setLiveShipped] = useState<Record<string, boolean>>({});
  const reportShipped = (id: string, v: boolean) => setLiveShipped((m) => (m[id] === v ? m : { ...m, [id]: v }));

  // Per station: the newest live feature, else the newest ended one.
  const byStation = new Map<string, { label: string; state?: StationState; title?: string; featureId?: string; uses: number; when: string; shipped?: boolean }>();
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
      shipped: shippedAll(visitRepos(v)),
    });
  }
  for (const f of [...props.features].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const id = stationOf(f.name);
    if (!id) continue;
    const prev = byStation.get(id);
    byStation.set(id, { label: stationLabel(f.name), state: live[f.id], title: f.title, featureId: f.id, uses: (prev?.uses ?? 0) + 1, when: `since ${f.createdAt.slice(0, 10)}`, shipped: liveShipped[f.id] });
  }

  const counts: Partial<Record<StationState, number>> = {};
  for (const s of byStation.values()) if (s.state) counts[s.state] = (counts[s.state] ?? 0) + 1;

  return (
    <div className="settings map-page">
      {props.features.map((f) => (
        <LiveProbe key={f.id} f={f} report={report} reportShipped={reportShipped} />
      ))}
      <header className="ws-header">
        <h1>Map</h1>
        <span className="muted">
          {byStation.size} of {STATIONS.length} stations visited
        </span>
        <span className="spacer" />
        {picking ? (
          <span className="map-home-tools">
            <b>Click the map where home is.</b>
            <button onClick={() => setPicking(false)}>Cancel</button>
          </span>
        ) : (
          <span className="map-home-tools">
            <span className="muted" title="New features are named after the stations nearest home first, then further and further out">
              {props.home ? `⌂ Home ${homeLabel(props.home)}` : "No home area: names come from anywhere"}
            </span>
            <button onClick={() => setPicking(true)}>{props.home ? "Move home" : "Set home area"}</button>
            {props.home && (
              <button className="link" onClick={() => props.onHome(null)}>
                Clear
              </button>
            )}
          </span>
        )}
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
      <MapCanvas
        home={props.home}
        onPick={
          picking
            ? (h) => {
                setPicking(false);
                props.onHome(h);
              }
            : undefined
        }
      >
        {(k) =>
          [...byStation.entries()].map(([id, s]) => {
            const p = STATION_INFO[id];
            const state = s.state ?? "active";
            return (
              <g
                key={id}
                className={`map-station${s.featureId ? " live" : ""}`}
                onClick={() => {
                  if (s.featureId) props.onOpen(s.featureId);
                }}
              >
                <title>
                  {`${s.label}${s.title ? ` · ${s.title}` : ""}\n${STATE_LABELS[state]} · ${s.when}${s.shipped ? "\nshipped all the way (every release stage)" : ""}${s.uses > 1 ? `\nused ${s.uses} times` : ""}`}
                </title>
                {s.shipped && <circle className="map-shipped" cx={X(p.lon)} cy={Y(p.lat)} r={10 / k} />}
                <circle className={`map-dot st-${state}`} cx={X(p.lon)} cy={Y(p.lat)} r={6.5 / k} />
                <text x={X(p.lon) + 9 / k} y={Y(p.lat) + 4 / k} style={{ fontSize: 12 / k, strokeWidth: 3 / k }}>
                  {s.label}
                </text>
              </g>
            );
          })
        }
      </MapCanvas>
      <p className="muted small map-credit">Stations and track: © OpenStreetMap contributors (ODbL). Lines drawn straight between neighbouring stops.</p>
    </div>
  );
}

/** Asks a live feature's overview for its state (PRs merged, checks running) and reports it. */
function LiveProbe(props: { f: Feature; report: (id: string, s: StationState) => void; reportShipped: (id: string, v: boolean) => void }) {
  const { f, report } = props;
  const { ov } = useOverview(f);
  const state = liveState(f, ov);
  const shipped = shippedAll(ov?.repos ?? []);
  useEffect(() => report(f.id, state), [f.id, state]);
  useEffect(() => props.reportShipped(f.id, shipped), [f.id, shipped]);
  return null;
}
