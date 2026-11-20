// Audio: plays an uploaded song (AudioBuffer) or a generated Web Audio beat,
// and gives the game one clock to sync notes against.
import { settings } from './settings.js';

const CHORDS = [ // per bar, 4-bar loop (Am F C G)
  { bass: 45, notes: [57, 60, 64] },
  { bass: 41, notes: [57, 60, 65] },
  { bass: 48, notes: [55, 60, 64] },
  { bass: 43, notes: [55, 59, 62] },
];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.startAt = 0;
    this.timer = null;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = settings.volume;
      this.master.connect(this.ctx.destination);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;
      this.master.connect(this.analyser);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      if (window.__recordAudio) { this.recDest = this.ctx.createMediaStreamDestination(); this.master.connect(this.recDest); }
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume();
    return this.ctx;
  }

  // 0..1 loudness per frequency band, for the bars in the background
  bands() {
    if (!this.analyser || !this.bus || this.ctx.state !== 'running') return null;
    this.analyser.getByteFrequencyData(this.freq);
    const n = 40, out = new Float32Array(n), bins = this.freq.length * 0.7;
    for (let i = 0; i < n; i++) out[i] = this.freq[Math.floor(i / n * bins)] / 255 / Math.max(0.15, settings.volume);
    return out;
  }

  setVolume(v) { if (this.master) this.master.gain.value = v; }

  async loadBuffer(url) {
    const ctx = this.ensure();
    const res = await fetch(url);
    if (!res.ok) throw new Error('Song failed to load (' + res.status + ')');
    const data = await res.arrayBuffer();
    return await new Promise((ok, fail) => ctx.decodeAudioData(data, ok, fail));
  }

  // Start playback `leadIn` seconds from now. Song time 0 = start of the audio.
  // `from` starts part-way in (seconds), used by playtesting in the editor.
  start(level, buffer, leadIn = 3, from = 0) {
    this.stop();
    const ctx = this.ensure();
    this.paused = false;
    if (ctx.state === 'suspended') ctx.resume();
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    this.startAt = ctx.currentTime + leadIn - from;
    if (buffer) {
      this.src = ctx.createBufferSource();
      this.src.buffer = buffer;
      this.src.connect(this.bus);
      this.src.start(ctx.currentTime + leadIn, Math.max(0, from));
    } else {
      const spb = 60 / level.bpm;
      const first = Math.max(0, Math.ceil((from - (level.offset || 0)) / (spb / 4)));
      this.synth = { spb, offset: level.offset || 0, step: first, steps: Math.round(level.beats * 4) + 1 };
      this.timer = setInterval(() => this.schedule(), 25);
      this.schedule();
    }
  }

  time() { return this.ctx ? this.ctx.currentTime - this.startAt : 0; }

  pause() { this.paused = true; if (this.ctx) this.ctx.suspend(); }
  resume() { this.paused = false; if (this.ctx) this.ctx.resume(); }

  stop() {
    clearInterval(this.timer); this.timer = null;
    this.synth = null;
    if (this.src) { try { this.src.stop(); } catch { } this.src.disconnect(); this.src = null; }
    if (this.bus) { this.bus.disconnect(); this.bus = null; }
  }

  // ---------- generated beat ----------
  schedule() {
    const s = this.synth, ctx = this.ctx;
    if (!s || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + 0.15;
    const sd = s.spb / 4;
    while (s.step < s.steps) {
      const when = this.startAt + s.offset + s.step * sd;
      if (when > horizon) break;
      if (when >= ctx.currentTime - 0.02) this.playStep(s.step, Math.max(when, ctx.currentTime), sd, s);
      s.step++;
    }
  }

  playStep(step, when, sd, s) {
    const beat = Math.floor(step / 4), sub = step % 4;
    const bar = Math.floor(beat / 4), bib = beat % 4;
    const chord = CHORDS[bar % 4];
    const last = s.steps - 1;

    if (step === last) { this.crash(when); this.kick(when); return; }

    const intro = bar === 0;
    const breakdown = bar >= 13 && bar <= 16;
    const full = !intro && !breakdown;

    // drums
    if (sub === 0) {
      if (intro) { if (bib === 0) this.kick(when); }
      else if (breakdown) { if (bib === 0) this.kick(when, 0.6); }
      else if (bib === 0 || bib === 2 || (bar >= 17 && bib === 3)) this.kick(when);
      if (full && (bib === 1 || bib === 3)) this.snare(when);
    }
    if (bar >= 17 && step % 16 === 14) this.snare(when, 0.25);
    if (sub === 2) this.hat(when, breakdown ? 0.05 : 0.11, 0.05);
    else if (bar >= 5 && !breakdown && sub % 2 === 1) this.hat(when, 0.05, 0.025);
    if (bar === 0 && sub === 0) this.hat(when, 0.08, 0.03);
    if ((bar === 1 || bar === 17) && step % 16 === 0) this.crash(when);

    // bass
    if (!intro && !breakdown && (sub === 0 || sub === 2) && !(sub === 0 && bib === 0 && false)) {
      const note = sub === 2 && bib % 2 === 1 ? chord.bass + 12 : chord.bass;
      this.bass(when, mtof(note), sd * 1.8);
    }
    // pad once per bar
    if (bar >= 5 && step % 16 === 0) this.pad(when, chord.notes, s.spb * 4);
    // arp
    if ((bar >= 9 && bar <= 16) || bar >= 17) {
      const tones = [...chord.notes, chord.notes[1] + 12];
      const n = tones[step % tones.length] + 12;
      this.pluck(when, mtof(n), breakdown ? 0.06 : 0.045);
    }
  }

  env(g, when, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
  }

  kick(when, vol = 0.9) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.13);
    this.env(g, when, vol, 0.002, 0.32);
    o.connect(g).connect(this.bus);
    o.start(when); o.stop(when + 0.4);
  }

  snare(when, vol = 0.45) {
    const ctx = this.ctx, n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
    this.env(g, when, vol, 0.002, 0.16);
    n.connect(f).connect(g).connect(this.bus);
    n.start(when, Math.random() * 0.5); n.stop(when + 0.2);
    const o = ctx.createOscillator(), g2 = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 190;
    this.env(g2, when, vol * 0.5, 0.002, 0.08);
    o.connect(g2).connect(this.bus); o.start(when); o.stop(when + 0.1);
  }

  hat(when, vol, decay) {
    const ctx = this.ctx, n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = this.noise; f.type = 'highpass'; f.frequency.value = 7500;
    this.env(g, when, vol, 0.001, decay);
    n.connect(f).connect(g).connect(this.bus);
    n.start(when, Math.random() * 0.5); n.stop(when + decay + 0.02);
  }

  crash(when) {
    const ctx = this.ctx, n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = this.noise; f.type = 'highpass'; f.frequency.value = 4000;
    this.env(g, when, 0.18, 0.003, 1.1);
    n.connect(f).connect(g).connect(this.bus);
    n.start(when); n.stop(when + 1.2);
  }

  bass(when, freq, dur) {
    const ctx = this.ctx, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.setValueAtTime(900, when); f.frequency.exponentialRampToValueAtTime(220, when + dur);
    this.env(g, when, 0.22, 0.005, dur);
    o.connect(f).connect(g).connect(this.bus);
    o.start(when); o.stop(when + dur + 0.05);
  }

  pad(when, notes, dur) {
    const ctx = this.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = 1300;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.045, when + 0.25);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    f.connect(g).connect(this.bus);
    for (const m of notes) for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(when); o.stop(when + dur + 0.05);
    }
  }

  pluck(when, freq, vol) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = freq;
    this.env(g, when, vol, 0.003, 0.2);
    o.connect(g).connect(this.bus);
    o.start(when); o.stop(when + 0.25);
  }

  // Render the built-in beat for a level into an AudioBuffer (for the editor).
  async renderSynth(level) {
    const spb = 60 / level.bpm, sr = 44100;
    const dur = (level.offset || 0) + (level.beats + 4) * spb + 1;
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const tmp = Object.create(AudioEngine.prototype);
    tmp.ctx = off; tmp.bus = off.createGain(); tmp.bus.connect(off.destination);
    tmp.noise = off.createBuffer(1, sr, sr);
    const d = tmp.noise.getChannelData(0);
    for (let i = 0; i < sr; i++) d[i] = Math.random() * 2 - 1;
    const s = { spb, offset: level.offset || 0, step: 0, steps: Math.round(level.beats * 4) + 1 };
    for (let i = 0; i < s.steps; i++) tmp.playStep(i, s.offset + i * spb / 4 + 0.001, spb / 4, s);
    return await off.startRendering();
  }

  // a short click, used by the editor preview
  tick(when, high) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square'; o.frequency.value = high ? 1760 : 1320;
    this.env(g, when, 0.05, 0.001, 0.035);
    o.connect(g).connect(this.master); o.start(when); o.stop(when + 0.06);
  }

  // ---------- feedback ----------
  hitSound(kind) {
    if (!settings.hitSounds || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, when = ctx.currentTime;
    if (this.hitBuffer) {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = this.hitBuffer; g.gain.value = kind === 'perfect' ? 0.9 : 0.6;
      src.connect(g).connect(this.master); src.start(when);
      return;
    }
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(kind === 'perfect' ? 1320 : 990, when);
    o.frequency.exponentialRampToValueAtTime(kind === 'perfect' ? 1760 : 1100, when + 0.04);
    this.env(g, when, 0.07, 0.002, 0.07);
    o.connect(g).connect(this.master);
    o.start(when); o.stop(when + 0.1);
  }
}
