// Sounds for when an agent is done or needs you, like Conductor's ping.
// Synthesised with Web Audio, so there are no sound files and they play the
// same on macOS, Windows and Linux.

export type SoundName = "ping" | "chime" | "bell" | "pop" | "whistle";
export type SoundChoice = SoundName | "off";
export type SoundKind = "done" | "needs";

export const SOUNDS: { value: SoundName; label: string }[] = [
  { value: "ping", label: "Ping" },
  { value: "chime", label: "Chime" },
  { value: "bell", label: "Bell (ding-ding)" },
  { value: "pop", label: "Pop" },
  { value: "whistle", label: "Train whistle" },
];

const DEFAULTS: Record<SoundKind, SoundChoice> = { done: "ping", needs: "bell" };

// --- preferences (this machine, localStorage like the other UI prefs)

export function soundFor(kind: SoundKind): SoundChoice {
  return (localStorage.getItem(`caboose-sound-${kind}`) as SoundChoice | null) ?? DEFAULTS[kind];
}
export function setSoundFor(kind: SoundKind, choice: SoundChoice): void {
  localStorage.setItem(`caboose-sound-${kind}`, choice);
}
export function soundVolume(): number {
  const v = Number(localStorage.getItem("caboose-sound-volume") ?? "0.6");
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
}
export function setSoundVolume(v: number): void {
  localStorage.setItem("caboose-sound-volume", String(v));
}
/** Only while Caboose is not the app in front. */
export function soundsInBackgroundOnly(): boolean {
  return localStorage.getItem("caboose-sound-background-only") === "1";
}
export function setSoundsInBackgroundOnly(on: boolean): void {
  localStorage.setItem("caboose-sound-background-only", on ? "1" : "0");
}

/** Plays the sound chosen for `kind`, if any (and if allowed right now). */
export function notifySound(kind: SoundKind): void {
  const choice = soundFor(kind);
  if (choice === "off" || (soundsInBackgroundOnly() && document.hasFocus())) return;
  playSound(choice, soundVolume());
}

// --- synthesis

let ctx: AudioContext | null = null;
let lastAt = 0;

/** One tone: `freq` Hz, starting `at` seconds from now, fading out over `decay` s. */
function tone(ac: AudioContext, out: AudioNode, freq: number, at: number, decay: number, gain: number, type: OscillatorType = "sine"): void {
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + decay + 0.05);
}

export function playSound(name: SoundName, volume = soundVolume()): void {
  // Several chats finishing at once ring once.
  if (performance.now() - lastAt < 400) return;
  lastAt = performance.now();
  ctx ??= new AudioContext();
  const ac = ctx;
  if (ac.state === "suspended") void ac.resume();
  const out = ac.createGain();
  out.gain.value = volume;
  out.connect(ac.destination);
  switch (name) {
    case "ping":
      tone(ac, out, 1318.5, 0, 0.7, 0.5);
      tone(ac, out, 2637, 0, 0.25, 0.08);
      break;
    case "chime":
      tone(ac, out, 880, 0, 0.9, 0.4);
      tone(ac, out, 1318.5, 0.13, 1.0, 0.4);
      break;
    case "bell":
      // A struck bell: a fundamental with inharmonic partials, struck twice.
      for (const at of [0, 0.28]) {
        tone(ac, out, 1046.5, at, 1.2, 0.35);
        tone(ac, out, 1046.5 * 2.76, at, 0.5, 0.08);
        tone(ac, out, 1046.5 * 5.4, at, 0.25, 0.04);
      }
      break;
    case "pop": {
      const t = ac.currentTime;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.frequency.setValueAtTime(700, t);
      osc.frequency.exponentialRampToValueAtTime(180, t + 0.09);
      g.gain.setValueAtTime(0.6, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.15);
      break;
    }
    case "whistle": {
      // A chord of three reedy tones, softened, with a little wobble: toot.
      const t = ac.currentTime;
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1800;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.06);
      g.gain.setValueAtTime(0.18, t + 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      lp.connect(g).connect(out);
      const lfo = ac.createOscillator();
      const depth = ac.createGain();
      lfo.frequency.value = 6;
      depth.gain.value = 4;
      lfo.connect(depth);
      for (const f of [466.2, 587.3, 698.5]) {
        const osc = ac.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = f;
        depth.connect(osc.frequency);
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + 0.85);
      }
      lfo.start(t);
      lfo.stop(t + 0.85);
      break;
    }
  }
}
