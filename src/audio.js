// Tiny synthesised sound kit — no audio files to ship.
let ctx = null;
let master = null;
let noise = null;
let muted = false;

export function initAudio() {
  if (ctx) return ctx.resume();
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.6;
  master.connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.6;
  return muted;
}

function env(gain, t, attack, decay, peak) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

// Impact: filtered noise click plus a pitched body. Heavy pieces sound lower.
export function thud(strength, heaviness = 1) {
  if (!ctx || strength < 0.05) return;
  const t = ctx.currentTime;
  const s = Math.min(1, strength);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900 / heaviness + 600 * s;
  const ng = ctx.createGain();
  env(ng, t, 0.003, 0.12, 0.5 * s);
  src.connect(lp).connect(ng).connect(master);
  src.start(t, Math.random() * 0.5, 0.2);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const f = (160 + Math.random() * 40) / heaviness;
  osc.frequency.setValueAtTime(f * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  const og = ctx.createGain();
  env(og, t, 0.004, 0.18, 0.45 * s);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.3);
}

export function whoosh() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(2400, t);
  bp.frequency.exponentialRampToValueAtTime(500, t + 0.35);
  const g = ctx.createGain();
  env(g, t, 0.05, 0.3, 0.18);
  src.connect(bp).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, 0.4);
}

export function chime(step = 0) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const base = 523.25 * Math.pow(2, (step % 7) / 12);
  [1, 1.25, 1.5, 2].forEach((m, i) => {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = base * m;
    const g = ctx.createGain();
    env(g, t + i * 0.07, 0.01, 0.5, 0.16);
    o.connect(g).connect(master);
    o.start(t + i * 0.07);
    o.stop(t + i * 0.07 + 0.6);
  });
}

export function crash() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (let i = 0; i < 4; i++) setTimeout(() => thud(0.9 - i * 0.18, 1.3), i * 90);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(320, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.6);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const g = ctx.createGain();
  env(g, t, 0.01, 0.6, 0.12);
  o.connect(lp).connect(g).connect(master);
  o.start(t);
  o.stop(t + 0.7);
}

export function gust() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.8;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.linearRampToValueAtTime(900, t + 0.8);
  bp.frequency.linearRampToValueAtTime(250, t + 2);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 2.3);
}
