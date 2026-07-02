// Sound feedback for actions like copy. We synthesize a short "ting" with
// the Web Audio API so there's no audio asset to ship. A global mute flag
// (persisted to localStorage) lets the user silence it from the header.
//
// We lazily create the AudioContext on first use (browsers require a user
// gesture before audio can play, so constructing it at module load would
// start it in a suspended/blocked state).

const MUTE_KEY = 'khmer-parser-sound-muted';
let muted = readMuted();
const listeners = new Set<() => void>();

function readMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function persist() {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

let ctx: AudioContext | null = null;

/**
 * Play a short, pleasant "ting" — two quick sine notes (E6 then A6).
 * No-op when muted or when Web Audio isn't available.
 */
export function playTing(): void {
  if (muted) return;
  if (typeof window === 'undefined') return;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    ctx ||= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    // Note 1: 1318.5 Hz (E6), 0.09s, slight gain envelope.
    playNote(ctx, now, 1318.5, 0.09, 0.18);
    // Note 2: 1760 Hz (A6), starts a touch later, a bit quieter.
    playNote(ctx, now + 0.05, 1760, 0.11, 0.12);
  } catch {
    // AudioContext can throw if the page hasn't received a gesture yet;
    // failing silently is fine — the toast still shows.
  }
}

function playNote(ac: AudioContext, start: number, freq: number, dur: number, gain: number) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Exponential ramp down to ~0 for a soft bell-like decay.
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean): void {
  muted = v;
  persist();
}

export function toggleMuted(): boolean {
  muted = !muted;
  persist();
  return muted;
}

// React subscription helpers (useSyncExternalStore) so the header button
// can reflect the current mute state.
export function subscribeMute(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getMutedSnapshot(): boolean {
  return muted;
}
