// Ringfall engine: draws the world, handles the player, menus-on-the-track, and gameplay.
import { settings } from './settings.js';
import { THEME, rgba, BG_PRESETS, BG_KEYS, mix } from './theme.js';
import { Backdrop } from './backdrop.js';

// Swap these for your own drawings (PNG paths, e.g. 'sprites/player.png').
// Leave null to use the built-in shapes. Mods can replace them too.
export const SPRITES = {
  player: null,      // drawn over the player circle
  tap: null,         // drawn on each tap note
  background: null,  // full-screen picture behind everything
};

// Colour names used below map onto the theme (which mods can change).
const COL = new Proxy({}, { get: (_, k) => ({
  track: THEME.track, violet: THEME.accent, lav: THEME.soft, white: THEME.ring, text: THEME.text,
  pink: THEME.player, yellow: THEME.tap, teal: THEME.hold, tealLt: THEME.holdLight,
})[k] });
// Timing windows (seconds), hit-ring size, note speed, health lost per miss, score multiplier.
export const DIFFICULTY = {
  easy:   { label: 'Easy',   perfect: 0.07,  good: 0.15,  ring: 1.15, speed: 0.85, dmg: 0,    score: 0.8 },
  normal: { label: 'Normal', perfect: 0.055, good: 0.12,  ring: 1,    speed: 1,    dmg: 0.08, score: 1 },
  hard:   { label: 'Hard',   perfect: 0.038, good: 0.085, ring: 0.8,  speed: 1.35, dmg: 0.16, score: 1.3 },
};
const FONT = '"Press Start 2P", monospace';
const px8 = n => Math.max(8, Math.round(n / 8) * 8); // pixel font looks right on multiples of 8

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export class Game {
  constructor(canvas, audio, hooks) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.audio = audio;
    this.hooks = hooks; // { onScore, onCombo, onProgress, onFinish, onPortalHover, onPortalSelect }
    this.mode = 'menu';
    this.inputLocked = false;
    this.target = 0.5; this.px = 0.5;
    this.keyDown = false;
    this.particles = []; this.popups = []; this.bursts = []; this.deco = [];
    this.portals = []; this.hover = null; this.selecting = null;
    this.fill = 0; this.decoClock = 0;
    this.images = {};
    this.setSprites({});
    this.backdrop = new Backdrop();
    this.held = new Set();          // hit inputs currently down
    this.moveHeld = { left: new Set(), right: new Set() };
    this.stick = 0;
    this.win = DIFFICULTY.normal; this.hp = 1;
    this.resetFx();

    this.resize();
    addEventListener('resize', () => this.resize());
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
  }

  // ---------------- layout ----------------
  // The game draws on a small canvas that the page scales up without smoothing: chunky pixels.
  resize() {
    const PX = this.PX = clamp(Math.round(innerHeight / 210), 2, 6);
    this.W = Math.ceil(innerWidth / PX); this.H = Math.ceil(innerHeight / PX);
    this.cv.width = this.W; this.cv.height = this.H;
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.imageSmoothingEnabled = false;
    const pfW = Math.min(this.W * 0.92, 640 / PX);
    this.s = clamp(Math.min(pfW / 360, this.H / 520), 0.3, 1.9);
    this.trackL = (this.W - pfW) / 2 + 12 * this.s;
    this.trackR = (this.W + pfW) / 2 - 12 * this.s;
    this.trackY = Math.round(this.H * 0.74);
    this.R = 26 * this.s;        // ring radius (hit zone)
    this.PR = 18 * this.s;       // player circle radius
    this.NR = 10 * this.s;       // tap note radius
  }
  xpx(x) { return lerp(this.trackL, this.trackR, x); }

  // ---- pixel drawing: everything snaps to whole pixels ----
  disc(x, y, r) {
    const g = this.g; r = Math.max(1, Math.round(r)); x = Math.round(x); y = Math.round(y);
    for (let dy = -r; dy <= r; dy++) { const w = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy))); g.fillRect(x - w, y + dy, w * 2 + 1, 1); }
  }
  ringPx(x, y, r, t = 1, onlyTop = false) {
    const g = this.g; x = Math.round(x); y = Math.round(y);
    const ro = Math.round(r), ri = Math.max(0, ro - Math.max(1, Math.round(t)));
    for (let dy = -ro; dy <= ro; dy++) {
      if (onlyTop && dy > -ri * 0.55) break;
      const o = Math.round(Math.sqrt(Math.max(0, ro * ro - dy * dy)));
      const i = Math.abs(dy) < ri ? Math.round(Math.sqrt(ri * ri - dy * dy)) : -1;
      if (i < 0) g.fillRect(x - o, y + dy, o * 2 + 1, 1);
      else { g.fillRect(x - o, y + dy, o - i, 1); g.fillRect(x + i + 1, y + dy, o - i, 1); }
    }
  }
  pill(x, y, w, h) { // rectangle with the corners nipped off
    const g = this.g; x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (h < 3 || w < 3) { g.fillRect(x, y, w, h); return; }
    g.fillRect(x + 1, y, w - 2, h); g.fillRect(x, y + 1, w, h - 2);
  }

  setSprites(overrides) {
    this.images = {};
    for (const [k, def] of Object.entries(SPRITES)) {
      const src = overrides[k] || def;
      if (src) { const im = new Image(); im.crossOrigin = 'anonymous'; im.src = src; this.images[k] = im; }
    }
  }

  // ---------------- input ----------------
  pointerMove(e) {
    const x = (e.clientX / this.PX - this.trackL) / (this.trackR - this.trackL);
    this.target = clamp(x, 0, 1);
    if (e.pointerType !== 'mouse' && e.type === 'pointerdown') this.px = this.target;
  }

  // a bound input went down/up. id tells inputs apart so two keys can alternate.
  action(name, down, id) {
    if (name === 'left' || name === 'right') {
      if (id === '*') this.moveHeld[name].clear();
      else if (down) this.moveHeld[name].add(id); else this.moveHeld[name].delete(id);
      return;
    }
    if (id === '*') { const had = this.held.size; this.held.clear(); if (had) this.release(); return; }
    if (down) {
      if (this.held.has(id)) return;
      this.held.add(id);
      this.press();
    } else {
      if (!this.held.delete(id)) return;
      if (this.held.size === 0) this.release();
    }
  }

  menuClick() { if (this.mode === 'menu' || this.mode === 'levels') { this.px = this.target; this.press(); } }

  press() {
    if (this.inputLocked) return;
    if (this.mode === 'menu' || this.mode === 'levels') return this.selectPortal();
    if (this.mode !== 'play') return;
    this.keyDown = true;
    const t = this.time();
    let best = null, bestDt = 1;
    for (const n of this.notes) {
      if (n.state !== 0) continue;
      const dt = Math.abs(t - n.t);
      if (n.t - t > this.win.good) break;
      if (dt <= this.win.good && dt < bestDt && this.aligned(n.x, 0)) { best = n; bestDt = dt; }
    }
    if (!best) { this.bursts.push({ x: this.px, r: this.R, a: 0.25, col: COL.lav }); return; }
    const kind = bestDt <= this.win.perfect ? 'perfect' : 'good';
    if (best.hold) { best.state = 1; this.holding = best; }
    else best.state = 2;
    this.judge(kind);
    this.audio.hitSound(kind);
    this.bursts.push({ x: this.nx(best.x), r: this.R, a: 0.9, col: kind === 'perfect' ? COL.tealLt : COL.yellow });
  }

  release() {
    this.keyDown = false;
    if (this.mode !== 'play' || !this.holding) return;
    const n = this.holding, t = this.time();
    if (t < n.end - this.win.good) this.breakHold(n); else this.completeHold(n);
  }

  // ---------------- menus on the track ----------------
  setPortals(list, mode) {
    this.mode = mode;
    this.portals = list.map(p => ({ ...p, glow: 0 }));
    this.hover = null; this.selecting = null;
    this.notes = []; this.holding = null;
  }
  portalAt(x) {
    return this.portals.find(p => Math.abs(this.xpx(p.x) - this.xpx(x)) < this.R * 1.1) || null;
  }
  selectPortal() {
    if (this.selecting) return;
    const p = this.portalAt(this.px);
    if (!p) return;
    if (p.locked) {
      p.shake = 1;
      this.popups.push({ x: p.x, y: this.trackY - this.R - 34 * this.s, text: 'LOCKED', col: COL.pink, life: 0.8, max: 0.8 });
      return;
    }
    this.selecting = p;
    this.bursts.push({ x: p.x, r: this.R, a: 1, col: COL.white, big: true });
    for (let i = 0; i < 26; i++) this.spark(this.xpx(p.x), this.trackY, COL.pink, 260);
    this.audio.ensure();
    this.audio.hitSound('perfect');
    setTimeout(() => { this.selecting = null; this.hooks.onPortalSelect?.(p); }, 260);
  }

  // ---------------- gameplay ----------------
  // opts.from: start part-way in (seconds), for playtesting from the editor
  start(level, buffer, duration, opts = {}) {
    const spb = 60 / level.bpm, off = level.offset || 0, from = Math.max(0, opts.from || 0);
    this.level = level; this.spb = spb; this.off = off; this.from = from;
    this.win = DIFFICULTY[settings.difficulty] || DIFFICULTY.normal;
    this.noFail = !!opts.noFail || this.win.dmg === 0;
    this.hp = 1; this.hooks.onHealth?.(1, this.noFail);
    this.notes = level.notes.map(n => ({
      t: off + n.b * spb, x: clamp(n.x, 0, 1),
      hold: !!n.len, end: off + (n.b + (n.len || 0)) * spb, state: 0,
    })).sort((a, b) => a.t - b.t);
    for (const n of this.notes) if (n.t < from - 0.01) n.state = 5; // skipped, before the playtest start
    this.resetFx();
    this.triggers = (level.triggers || []).map(tr => ({ ...tr, t: off + tr.b * spb })).sort((a, b) => a.t - b.t);
    this.trigIdx = 0;
    this.applyTriggers(from - 0.001, true);
    this.duration = duration;
    this.stats = { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0 };
    this.holding = null; this.fill = 0; this.keyDown = false; this.held.clear();
    this.particles = []; this.popups = []; this.bursts = []; this.portals = [];
    this.mode = 'play';
    this.hooks.onScore(0); this.hooks.onCombo(0, false);
    this.audio.start(level, buffer, 3, from);
  }

  time() { return this.audio.time() - settings.offsetMs / 1000; }

  pause() {
    if (this.mode !== 'play') return;
    this.mode = 'paused'; this.audio.pause(); this.keyDown = false; this.held.clear();
    if (this.holding) this.breakHold(this.holding);
  }
  resume() { if (this.mode !== 'paused') return; this.mode = 'play'; this.audio.resume(); }
  quit() { this.audio.stop(); this.notes = []; this.holding = null; this.resetFx(); }

  // ---------------- triggers ----------------
  resetFx() {
    if (this.fx && this.fx.bg) for (const k of BG_KEYS) THEME[k] = this.fx.bgBase[k];
    this.fx = {
      flip: 0, flipTo: 0, flipRate: 4,
      mirror: 0, mirrorTo: 0, mirrorRate: 4,
      speed: 1, speedTo: 1,
      bg: null, bgBase: Object.fromEntries(BG_KEYS.map(k => [k, THEME[k]])),
    };
    if (this.backdrop) this.backdrop.barsOn = true;
    this.triggers = []; this.trigIdx = 0;
  }

  applyTriggers(t, instant) {
    while (this.trigIdx < this.triggers.length && this.triggers[this.trigIdx].t <= t) {
      const tr = this.triggers[this.trigIdx++], fx = this.fx;
      const secs = Math.max(0.05, (tr.fade ?? 1) * this.spb);
      if (tr.type === 'flip') { fx.flipTo = tr.value ? 1 : 0; fx.flipRate = 1 / secs; if (instant) fx.flip = fx.flipTo; }
      else if (tr.type === 'mirror') { fx.mirrorTo = tr.value ? 1 : 0; fx.mirrorRate = 1 / secs; if (instant) fx.mirror = fx.mirrorTo; }
      else if (tr.type === 'bars') { this.backdrop.barsOn = !!tr.value; if (instant) this.backdrop.barsA = tr.value ? 1 : 0; }
      else if (tr.type === 'speed') { fx.speedTo = clamp(Number(tr.value) || 1, 0.5, 2.5); if (instant) fx.speed = fx.speedTo; }
      else if (tr.type === 'background' && BG_PRESETS[tr.value]) {
        const from = Object.fromEntries(BG_KEYS.map(k => [k, THEME[k]]));
        fx.bg = { from, to: BG_PRESETS[tr.value], p: instant ? 1 : 0, rate: 1 / secs };
        if (instant) for (const k of BG_KEYS) THEME[k] = fx.bg.to[k];
      }
    }
  }

  updateFx(dt) {
    const fx = this.fx;
    const step = (v, to, rate) => v < to ? Math.min(to, v + rate * dt) : Math.max(to, v - rate * dt);
    fx.flip = step(fx.flip, fx.flipTo, fx.flipRate);
    fx.mirror = step(fx.mirror, fx.mirrorTo, fx.mirrorRate);
    fx.speed = lerp(fx.speed, fx.speedTo, Math.min(1, dt * 4));
    if (fx.bg && fx.bg.p < 1) {
      fx.bg.p = Math.min(1, fx.bg.p + fx.bg.rate * dt);
      const e = fx.bg.p * fx.bg.p * (3 - 2 * fx.bg.p);
      for (const k of BG_KEYS) THEME[k] = mix(fx.bg.from[k], fx.bg.to[k], e);
    }
  }

  // where a note really sits, after any mirror trigger
  nx(x) { return lerp(x, 1 - x, this.fx.mirror); }
  ringR() { return this.R * (this.mode === 'menu' || this.mode === 'levels' ? 1 : this.win.ring); }
  aligned(x, extra) { return Math.abs(this.xpx(this.nx(x)) - this.xpx(this.px)) <= this.ringR() + this.NR * 0.5 + extra; }

  mult() { return 1 + Math.min(this.stats.combo, 100) / 100; }

  judge(kind) {
    const st = this.stats;
    if (kind === 'miss') {
      st.miss++; const had = st.combo; st.combo = 0;
      this.hooks.onCombo(0, had > 0);
      if (!this.noFail) this.hp -= this.win.dmg;
    } else {
      st[kind]++; st.combo++; st.maxCombo = Math.max(st.maxCombo, st.combo);
      st.score += (kind === 'perfect' ? 300 : 100) * this.mult() * this.win.score;
      this.hooks.onCombo(st.combo, true);
      this.hp = Math.min(1, this.hp + (kind === 'perfect' ? 0.025 : 0.012));
    }
    this.hooks.onHealth?.(Math.max(0, this.hp), this.noFail);
    if (this.hp <= 0 && this.mode === 'play') this.fail();
    this.hooks.onScore(st.score);
    const text = { perfect: 'PERFECT', good: 'GOOD', miss: 'MISS' }[kind];
    const col = { perfect: COL.tealLt, good: COL.yellow, miss: COL.pink }[kind];
    this.popups.push({ x: this.px, y: this.trackY - this.R - 30 * this.s, text, col, life: 0.6, max: 0.6 });
  }

  breakHold(n) { n.state = 3; this.holding = null; this.judge('miss'); }
  fail() {
    this.mode = 'done';
    this.stats.failed = true;
    if (this.holding) { this.holding.state = 3; this.holding = null; }
    this.bursts.push({ x: this.px, r: this.R, a: 1, col: COL.pink, big: true });
    for (let i = 0; i < 30; i++) this.spark(this.xpx(this.px), this.trackY, COL.pink, 300);
    if (this.audio.bus) this.audio.bus.gain.setTargetAtTime(0, this.audio.ctx.currentTime, 0.25);
    setTimeout(() => { this.audio.stop(); this.resetFx(); }, 900);
    this.hooks.onFinish({ ...this.stats, total: this.notes.reduce((s, n) => s + (n.hold ? 2 : 1), 0) });
  }
  completeHold(n) {
    n.state = 2; this.holding = null; this.judge('perfect');
    this.bursts.push({ x: this.nx(n.x), r: this.R, a: 1, col: COL.tealLt, big: true });
    for (let i = 0; i < 14; i++) this.spark(this.xpx(this.px), this.trackY - this.R, COL.tealLt, 200);
  }

  update(t, dt) {
    this.applyTriggers(t, false);
    for (const n of this.notes) {
      if (n.state === 0 && t - n.t > this.win.good) { n.state = 3; this.judge('miss'); }
      if (n.t - t > 4) break;
    }
    const h = this.holding;
    if (h) {
      if (!this.aligned(h.x, 8 * this.s)) this.breakHold(h);
      else if (t >= h.end) this.completeHold(h);
      else {
        this.stats.score += 150 * dt * this.mult() * this.win.score;
        this.hooks.onScore(this.stats.score);
        if (Math.random() < dt * 40) this.spark(this.xpx(this.px), this.trackY - this.R, COL.tealLt, 140, true);
      }
    }
    // teal fill grows with hold progress, drains otherwise
    const goal = h ? clamp((t - h.t) / Math.max(0.01, h.end - h.t), 0.25, 1) : 0;
    this.fill = goal > this.fill ? lerp(this.fill, goal, Math.min(1, dt * 12)) : Math.max(0, this.fill - dt * 2.2);

    this.hooks.onProgress(clamp(t / this.duration, 0, 1));
    const done = this.notes.every(n => n.state >= 2);
    if (t > this.duration + 0.3 || (done && t > this.duration - 0.2)) {
      this.mode = 'done';
      setTimeout(() => { this.audio.stop(); this.resetFx(); }, 400);
      this.hooks.onFinish({ ...this.stats, total: this.notes.reduce((s, n) => s + (n.hold ? 2 : 1), 0) });
    }
  }

  spark(x, y, col, speed, up) {
    const a = up ? -Math.PI / 2 + (Math.random() - 0.5) * 1.8 : Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8) * this.s;
    this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.45, max: 0.45, col, r: (1.5 + Math.random() * 1.6) * this.s });
  }

  // ---------------- loop ----------------
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const keyMove = (this.moveHeld.right.size ? 1 : 0) - (this.moveHeld.left.size ? 1 : 0);
    if (keyMove) this.target = clamp(this.target + keyMove * dt * 1.6, 0, 1);
    if (this.stick) this.target = clamp(this.target + this.stick * dt * 1.9, 0, 1);
    const follow = this.mode === 'play' ? 45 : 14;
    this.px = lerp(this.px, this.target, Math.min(1, dt * follow));

    let t = null, pulse;
    if (this.mode === 'play' || this.mode === 'paused' || this.mode === 'done') {
      t = this.time();
      if (this.mode === 'play') { this.update(t, dt); this.updateFx(dt); }
      const beat = (t - this.off) / this.spb;
      pulse = t < this.off ? 0 : Math.exp(-(beat - Math.floor(beat)) * 6);
    } else {
      const beat = now / 1000 / (60 / 100);
      pulse = Math.exp(-(beat - Math.floor(beat)) * 6);
      this.updateMenu(dt);
    }

    this.backdrop.update(dt, pulse, this.mode === 'play' ? this.audio.bands() : null);

    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 420 * this.s * dt; p.life -= dt; }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const p of this.popups) { p.life -= dt; p.y -= 26 * this.s * dt; }
    this.popups = this.popups.filter(p => p.life > 0);
    for (const b of this.bursts) { b.a -= dt * (b.big ? 2.2 : 3.2); b.r += dt * (b.big ? 160 : 90) * this.s; }
    this.bursts = this.bursts.filter(b => b.a > 0);

    this.draw(t, pulse);
    requestAnimationFrame(tt => this.frame(tt));
  }

  updateMenu(dt) {
    // decorative notes drifting down behind the menu
    this.decoClock -= dt;
    if (this.decoClock <= 0) {
      this.decoClock = 0.5 + Math.random() * 0.6;
      const hold = Math.random() < 0.25;
      this.deco.push({ x: Math.random(), y: -40, v: (70 + Math.random() * 40) * this.s, hold, len: (80 + Math.random() * 120) * this.s });
    }
    for (const d of this.deco) d.y += d.v * dt;
    this.deco = this.deco.filter(d => d.y - (d.hold ? d.len : 0) < this.trackY - this.R * 2);

    const hov = this.portalAt(this.px);
    for (const p of this.portals) {
      const over = p === hov;
      p.glow = lerp(p.glow, over ? 1 : 0, Math.min(1, dt * 12));
      if (p.shake) p.shake = Math.max(0, p.shake - dt * 3);
    }
    if (hov !== this.hover) { this.hover = hov; this.hooks.onPortalHover?.(hov); }
  }

  // ---------------- drawing ----------------
  draw(t, pulse) {
    const g = this.g, W = this.W, H = this.H, s = this.s, ty = this.trackY;
    this.backdrop.draw(g, W, H, s, ty, this.px, pulse, this.images.background);

    const pxp = this.xpx(this.px);
    const playing = this.mode !== 'menu' && this.mode !== 'levels';
    const k = playing ? Math.cos(Math.PI * this.fx.flip) : 1;   // 1 = normal, -1 = flipped
    const flipY = y => H / 2 + (y - H / 2) * k;
    g.save();
    g.translate(0, H / 2); g.scale(1, Math.abs(k) < 0.02 ? 0.02 * Math.sign(k || 1) : k); g.translate(0, -H / 2);

    // faint lane above the player so you can line notes up
    const beam = g.createLinearGradient(0, ty, 0, ty - H * 0.6);
    beam.addColorStop(0, rgba(THEME.ring, 0.08)); beam.addColorStop(1, rgba(THEME.ring, 0));
    g.fillStyle = beam; g.fillRect(pxp - this.R, ty - H * 0.6, this.R * 2, H * 0.6);

    // track
    g.fillStyle = COL.track; g.fillRect(Math.round(this.trackL), Math.round(ty) - 1, Math.round(this.trackR - this.trackL), Math.max(2, Math.round(2 * s)));

    if (this.mode === 'menu' || this.mode === 'levels') { this.drawDeco(); this.drawPortals(pulse); }
    else this.drawNotes(t);

    this.drawPlayer(pulse);

    for (const b of this.bursts) {
      g.globalAlpha = Math.max(0, b.a) * 0.8;
      g.fillStyle = b.col; this.ringPx(this.xpx(b.x), ty, b.r, b.big ? 2 : 1);
    }
    g.globalAlpha = 1;
    for (const p of this.particles) {
      g.globalAlpha = p.life / p.max > 0.5 ? 1 : 0.6;
      const sz = Math.max(1, Math.round(p.r));
      g.fillStyle = p.col; g.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
    }
    g.globalAlpha = 1;
    g.restore();
    g.textAlign = 'center';
    for (const p of this.popups) {
      const a = p.life / p.max;
      g.globalAlpha = Math.min(1, a * 2);
      g.fillStyle = p.col;
      g.font = `${px8(15 * s)}px ${FONT}`;
      g.letterSpacing = '0px';
      g.fillText(p.text, this.xpx(p.x), flipY(p.y));
    }
    g.letterSpacing = '0px';
    g.globalAlpha = 1;

    // countdown during lead-in
    const go = Math.max(this.off || 0, this.from || 0);
    if (t !== null && t < go - 0.05 && this.mode !== 'done') {
      const n = Math.ceil(go - t);
      if (n <= 3) {
        const frac = (go - t) % 1;
        g.globalAlpha = Math.min(1, frac * 2.2);
        g.fillStyle = COL.text;
        g.font = `${px8(84 * s)}px ${FONT}`;
        g.fillText(String(n), W / 2, H * 0.42);
        g.globalAlpha = 1;
      }
    }
  }

  drawDeco() {
    const g = this.g;
    g.globalAlpha = 0.28;
    for (const d of this.deco) {
      const x = this.xpx(d.x);
      if (d.hold) { g.fillStyle = COL.teal; this.pill(x - 7 * this.s, d.y - d.len, 14 * this.s, d.len); }
      else { g.fillStyle = COL.yellow; this.disc(x, d.y, this.NR); }
    }
    g.globalAlpha = 1;
  }

  drawPortals(pulse) {
    const g = this.g, s = this.s, ty = this.trackY;
    g.textAlign = 'center';
    this.portals.forEach((p, i) => {
      const shake = p.shake ? Math.sin(p.shake * 40) * 6 * s * p.shake : 0;
      const x = this.xpx(p.x) + shake, k = p.glow;
      const sel = this.selecting === p;

      // column of light above the portal
      const col = g.createLinearGradient(0, ty, 0, ty - 150 * s);
      col.addColorStop(0, rgba(THEME.player, 0.04 + k * 0.16)); col.addColorStop(1, rgba(THEME.player, 0));
      g.fillStyle = col; g.fillRect(x - this.R * 0.9, ty - 150 * s, this.R * 1.8, 150 * s);
      // little post the gate hangs from
      g.fillStyle = rgba(THEME.accent, 0.35 + k * 0.4);
      g.fillRect(Math.round(x), Math.round(ty - 36 * s), 1, Math.round(36 * s - this.R * 0.7));

      // the gate: a ring sitting on the track
      g.globalAlpha = p.locked ? 0.45 : 1;
      g.fillStyle = k > 0.5 ? COL.white : COL.violet;
      const r = this.R * (0.62 + k * 0.08 + (sel ? 0.2 : 0));
      this.ringPx(x, ty, r, k > 0.5 && pulse > 0.5 ? 2 : 1);
      g.fillStyle = p.locked ? COL.track : COL.yellow;
      this.disc(x, ty, Math.max(1, 4.5 * s * (1 + k * 0.5)));

      // label
      const ly = Math.round(ty - 44 * s - (i % 2 ? 22 : 0) - (k > 0.5 ? 2 : 0));
      g.fillStyle = k > 0.5 ? COL.text : COL.lav;
      g.globalAlpha = (p.locked ? 0.45 : 0.7) + k * 0.3;
      g.font = `8px ${FONT}`;
      g.fillText(p.label, x, ly);
      if (p.sub && k > 0.5) {
        g.font = `8px ${FONT}`;
        g.fillStyle = COL.lav; g.globalAlpha = 0.8;
        g.fillText(p.sub, x, ly + 11);
      }
      g.globalAlpha = 1;
    });
  }

  drawNotes(t) {
    if (t === null) return;
    const g = this.g, s = this.s, ty = this.trackY;
    const approach = 1.7 / (settings.speed * this.fx.speed * this.win.speed);
    const span = ty + 40 * s;
    const yOf = nt => ty - (nt - t) / approach * span;

    for (const n of this.notes) {
      if (n.t - t > approach * 1.1) break;
      if (n.state === 5) continue;
      const x = this.xpx(this.nx(n.x));
      if (n.hold) {
        if (n.state === 2) continue;
        const top = yOf(n.end);
        let bot = n.state === 1 ? ty : yOf(n.t);
        if (top > this.H + 20) continue;
        const w = 14 * s;
        g.globalAlpha = n.state === 3 ? 0.22 : 1;
        if (n.state === 3) bot = Math.max(bot, top);
        const h = Math.max(w, bot - top);
        const grad = g.createLinearGradient(0, top, 0, top + h);
        grad.addColorStop(0, rgba(THEME.hold, 0.55)); grad.addColorStop(0.2, COL.teal); grad.addColorStop(1, COL.teal);
        g.fillStyle = grad;
        this.pill(x - w / 2, top, w, h);
        g.fillStyle = rgba(THEME.holdLight, 0.5); g.fillRect(Math.round(x - w / 2 + 1), Math.round(top + 1), 1, Math.max(0, Math.round(h - 2))); // edge light
        if (n.state === 0) { g.fillStyle = COL.tealLt; this.disc(x, bot - w / 2, Math.max(1, w * 0.25)); }
        g.globalAlpha = 1;
      } else {
        if (n.state === 2) continue;
        const y = yOf(n.t);
        if (y > this.H + 20) continue;
        g.globalAlpha = n.state === 3 ? 0.25 : 1;
        const img = this.images.tap;
        if (img && img.complete && img.naturalWidth) {
          g.drawImage(img, x - this.NR * 1.2, y - this.NR * 1.2, this.NR * 2.4, this.NR * 2.4);
        } else {
          g.fillStyle = rgba(THEME.tap, 0.2); this.ringPx(x, y, this.NR * 1.6, 1);
          g.fillStyle = COL.yellow; this.disc(x, y, this.NR);
          g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(Math.round(x - this.NR * 0.45), Math.round(y - this.NR * 0.5), Math.max(1, Math.round(this.NR * 0.35)), Math.max(1, Math.round(this.NR * 0.35)));
        }
        g.globalAlpha = 1;
      }
    }
  }

  drawPlayer(pulse) {
    const g = this.g, s = this.s, ty = this.trackY, x = this.xpx(this.px);
    const img = this.images.player;
    if (img && img.complete && img.naturalWidth) {
      g.drawImage(img, Math.round(x - this.PR), Math.round(ty - this.PR), Math.round(this.PR * 2), Math.round(this.PR * 2));
    } else {
      g.fillStyle = rgba(THEME.ground, 0.9); this.disc(x + 1, ty + 1, this.PR);   // hard drop shadow
      g.fillStyle = COL.pink; this.disc(x, ty, this.PR);
      g.fillStyle = 'rgba(255,255,255,0.45)'; this.disc(x - this.PR * 0.35, ty - this.PR * 0.4, Math.max(1, this.PR * 0.22)); // shine
    }
    if (this.fill > 0.01) { g.fillStyle = COL.teal; this.disc(x, ty, this.PR * this.fill); }
    const r = this.ringR() * (1 + pulse * 0.07);
    g.fillStyle = COL.white; g.globalAlpha = 0.75 + pulse * 0.25;
    this.ringPx(x, ty, r, pulse > 0.5 ? 2 : 1);
    g.globalAlpha = 1;
    if (this.holding) { g.fillStyle = COL.tealLt; this.ringPx(x, ty, r + 1, Math.max(2, 3 * s), true); }
  }

  roundRect(x, y, w, h, r) {
    const g = this.g; r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
  }
}
