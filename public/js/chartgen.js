// Builds a playable chart from an uploaded song when it has no hand-made one.
// It listens for hits in the audio on an 8th-note grid (using the BPM you set),
// puts tap notes on the strongest ones, and a hold at the end of every 4 bars.
import { tap, hold } from './levels.js';

function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateChart(buffer, { bpm, offset = 0, density = 'normal', seed = 'ringfall' }) {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const spb = 60 / bpm, step = spb / 2;
  const rand = rng(seed + bpm);

  const energyAt = (t) => {
    const a = Math.max(0, Math.floor((t - 0.02) * sr)), b = Math.min(ch0.length, Math.floor((t + 0.06) * sr));
    let sum = 0, n = 0;
    for (let i = a; i < b; i += 4) { const v = (ch0[i] + ch1[i]) * 0.5; sum += v * v; n++; }
    return n ? Math.sqrt(sum / n) : 0;
  };

  const firstStep = Math.max(0, Math.ceil((1.5 - offset) / step));
  const lastStep = Math.floor((buffer.duration - offset - 1.5) / step);
  const energy = [];
  for (let i = 0; i <= lastStep; i++) energy[i] = energyAt(offset + i * step);
  const maxE = Math.max(1e-6, ...energy);
  const flux = energy.map((e, i) => {
    let prev = 0, n = 0;
    for (let k = Math.max(0, i - 4); k < i; k++) { prev += energy[k]; n++; }
    return Math.max(0, e - (n ? prev / n : 0)) + e * 0.15;
  });

  const perBar = { easy: 2, normal: 4, hard: 6 }[density] || 4;
  const notes = [];
  let x = 0.5, lastBeat = -10;

  const place = (beat) => {
    const gap = beat - lastBeat;
    const reach = Math.min(0.6, 0.18 + gap * 0.18);
    let nx = x + (rand() * 2 - 1) * reach;
    if (nx < 0.1 || nx > 0.9) nx = x - (nx - x);
    x = Math.min(0.9, Math.max(0.1, nx));
    return x;
  };

  for (let barStart = firstStep - (firstStep % 8); barStart <= lastStep; barStart += 8) {
    const bar = barStart / 8;
    const barSteps = [];
    for (let i = barStart; i < barStart + 8 && i <= lastStep; i++) if (i >= firstStep) barSteps.push(i);
    if (!barSteps.length) continue;
    const barEnergy = barSteps.reduce((s, i) => s + energy[i], 0) / barSteps.length;
    if (barEnergy < maxE * 0.08) continue; // silence

    if (bar % 4 === 3 && barSteps.length === 8 && barStart + 6 <= lastStep) {
      const b = barStart / 2;
      if (b - lastBeat >= 1) {
        notes.push(hold(b, place(b), 3));
        lastBeat = b + 3;
        continue;
      }
    }

    const picks = barSteps
      .map(i => ({ i, s: flux[i] * (i % 2 === 0 ? 1.35 : 1) }))
      .filter(p => energy[p.i] > maxE * 0.12)
      .sort((a, b) => b.s - a.s)
      .slice(0, perBar)
      .sort((a, b) => a.i - b.i);

    let prevI = -2;
    for (const p of picks) {
      if (p.i - prevI < 1) continue;
      const b = p.i / 2;
      if (b - lastBeat < 0.5) continue;
      notes.push(tap(b, place(b)));
      lastBeat = b; prevI = p.i;
    }
  }
  return notes;
}
