// Placeholder sounds behind an AudioBus that maps sound ids to short synthesized tones (design
// doc: Minimum feedback). Real sound files replace the synth later by changing only this file.
// Browsers start audio suspended until a key or click, so the bus resumes on the first one.

export type SoundId = 'tick' | 'tickFast' | 'heat' | 'alarm' | 'expired' | 'whistle' | 'hoof';

interface Tone { type: OscillatorType; from: number; to: number; sec: number; gain: number; repeat?: number }

/** Each sound as one or more tones: a frequency sweep with a quick decay. */
const TONES: Record<SoundId, Tone> = {
  tick: { type: 'square', from: 1100, to: 1100, sec: 0.03, gain: 0.05 },
  tickFast: { type: 'square', from: 1600, to: 1600, sec: 0.03, gain: 0.07 },
  heat: { type: 'triangle', from: 520, to: 780, sec: 0.12, gain: 0.12 },
  // The alarm sting: a rising two-step siren.
  alarm: { type: 'sawtooth', from: 600, to: 1100, sec: 0.22, gain: 0.12, repeat: 3 },
  expired: { type: 'sawtooth', from: 440, to: 110, sec: 0.9, gain: 0.15 },
  // The whistle for the horse: two rising notes.
  whistle: { type: 'sine', from: 1400, to: 2300, sec: 0.18, gain: 0.12, repeat: 2 },
  // One hoofbeat, a low thud; the client plays them in a gallop rhythm while the horse is close.
  hoof: { type: 'triangle', from: 140, to: 70, sec: 0.06, gain: 0.12 },
};

export interface AudioBus {
  /** `volume` scales the sound's gain: 1 is its normal level, 0 silent. */
  play(id: SoundId, volume?: number): void;
  muted: boolean;
}

/** A bus that plays nothing, for pages without Web Audio. */
export const silentBus = (): AudioBus => ({ play() {}, muted: true });

export function createAudioBus(target: Pick<Window, 'addEventListener'> = window, muted = false): AudioBus {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) return silentBus();
  let ctx: AudioContext | null = null;
  const wake = () => {
    ctx ??= new Ctx();
    if (ctx.state === 'suspended') void ctx.resume();
  };
  target.addEventListener('keydown', wake);
  target.addEventListener('pointerdown', wake);
  const bus: AudioBus = {
    muted,
    play(id, volume = 1) {
      if (bus.muted || volume <= 0 || !ctx || ctx.state !== 'running') return;
      const t = TONES[id];
      for (let i = 0; i < (t.repeat ?? 1); i++) {
        const start = ctx.currentTime + i * t.sec;
        const osc = ctx.createOscillator(), amp = ctx.createGain();
        osc.type = t.type;
        osc.frequency.setValueAtTime(t.from, start);
        osc.frequency.linearRampToValueAtTime(t.to, start + t.sec);
        amp.gain.setValueAtTime(Math.max(0.0002, t.gain * volume), start);
        amp.gain.exponentialRampToValueAtTime(0.0001, start + t.sec);
        osc.connect(amp).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + t.sec + 0.02);
      }
    },
  };
  return bus;
}
