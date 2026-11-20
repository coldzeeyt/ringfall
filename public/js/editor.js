// Ringfall level editor: chart notes on a timeline over the song's waveform,
// add triggers (flip, mirror, music bars, background, speed), preview, playtest, save and share.
import { THEME, BG_PRESETS, rgba } from './theme.js';
import { LEVELS, normChart } from './levels.js';
import { generateChart } from './chartgen.js';
import * as Mods from './mods.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DRAFT_KEY = 'ringfall.editor.draft';
const PEAK_RATE = 200;

export const TRIGGERS = {
  flip:       { label: 'Flip',       short: 'FLIP', color: '#9FE1CB', fade: 1, hint: 'Notes rise up from below' },
  mirror:     { label: 'Mirror',     short: 'MIRR', color: '#CECBF6', fade: 1, hint: 'Left and right swap' },
  bars:       { label: 'Music bars', short: 'BARS', color: '#7F77DD', fade: 0, hint: 'Show or hide the bars along the bottom' },
  background: { label: 'Background', short: 'BG',   color: '#ED93B1', fade: 2, hint: 'Fade to another sky' },
  speed:      { label: 'Speed',      short: 'SPD',  color: '#FAC775', fade: 0, hint: 'How fast notes fall' },
};
const TOOL_KEYS = { v: 'select', 1: 'tap', 2: 'hold', 3: 'flip', 4: 'mirror', 5: 'bars', 6: 'background', 7: 'speed', e: 'erase' };

function fmtClock(t) {
  const s = Math.max(0, t), m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function bufferToWav(buf) {
  const ch = Math.min(2, buf.numberOfChannels), len = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { out.setInt16(o, clamp(data[c][i], -1, 1) * 32767, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}

export class Editor {
  constructor(audio, hooks) {
    this.audio = audio;
    this.hooks = hooks; // { exit(), playtest(level, buffer, duration, from), online() }
    this.cv = $('edCanvas'); this.g = this.cv.getContext('2d');
    this.tool = 'tap'; this.snap = 2; this.xSnap = true; this.pps = 240; this.cur = 0;
    this.meta = { title: 'Untitled', artist: '', bpm: 120, offset: 0 };
    this.notes = []; this.triggers = [];
    this.song = null; this.buffer = null; this.peaks = null;
    this.sel = null; this.hover = null; this.drag = null;
    this.undoStack = []; this.redoStack = [];
    this.playing = false; this.active = false; this.loaded = false;

    this.bindUI();
    addEventListener('resize', () => this.active && this.resize());
  }

  // ---------------- setup ----------------
  bindUI() {
    document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    $('edBack').addEventListener('click', () => this.exit());
    $('edPlay').addEventListener('click', () => this.togglePreview());
    $('edTest').addEventListener('click', () => this.playtest(0));
    $('edOpen').addEventListener('click', () => this.openMenu());
    $('edSong').addEventListener('click', () => this.songMenu());
    $('edShare').addEventListener('click', () => this.shareMenu());
    $('edTitle').addEventListener('input', e => { this.meta.title = e.target.value.slice(0, 40) || 'Untitled'; this.saveDraft(); });
    $('edBpm').addEventListener('change', e => { this.snapshot(); this.meta.bpm = clamp(Number(e.target.value) || 120, 30, 400); e.target.value = this.meta.bpm; this.changed(); });
    $('edOffset').addEventListener('change', e => { this.snapshot(); this.meta.offset = (Number(e.target.value) || 0) / 1000; this.changed(); });
    $('edSnap').addEventListener('change', e => { this.snap = Number(e.target.value); });
    $('edModal').addEventListener('click', e => { if (e.target === $('edModal')) this.closeModal(); });

    const cv = this.cv;
    cv.addEventListener('pointerdown', e => this.down(e));
    cv.addEventListener('pointermove', e => this.move(e));
    addEventListener('pointerup', e => this.up(e));
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.pps = clamp(this.pps * Math.exp(-e.deltaY * 0.0015), 60, 1400);
      else this.seek(this.cur - e.deltaY / this.pps);
    }, { passive: false });
    addEventListener('keydown', e => this.key(e));
  }

  async open() {
    const wasActive = this.active;
    this.active = true;
    this.resize();
    this.renderInspector();
    this.syncTop();
    if (!wasActive) {
      const loop = () => { if (!this.active) return; this.frame(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    if (!this.loaded) {
      this.loaded = true;
      if (!this.loadDraft()) await this.loadLevel(this.builtInTemplate(true));
    }
  }

  exit() {
    this.stopPreview();
    this.closeModal();
    this.active = false;
    this.hooks.exit();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = this.W = innerWidth, H = this.H = innerHeight;
    this.cv.width = W * dpr; this.cv.height = H * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const left = 100, right = W - (W > 980 ? 300 : 24);
    const avail = right - left;
    this.wfW = W > 1200 ? 132 : 96; this.trW = 84; const gap = 14;
    this.laneW = clamp(avail - this.wfW - this.trW - gap * 2 - 30, 220, 520);
    const total = this.wfW + gap + this.laneW + gap + this.trW;
    this.wfL = left + Math.max(0, (avail - total) / 2);
    this.laneL = this.wfL + this.wfW + gap; this.laneR = this.laneL + this.laneW;
    this.trL = this.laneR + gap; this.trR = this.trL + this.trW;
    this.topY = 84; this.lineY = H - 110;
  }

  // ---------------- time helpers ----------------
  get spb() { return 60 / this.meta.bpm; }
  tOfB(b) { return this.meta.offset + b * this.spb; }
  bOfT(t) { return (t - this.meta.offset) / this.spb; }
  yOfT(t) { return this.lineY - (t - this.cur) * this.pps; }
  tOfY(y) { return this.cur + (this.lineY - y) / this.pps; }
  snapB(b) { return Math.max(0, Math.round(b * this.snap) / this.snap); }
  xOfN(x) { return this.laneL + x * this.laneW; }
  nOfX(px) { const x = clamp((px - this.laneL) / this.laneW, 0, 1); return this.xSnap ? Math.round(x * 20) / 20 : Math.round(x * 1000) / 1000; }
  get duration() { return this.buffer ? this.buffer.duration : 60; }
  seek(t) { if (this.playing) this.stopPreview(); this.cur = clamp(t, -1, this.duration); }

  // ---------------- songs ----------------
  builtInTemplate(withChart) {
    const t = LEVELS.find(l => !l.music && l.beats) || { title: 'Test Level', bpm: 120, offset: 0, beats: 88, notes: [], triggers: [] };
    return {
      title: withChart ? t.title : 'Untitled', artist: '', bpm: t.bpm, offset: t.offset || 0,
      notes: withChart ? structuredClone(t.notes) : [], triggers: withChart ? structuredClone(t.triggers || []) : [],
      song: { kind: 'synth', name: 'Built-in beat', bpm: t.bpm, beats: t.beats, offset: t.offset || 0 },
    };
  }

  async loadSong(song) {
    this.status('Loading song…');
    let buffer;
    if (song.kind === 'synth') {
      const key = `${song.bpm}:${song.beats}:${song.offset}`;
      if (!this.synthCache || this.synthCache.key !== key) this.synthCache = { key, buf: await this.audio.renderSynth({ bpm: song.bpm, beats: song.beats, offset: song.offset }) };
      buffer = this.synthCache.buf;
    }
    else if (song.kind === 'file') { this.audio.ensure(); buffer = await this.audio.ctx.decodeAudioData(await song.file.arrayBuffer()); }
    else buffer = await this.audio.loadBuffer(song.url);
    this.stopPreview();
    this.song = song; this.buffer = buffer;
    const ch = buffer.getChannelData(0), n = Math.ceil(buffer.duration * PEAK_RATE), step = buffer.sampleRate / PEAK_RATE;
    const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch;
    const peaks = new Float32Array(n), rms = new Float32Array(n);
    let max = 1e-6, maxR = 1e-6;
    for (let i = 0; i < n; i++) {
      let m = 0, sum = 0, c = 0; const a = Math.floor(i * step), b = Math.min(ch.length, Math.floor((i + 1) * step));
      for (let j = a; j < b; j += 2) { const v = (Math.abs(ch[j]) + Math.abs(ch2[j])) / 2; if (v > m) m = v; sum += v * v; c++; }
      peaks[i] = m; rms[i] = c ? Math.sqrt(sum / c) : 0;
      if (m > max) max = m; if (rms[i] > maxR) maxR = rms[i];
    }
    for (let i = 0; i < n; i++) { peaks[i] /= max; rms[i] /= maxR; }
    this.peaks = peaks; this.rms = rms;
    this.status('');
    this.syncTop();
  }

  async loadLevel(lv) {
    try { await this.loadSong(lv.song); }
    catch { this.status("That song couldn't be loaded"); return; }
    this.meta = { title: lv.title || 'Untitled', artist: lv.artist || '', bpm: lv.bpm || 120, offset: lv.offset || 0 };
    let notes = lv.notes;
    if (!notes) notes = generateChart(this.buffer, { bpm: this.meta.bpm, offset: this.meta.offset, density: lv.density || 'normal', seed: this.meta.title });
    this.notes = structuredClone(notes); this.triggers = structuredClone(lv.triggers || []);
    this.sortAll();
    this.undoStack = []; this.redoStack = []; this.sel = null; this.cur = 0;
    this.syncTop(); this.renderInspector(); this.saveDraft();
  }

  // ---------------- drafts ----------------
  saveDraft() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      const song = this.song ? { ...this.song, file: undefined } : null;
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ meta: this.meta, notes: this.notes, triggers: this.triggers, song })); } catch { }
    }, 300);
  }

  loadDraft() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { }
    if (!d || !d.song) return false;
    this.meta = d.meta; this.notes = d.notes || []; this.triggers = d.triggers || [];
    if (d.song.kind === 'file') {
      this.song = d.song;
      this.status(`Pick "${d.song.name}" again to keep editing`);
      setTimeout(() => this.songMenu(), 300);
    } else {
      this.loadSong(d.song).catch(() => this.status("The draft's song couldn't be loaded"));
    }
    this.syncTop();
    return true;
  }

  // ---------------- editing ----------------
  snapshot() {
    this.undoStack.push(JSON.stringify({ notes: this.notes, triggers: this.triggers, meta: this.meta }));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify({ notes: this.notes, triggers: this.triggers, meta: this.meta }));
    const s = JSON.parse(from.pop());
    this.notes = s.notes; this.triggers = s.triggers; this.meta = s.meta;
    this.sel = null; this.changed(); this.syncTop();
  }
  sortAll() {
    this.notes.sort((a, b) => a.b - b.b || a.x - b.x);
    this.triggers.sort((a, b) => a.b - b.b);
  }
  changed() { this.sortAll(); this.renderInspector(); this.saveDraft(); }

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    const hints = {
      select: 'Click to select, drag to move. Right-click deletes.',
      tap: 'Click to place a tap note. Right-click deletes.',
      hold: 'Click and drag up to place a hold note.',
      erase: 'Click a note or trigger to delete it.',
    };
    this.status(hints[t] || `Click the timeline to add a ${TRIGGERS[t].label.toLowerCase()} trigger. ${TRIGGERS[t].hint}.`, true);
  }

  // the state each trigger type is in just before beat b
  stateAt(type, b) {
    let v = { flip: false, mirror: false, bars: true, background: 'night', speed: 1 }[type];
    for (const t of this.triggers) if (t.type === type && t.b < b) v = t.value;
    return v;
  }

  addTrigger(type, b) {
    const before = this.stateAt(type, b);
    let value;
    if (type === 'flip' || type === 'mirror') value = !before;
    else if (type === 'bars') value = !before;
    else if (type === 'background') { const keys = Object.keys(BG_PRESETS); value = keys[(keys.indexOf(before) + 1) % keys.length]; }
    else value = before === 1 ? 1.5 : 1;
    const tr = { b, type, value, fade: TRIGGERS[type].fade };
    this.snapshot(); this.triggers.push(tr); this.sel = { kind: 'trig', ref: tr }; this.changed();
  }

  noteAt(px, py) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i], x = this.xOfN(n.x), y = this.yOfT(this.tOfB(n.b));
      if (n.len) {
        const y2 = this.yOfT(this.tOfB(n.b + n.len));
        if (Math.abs(px - x) < 12 && py <= y + 10 && py >= y2 - 6) return n;
      } else if (Math.hypot(px - x, py - y) < 14) return n;
    }
    return null;
  }

  trigLayout() {
    const out = [], count = new Map();
    for (const tr of this.triggers) {
      const i = count.get(tr.b) || 0; count.set(tr.b, i + 1);
      out.push({ tr, y: this.yOfT(this.tOfB(tr.b)) - i * 24 });
    }
    return out;
  }
  trigAt(px, py) {
    if (px < this.trL || px > this.trR) return null;
    for (const { tr, y } of this.trigLayout()) if (py > y - 12 && py < y + 10) return tr;
    return null;
  }

  remove(item) {
    this.snapshot();
    this.notes = this.notes.filter(n => n !== item);
    this.triggers = this.triggers.filter(t => t !== item);
    if (this.sel && this.sel.ref === item) this.sel = null;
    this.changed();
  }

  down(e) {
    if (this.playing) this.stopPreview();
    const r = this.cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (py < this.topY - 10) return;
    const b = this.snapB(this.bOfT(this.tOfY(py)));
    const inLane = px >= this.laneL - 12 && px <= this.laneR + 12;
    const inTrig = px >= this.trL && px <= this.trR;
    const note = inLane ? this.noteAt(px, py) : null;
    const tr = this.trigAt(px, py);

    if (px >= this.wfL && px <= this.wfL + this.wfW) { this.seek(this.tOfY(py)); this.drag = { kind: 'scrub' }; return; }
    if (e.button === 2 || this.tool === 'erase') { if (note || tr) this.remove(note || tr); return; }

    if (tr) { this.sel = { kind: 'trig', ref: tr }; this.snapshot(); this.drag = { kind: 'moveTrig', ref: tr }; this.renderInspector(); return; }
    if (note) {
      this.sel = { kind: 'note', ref: note }; this.snapshot();
      this.drag = { kind: 'moveNote', ref: note, db: this.bOfT(this.tOfY(py)) - note.b };
      this.renderInspector(); return;
    }
    if (TRIGGERS[this.tool] && (inLane || inTrig)) { this.addTrigger(this.tool, b); this.drag = { kind: 'moveTrig', ref: this.sel.ref }; return; }
    if (!inLane) { this.sel = null; this.renderInspector(); return; }
    if (this.tool === 'select') { this.sel = null; this.renderInspector(); return; }

    const x = this.nOfX(px);
    this.snapshot();
    if (this.tool === 'tap') {
      const n = { b, x }; this.notes.push(n); this.sel = { kind: 'note', ref: n };
      this.drag = { kind: 'moveNote', ref: n, db: 0, fresh: true };
    } else if (this.tool === 'hold') {
      const n = { b, x, len: 1 / this.snap }; this.notes.push(n); this.sel = { kind: 'note', ref: n };
      this.drag = { kind: 'hold', ref: n };
    }
    this.audio.ensure(); this.audio.tick(this.audio.ctx.currentTime, true);
    this.changed();
  }

  move(e) {
    const r = this.cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    this.hover = { px, py };
    const d = this.drag; if (!d) return;
    const b = this.bOfT(this.tOfY(py));
    if (d.kind === 'scrub') this.seek(this.tOfY(py));
    else if (d.kind === 'moveNote') { d.ref.b = this.snapB(b - d.db); d.ref.x = this.nOfX(px); this.renderInspector(); }
    else if (d.kind === 'hold') { d.ref.len = Math.max(1 / this.snap, this.snapB(b) - d.ref.b); this.renderInspector(); }
    else if (d.kind === 'moveTrig') { d.ref.b = this.snapB(b); this.renderInspector(); }
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.changed();
  }

  key(e) {
    if (!this.active) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (!$('edModal').hidden) { if (e.key === 'Escape') this.closeModal(); return; }
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.restore(this.redoStack, this.undoStack) : this.restore(this.undoStack, this.redoStack); return; }
    if (mod && k === 'y') { e.preventDefault(); this.restore(this.redoStack, this.undoStack); return; }
    if (mod) return;
    if (e.code === 'Space') { e.preventDefault(); this.togglePreview(); return; }
    if (e.key === 'Escape') { this.exit(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (this.sel) this.remove(this.sel.ref); return; }
    if (k === 'p') { this.playtest(Math.max(0, this.cur)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.seek(this.cur + this.spb / this.snap); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.seek(this.cur - this.spb / this.snap); return; }
    if (e.key === 'Home') { this.seek(0); return; }
    if (e.key === ']') { this.pps = Math.min(1400, this.pps * 1.25); return; }
    if (e.key === '[') { this.pps = Math.max(60, this.pps / 1.25); return; }
    if (TOOL_KEYS[k]) this.setTool(TOOL_KEYS[k]);
  }

  // ---------------- preview + playtest ----------------
  togglePreview() { this.playing ? this.stopPreview() : this.startPreview(); }

  startPreview() {
    if (!this.buffer) return;
    const ctx = this.audio.ensure();
    const from = clamp(this.cur, 0, this.buffer.duration - 0.05);
    const at = ctx.currentTime + 0.06;
    this.src = ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.connect(this.audio.master);
    this.src.start(at, from);
    this.playT0 = at - from; this.cur = from;
    this.ticked = new Set();
    this.playing = true;
    $('edPlay').classList.add('on'); $('edPlay').textContent = 'Stop';
  }

  stopPreview() {
    if (this.src) { try { this.src.stop(); } catch { } this.src.disconnect(); this.src = null; }
    this.playing = false;
    const b = $('edPlay'); if (b) { b.classList.remove('on'); b.textContent = 'Preview'; }
  }

  playtest(from) {
    if (!this.buffer) return;
    this.stopPreview();
    const level = {
      slot: 'E', title: this.meta.title, artist: this.meta.artist, bpm: this.meta.bpm, offset: this.meta.offset,
      music: null, notes: structuredClone(this.notes), triggers: structuredClone(this.triggers), playtest: true,
    };
    this.active = false;
    this.hooks.playtest(level, this.buffer, this.buffer.duration, from);
  }

  // ---------------- drawing ----------------
  frame() {
    const ctx = this.audio.ctx;
    if (this.playing && ctx) {
      this.cur = ctx.currentTime - this.playT0;
      for (const n of this.notes) {
        const t = this.tOfB(n.b);
        if (t >= this.cur && t < this.cur + 0.12 && !this.ticked.has(n)) { this.ticked.add(n); this.audio.tick(this.playT0 + t, !!n.len); }
      }
      if (this.cur >= this.buffer.duration) this.stopPreview();
    }
    this.draw();
    $('edClock').textContent = this.clockText();
  }

  clockText() {
    const b = this.bOfT(this.cur);
    const bar = Math.floor(b / 4) + 1, beat = ((b % 4) + 4) % 4 + 1;
    return `Bar ${Math.max(1, bar)} · beat ${beat.toFixed(2).replace(/\.?0+$/, '')} · ${fmtClock(this.cur)}`;
  }

  draw() {
    const g = this.g, W = this.W, H = this.H;
    g.fillStyle = '#120e2e'; g.fillRect(0, 0, W, H);
    const top = this.topY, line = this.lineY;

    // lanes
    const panel = (x, w, a) => { g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath(); g.roundRect(x, top - 8, w, H - top - 30, 14); g.fill(); };
    panel(this.wfL, this.wfW, 0.03); panel(this.laneL, this.laneW, 0.045); panel(this.trL, this.trW, 0.03);

    g.save();
    g.beginPath(); g.rect(0, top - 8, W, H - top - 22); g.clip();

    // flip / mirror stretches, tinted so you can see them
    for (const [type, col] of [['flip', 'rgba(93,202,165,0.07)'], ['mirror', 'rgba(206,203,246,0.06)']]) {
      let on = false, start = 0;
      const seg = (b0, b1) => {
        const y0 = this.yOfT(this.tOfB(b0)), y1 = this.yOfT(this.tOfB(b1));
        g.fillStyle = col; g.fillRect(this.laneL, y1, this.laneW, y0 - y1);
        if (type === 'mirror') { g.strokeStyle = 'rgba(206,203,246,0.18)'; g.setLineDash([4, 6]); g.beginPath(); g.moveTo(this.laneL + this.laneW / 2, y0); g.lineTo(this.laneL + this.laneW / 2, y1); g.stroke(); g.setLineDash([]); }
      };
      for (const t of this.triggers) if (t.type === type) {
        if (t.value && !on) { on = true; start = t.b; } else if (!t.value && on) { on = false; seg(start, t.b); }
      }
      if (on) seg(start, this.bOfT(this.duration));
    }

    // beat grid
    const tTop = this.tOfY(top - 10), tBot = this.tOfY(H);
    const b0 = Math.floor(this.bOfT(tBot) * this.snap) / this.snap, b1 = this.bOfT(tTop);
    g.font = '600 11px Rubik, sans-serif'; g.textAlign = 'right';
    for (let b = Math.max(0, b0); b <= b1; b += 1 / this.snap) {
      const y = Math.round(this.yOfT(this.tOfB(b))) + 0.5;
      const isBeat = Math.abs(b - Math.round(b)) < 1e-6, isBar = isBeat && Math.round(b) % 4 === 0;
      g.strokeStyle = `rgba(206,203,246,${isBar ? 0.3 : isBeat ? 0.13 : 0.05})`;
      g.lineWidth = isBar ? 1.5 : 1;
      g.beginPath(); g.moveTo(this.wfL, y); g.lineTo(this.trR, y); g.stroke();
      if (isBar) { g.fillStyle = 'rgba(206,203,246,0.6)'; g.fillText(String(Math.round(b) / 4 + 1), this.wfL - 10, y + 4); }
    }

    // waveform
    if (this.peaks) {
      const cx = this.wfL + this.wfW / 2, half = (this.wfW - 14) / 2;
      const avg = (arr, t0, t1) => {
        let i0 = Math.floor(Math.min(t0, t1) * PEAK_RATE), i1 = Math.ceil(Math.max(t0, t1) * PEAK_RATE), m = 0;
        for (let i = Math.max(0, i0); i <= Math.min(arr.length - 1, i1); i++) if (arr[i] > m) m = arr[i];
        return m;
      };
      for (const [arr, col, scale] of [[this.peaks, THEME.accent, 1], [this.rms, THEME.player, 0.92]]) {
        const pts = [];
        for (let y = top - 8; y <= H - 22; y += 2) {
          const t = this.tOfY(y);
          pts.push([y, t < 0 || t > this.duration ? 0 : avg(arr, t, this.tOfY(y + 2)) * half * scale]);
        }
        // already-played part (below the hit line) is dimmer
        for (const [clipTop, clipBot, a] of [[top - 8, line, arr === this.peaks ? 0.55 : 0.85], [line, H, arr === this.peaks ? 0.22 : 0.35]]) {
          g.save(); g.beginPath(); g.rect(this.wfL, clipTop, this.wfW, clipBot - clipTop); g.clip();
          g.fillStyle = rgba(col, a);
          g.beginPath(); g.moveTo(cx, pts[0][0]);
          for (const [y, w] of pts) g.lineTo(cx + w, y);
          for (let i = pts.length - 1; i >= 0; i--) g.lineTo(cx - pts[i][1], pts[i][0]);
          g.closePath(); g.fill(); g.restore();
        }
      }
      g.strokeStyle = 'rgba(238,237,254,0.12)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, top - 8); g.lineTo(cx, H - 22); g.stroke();
      // faint copy behind the notes
      g.fillStyle = rgba(THEME.accent, 0.07);
      const lc = this.laneL + this.laneW / 2;
      for (let y = top - 8; y < H - 22; y += 3) {
        const i = Math.floor(this.tOfY(y) * PEAK_RATE);
        if (i < 0 || i >= this.peaks.length) continue;
        const w = this.peaks[i] * this.laneW * 0.9;
        g.fillRect(lc - w / 2, y, w, 2);
      }
      const yEnd = this.yOfT(this.duration);
      g.strokeStyle = 'rgba(237,147,177,0.5)'; g.setLineDash([6, 6]);
      g.beginPath(); g.moveTo(this.wfL, yEnd); g.lineTo(this.trR, yEnd); g.stroke(); g.setLineDash([]);
    }

    // trigger lines across the note lane
    for (const tr of this.triggers) {
      const y = this.yOfT(this.tOfB(tr.b));
      g.strokeStyle = rgba(TRIGGERS[tr.type].color, 0.35); g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.laneL, y); g.lineTo(this.trL, y); g.stroke();
    }

    // notes
    const selRef = this.sel && this.sel.ref;
    for (const n of this.notes) {
      const x = this.xOfN(n.x), y = this.yOfT(this.tOfB(n.b));
      if (n.len) {
        const y2 = this.yOfT(this.tOfB(n.b + n.len));
        if (y < top - 20 || y2 > H) { if (y2 > H || y < top - 2000) continue; }
        g.fillStyle = THEME.hold; g.beginPath(); g.roundRect(x - 7, y2, 14, Math.max(14, y - y2), 7); g.fill();
        g.fillStyle = THEME.holdLight; g.beginPath(); g.arc(x, y - 7, 4, 0, 7); g.fill();
        if (n === selRef) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.roundRect(x - 10, y2 - 3, 20, Math.max(20, y - y2 + 6), 10); g.stroke(); }
      } else {
        if (y < top - 30 || y > H) continue;
        g.fillStyle = rgba(THEME.tap, 0.18); g.beginPath(); g.arc(x, y, 15, 0, 7); g.fill();
        g.fillStyle = THEME.tap; g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill();
        if (n === selRef) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 14, 0, 7); g.stroke(); }
      }
    }

    // triggers
    g.textAlign = 'left';
    for (const { tr, y } of this.trigLayout()) {
      if (y < top - 30 || y > H) continue;
      const T = TRIGGERS[tr.type], x = this.trL + 6, w = this.trW - 12;
      g.fillStyle = T.color; g.beginPath(); g.roundRect(x, y - 11, w, 20, 6); g.fill();
      if (tr.type === 'background' && BG_PRESETS[tr.value]) {
        const p = BG_PRESETS[tr.value];
        g.fillStyle = p.background; g.fillRect(x + w - 18, y - 8, 7, 14);
        g.fillStyle = p.background2; g.fillRect(x + w - 11, y - 8, 7, 14);
      }
      g.fillStyle = '#1b1438'; g.font = '700 10.5px Rubik, sans-serif';
      g.fillText(`${T.short} ${this.trigValueText(tr)}`, x + 6, y + 3.5);
      if (tr === selRef) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.roundRect(x - 2, y - 13, w + 4, 24, 8); g.stroke(); }
    }

    // ghost of what a click would place
    const h = this.hover;
    if (h && !this.drag && h.px >= this.laneL && h.px <= this.laneR && h.py > top && (this.tool === 'tap' || this.tool === 'hold')) {
      const b = this.snapB(this.bOfT(this.tOfY(h.py))), x = this.xOfN(this.nOfX(h.px)), y = this.yOfT(this.tOfB(b));
      if (!this.noteAt(h.px, h.py)) {
        g.globalAlpha = 0.4;
        if (this.tool === 'tap') { g.fillStyle = THEME.tap; g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill(); }
        else { g.fillStyle = THEME.hold; g.beginPath(); g.roundRect(x - 7, y - this.pps * this.spb / this.snap, 14, this.pps * this.spb / this.snap, 7); g.fill(); }
        g.globalAlpha = 1;
      }
    }
    g.restore();

    if (!this.buffer) {
      g.fillStyle = 'rgba(206,203,246,0.7)'; g.font = '500 15px Rubik, sans-serif'; g.textAlign = 'center';
      g.fillText(this.song && this.song.kind === 'file' ? 'Pick the song file to keep editing' : 'Loading song…', this.laneL + this.laneW / 2, H / 2);
    }

    // the hit line (where notes meet the ring in game)
    g.strokeStyle = THEME.player; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(this.wfL, line); g.lineTo(this.trR, line); g.stroke();
    g.fillStyle = THEME.player; g.beginPath(); g.arc(this.wfL - 2, line, 4, 0, 7); g.fill();

    // lane headers
    g.fillStyle = 'rgba(206,203,246,0.55)'; g.font = '600 11px Rubik, sans-serif'; g.textAlign = 'center';
    g.fillText('SONG', this.wfL + this.wfW / 2, top - 16);
    g.fillText('NOTES', this.laneL + this.laneW / 2, top - 16);
    g.fillText('TRIGGERS', this.trL + this.trW / 2, top - 16);
  }

  trigValueText(tr) {
    if (tr.type === 'flip') return tr.value ? '↑' : '↓';
    if (tr.type === 'mirror' || tr.type === 'bars') return tr.value ? 'on' : 'off';
    if (tr.type === 'speed') return `${Number(tr.value).toFixed(2).replace(/\.?0+$/, '')}×`;
    return '';
  }

  // ---------------- side panel ----------------
  renderInspector() {
    const box = $('edInspect'); if (!box) return;
    const s = this.sel;
    if (s && s.kind === 'note' && this.notes.includes(s.ref)) {
      const n = s.ref;
      box.innerHTML = `
        <h3>${n.len ? 'Hold note' : 'Tap note'}</h3>
        <label>Beat<input type="number" step="${1 / this.snap}" min="0" data-f="b" value="${n.b}"></label>
        <label>Position<input type="range" min="0" max="1" step="0.01" data-f="x" value="${n.x}"></label>
        ${n.len ? `<label>Length (beats)<input type="number" step="${1 / this.snap}" min="${1 / this.snap}" data-f="len" value="${n.len}"></label>` : ''}
        <div class="ed-row"><button class="chip" data-act="kind">${n.len ? 'Make tap' : 'Make hold'}</button><button class="chip danger" data-act="del">Delete</button></div>`;
    } else if (s && s.kind === 'trig' && this.triggers.includes(s.ref)) {
      const t = s.ref, T = TRIGGERS[t.type];
      let control = '';
      if (t.type === 'flip') control = this.seg('value', t.value, [[false, 'Fall down'], [true, 'Rise up']]);
      else if (t.type === 'mirror' || t.type === 'bars') control = this.seg('value', t.value, [[true, 'On'], [false, 'Off']]);
      else if (t.type === 'speed') control = `<label>Speed <b data-out>${Number(t.value).toFixed(2)}×</b><input type="range" min="0.5" max="2.5" step="0.05" data-f="value" value="${t.value}"></label>`;
      else control = `<div class="ed-presets">${Object.entries(BG_PRESETS).map(([k, p]) =>
        `<button class="ed-preset ${k === t.value ? 'on' : ''}" data-preset="${k}" style="background:linear-gradient(${p.background},${p.background2} 70%,${p.ground} 70%)"><span>${k}</span></button>`).join('')}</div>`;
      box.innerHTML = `
        <h3><i class="dot" style="background:${T.color}"></i>${T.label}</h3>
        <p class="ed-hint">${T.hint}.</p>
        ${control}
        <label>Beat<input type="number" step="${1 / this.snap}" min="0" data-f="b" value="${t.b}"></label>
        ${t.type === 'bars' || t.type === 'speed' ? '' : `<label>Fade (beats)<input type="number" step="0.25" min="0" max="16" data-f="fade" value="${t.fade ?? 1}"></label>`}
        <div class="ed-row"><button class="chip danger" data-act="del">Delete</button></div>`;
    } else {
      const trigCounts = Object.keys(TRIGGERS).map(k => [k, this.triggers.filter(t => t.type === k).length]).filter(([, c]) => c);
      box.innerHTML = `
        <h3>Level</h3>
        <label>Artist<input data-meta="artist" maxlength="40" value="${esc(this.meta.artist)}" placeholder="8 Arcades"></label>
        <div class="ed-stats">
          <div><b>${this.notes.filter(n => !n.len).length}</b><span>taps</span></div>
          <div><b>${this.notes.filter(n => n.len).length}</b><span>holds</span></div>
          <div><b>${this.triggers.length}</b><span>triggers</span></div>
        </div>
        ${trigCounts.length ? `<p class="ed-hint">${trigCounts.map(([k, c]) => `${c} ${TRIGGERS[k].label.toLowerCase()}`).join(' · ')}</p>` : ''}
        <label class="ed-check"><span>Snap notes sideways</span><button class="toggle ${this.xSnap ? 'on' : ''}" data-act="xsnap"><i></i></button></label>
        <div class="ed-keys">
          <div><kbd>Space</kbd>Preview</div><div><kbd>P</kbd>Playtest from here</div>
          <div><kbd>1</kbd><kbd>2</kbd>Tap, hold</div><div><kbd>3</kbd>–<kbd>7</kbd>Triggers</div>
          <div><kbd>Wheel</kbd>Scroll</div><div><kbd>Ctrl</kbd>+<kbd>Wheel</kbd>Zoom</div>
          <div><kbd>Ctrl</kbd>+<kbd>Z</kbd>Undo</div><div><kbd>Right-click</kbd>Delete</div>
        </div>`;
    }
    this.wireInspector(box);
  }

  seg(field, value, opts) {
    return `<div class="ed-seg">${opts.map(([v, l]) => `<button class="${v === value ? 'on' : ''}" data-seg="${field}" data-v="${v}">${l}</button>`).join('')}</div>`;
  }

  wireInspector(box) {
    const ref = this.sel && this.sel.ref;
    box.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('pointerdown', () => this.snapshot(), { once: true });
      inp.addEventListener('input', () => {
        const f = inp.dataset.f; let v = Number(inp.value);
        if (f === 'b') v = Math.max(0, v);
        if (f === 'len') v = Math.max(1 / this.snap, v);
        ref[f] = v;
        const out = box.querySelector('[data-out]'); if (out && f === 'value') out.textContent = v.toFixed(2) + '×';
        this.sortAll(); this.saveDraft();
      });
    });
    box.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => {
      this.snapshot(); ref[b.dataset.seg] = b.dataset.v === 'true'; this.changed();
    }));
    box.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      this.snapshot(); ref.value = b.dataset.preset; this.changed();
    }));
    box.querySelectorAll('[data-meta]').forEach(inp => inp.addEventListener('input', () => { this.meta[inp.dataset.meta] = inp.value; this.saveDraft(); }));
    box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'del') this.remove(ref);
      else if (a === 'kind') { this.snapshot(); if (ref.len) delete ref.len; else ref.len = 1; this.changed(); }
      else if (a === 'xsnap') { this.xSnap = !this.xSnap; this.renderInspector(); }
    }));
  }

  syncTop() {
    $('edTitle').value = this.meta.title;
    $('edBpm').value = this.meta.bpm;
    $('edOffset').value = Math.round(this.meta.offset * 1000);
    $('edSongName').textContent = this.song ? this.song.name : 'No song';
  }

  status(text, sticky) {
    const el = $('edStatus'); el.textContent = text;
    clearTimeout(this.statusT);
    if (text && !sticky) this.statusT = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // ---------------- menus ----------------
  modal(html) {
    $('edModalBody').innerHTML = html;
    $('edModal').hidden = false;
    $('edModalBody').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => this.closeModal()));
    return $('edModalBody');
  }
  closeModal() { $('edModal').hidden = true; }

  onlineSongs() {
    const list = [];
    for (const lv of LEVELS) if (lv.music) list.push({ lv, song: { kind: 'url', url: lv.music, name: lv.title } });
    for (const lv of Mods.modLevels()) list.push({ lv, song: { kind: 'url', url: lv.music, name: `${lv.title} (${lv.modName})` } });
    return list;
  }

  openMenu() {
    const levels = this.onlineSongs();
    const body = this.modal(`
      <h2>Open</h2>
      <div class="ed-list">
        <button data-open="new"><b>New level</b><span>Empty chart on the current song</span></button>
        <button data-open="test"><b>Test Level</b><span>The built-in level, with its triggers</span></button>
        ${levels.map((l, i) => `<button data-open="${i}"><b>${esc(l.lv.title)}</b><span>${l.lv.modName ? 'from ' + esc(l.lv.modName) : 'level ' + l.lv.slot}${l.lv.notes ? '' : ' · chart made from the song'}</span></button>`).join('')}
      </div>
      <div class="ed-row end"><button class="chip" data-close>Cancel</button></div>`);
    body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', async () => {
      const k = b.dataset.open;
      this.closeModal();
      if (k === 'new') {
        this.snapshot();
        this.meta = { ...this.meta, title: 'Untitled' }; this.notes = []; this.triggers = []; this.sel = null;
        this.changed(); this.syncTop();
      } else if (k === 'test') {
        await this.loadLevel(this.builtInTemplate(true));
      } else {
        const { lv, song } = levels[Number(k)];
        await this.loadLevel({ title: lv.title, artist: lv.artist, bpm: lv.bpm, offset: lv.offset, notes: lv.notes, triggers: lv.triggers, density: lv.density, song });
      }
    }));
  }

  songMenu() {
    const songs = this.onlineSongs();
    const body = this.modal(`
      <h2>Song</h2>
      <p class="ed-hint">Set the BPM and first-beat offset at the top so the grid lines up with the music.</p>
      <div class="ed-list">
        <label class="ed-file"><input type="file" accept="audio/*" id="edFile"><b>From your computer</b><span>mp3, wav, ogg, m4a…</span></label>
        <button data-song="synth"><b>Built-in beat</b><span>120 BPM</span></button>
        ${songs.map((s, i) => `<button data-song="${i}"><b>${esc(s.song.name)}</b><span>${s.lv.bpm} BPM</span></button>`).join('')}
      </div>
      <div class="ed-row end"><button class="chip" data-close>Cancel</button></div>`);
    body.querySelector('#edFile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      this.closeModal();
      try { await this.loadSong({ kind: 'file', name: f.name, file: f }); this.saveDraft(); }
      catch { this.status("That file couldn't be read as audio"); }
    });
    body.querySelectorAll('[data-song]').forEach(b => b.addEventListener('click', async () => {
      const k = b.dataset.song;
      this.closeModal();
      const song = k === 'synth' ? this.builtInTemplate(false).song : songs[Number(k)].song;
      if (k !== 'synth') { this.snapshot(); this.meta.bpm = songs[Number(k)].lv.bpm; this.meta.offset = songs[Number(k)].lv.offset || 0; }
      else { this.meta.bpm = 120; this.meta.offset = 0; }
      try { await this.loadSong(song); this.saveDraft(); } catch { this.status("That song couldn't be loaded"); }
    }));
  }

  chartJSON() { return { notes: this.notes, triggers: this.triggers }; }

  async songBlob() {
    if (!this.song) throw new Error('Pick a song first');
    if (this.song.kind === 'file') return { blob: this.song.file, ext: (this.song.file.name.split('.').pop() || 'mp3').toLowerCase() };
    if (this.song.kind === 'url') {
      const r = await fetch(this.song.url); if (!r.ok) throw new Error("Couldn't fetch the song");
      return { blob: await r.blob(), ext: (decodeURIComponent(this.song.url).split('.').pop() || 'mp3').toLowerCase() };
    }
    return { blob: bufferToWav(this.buffer), ext: 'wav' };
  }

  async shareMenu() {
    const online = await this.hooks.online();
    const body = this.modal(`
      <h2>Save</h2>
      <p class="ed-hint">Your work is kept in this browser as you go.</p>
      <div class="ed-card">
        <b>Copy the chart</b><span>Paste it into the song page or a mod.</span>
        <div class="ed-row"><button class="chip" id="edCopy">Copy</button></div>
        <textarea id="edJson" rows="3" readonly hidden></textarea>
      </div>
      ${online ? `
      <div class="ed-card">
        <b>Put it on one of your levels</b><span>Uses the song and chart in the editor.</span>
        <div class="ed-row">
          <select id="edSlot"><option value="1">Level 1</option><option value="2">Level 2</option><option value="3">Level 3</option></select>
          <input id="edPw" type="password" placeholder="Songs password" value="${esc(sessionStorage.getItem('rf-admin') || '')}">
          <button class="chip primary" id="edToSlot">Save</button>
        </div>
      </div>
      <div class="ed-card">
        <b>Publish to Waterfall</b><span>Anyone can download it as a mod.</span>
        <div class="ed-row">
          <input id="edModName" maxlength="40" value="${esc(this.meta.title)}" placeholder="Mod name">
          <input id="edModBy" maxlength="30" placeholder="Your name">
          <button class="chip primary" id="edPublish">Publish</button>
        </div>
      </div>` : `
      <div class="ed-card"><b>Levels and Waterfall</b><span>Saving to your levels and publishing mods works on <a href="${esc(Mods.WATERFALL_HOME)}" target="_blank" rel="noopener">Ringfall online</a>.</span></div>`}
      <p class="ed-msg" id="edMsg"></p>
      <div class="ed-row end"><button class="chip" data-close>Done</button></div>`);

    const msg = (t, ok) => { const m = body.querySelector('#edMsg'); m.textContent = t; m.className = 'ed-msg ' + (ok ? 'ok' : 'err'); };
    body.querySelector('#edCopy').addEventListener('click', async () => {
      const text = JSON.stringify(this.chartJSON());
      try { await navigator.clipboard.writeText(text); msg('Chart copied.', true); }
      catch { const ta = body.querySelector('#edJson'); ta.hidden = false; ta.value = text; ta.select(); msg('Copy it from the box.', true); }
    });
    if (!online) return;

    body.querySelector('#edToSlot').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.disabled = true; msg('Uploading…', true);
      try {
        const pw = body.querySelector('#edPw').value;
        const { blob, ext } = await this.songBlob();
        const fd = new FormData();
        fd.append('slot', body.querySelector('#edSlot').value);
        fd.append('title', this.meta.title); fd.append('artist', this.meta.artist);
        fd.append('bpm', this.meta.bpm); fd.append('offsetMs', Math.round(this.meta.offset * 1000));
        fd.append('density', 'normal'); fd.append('chart', JSON.stringify(this.chartJSON()));
        fd.append('file', new File([blob], `${(this.meta.title || 'song').replace(/[^a-z0-9]+/gi, '-')}.${ext}`));
        const r = await fetch('api/admin/upload', { method: 'POST', headers: { 'x-admin-password': pw }, body: fd });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(res.error || 'Upload failed');
        sessionStorage.setItem('rf-admin', pw);
        msg(`Saved to level ${body.querySelector('#edSlot').value}. Reload the game to play it.`, true);
      } catch (err) { msg(err.message, false); }
      btn.disabled = false;
    });

    body.querySelector('#edPublish').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.disabled = true; msg('Publishing…', true);
      try {
        const { blob, ext } = await this.songBlob();
        const name = body.querySelector('#edModName').value.trim() || this.meta.title;
        const manifest = {
          name, author: body.querySelector('#edModBy').value.trim(), version: '1.0',
          description: `A level made in the Ringfall editor.`,
          levels: [{ title: this.meta.title, artist: this.meta.artist, bpm: this.meta.bpm, offsetMs: Math.round(this.meta.offset * 1000), density: 'normal', music: `level1.${ext}`, chart: this.chartJSON() }],
        };
        const fd = new FormData();
        fd.append('manifest', JSON.stringify(manifest));
        fd.append('files', new File([blob], `level1.${ext}`));
        const r = await fetch('api/mods', { method: 'POST', body: fd });
        const res = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(res.error || 'Publishing failed');
        msg(`On Waterfall now. Mod ID ${res.id} · key ${res.key} (keep these to update it).`, true);
      } catch (err) { msg(err.message, false); }
      btn.disabled = false;
    });
  }
}
