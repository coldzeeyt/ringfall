// The world behind the track: stars, slow rings, hills, drifting shapes,
// and bars along the ground that move with the music.
import { THEME, rgba } from './theme.js';

const rand = (a, b) => a + Math.random() * (b - a);

export class Backdrop {
  constructor() {
    this.t = 0;
    this.stars = Array.from({ length: 150 }, () => ({ x: Math.random(), y: Math.random(), z: rand(0.25, 1), ph: rand(0, 6.28) }));
    this.shapes = Array.from({ length: 16 }, () => this.newShape(true));
    this.shoot = null; this.shootIn = rand(3, 7);
    this.bars = new Float32Array(56);
    this.barsOn = true; this.barsA = 1;
    this.ridges = [this.makeRidge(0.55, 7), this.makeRidge(0.35, 11), this.makeRidge(0.2, 17)];
  }

  newShape(anywhere) {
    const kinds = ['plus', 'tri', 'ring', 'square', 'dot'];
    const cols = ['player', 'tap', 'hold', 'soft'];
    return {
      kind: kinds[Math.floor(Math.random() * kinds.length)],
      col: cols[Math.floor(Math.random() * cols.length)],
      x: Math.random(), y: anywhere ? Math.random() * 0.7 : 0.75,
      size: rand(5, 13), rot: rand(0, 6.28), vr: rand(-0.6, 0.6),
      vy: rand(0.008, 0.02), a: rand(0.12, 0.3),
    };
  }

  // jagged ridge line, values 0..1 = height
  makeRidge(height, segs) {
    const pts = [];
    for (let i = 0; i <= segs; i++) pts.push(height * rand(0.35, 1));
    // a little extra roughness between peaks
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      out.push(pts[i]);
      out.push((pts[i] + pts[i + 1]) / 2 + rand(-0.06, 0.06) * height);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  update(dt, pulse, bands) {
    this.t += dt;
    this.barsA += ((this.barsOn ? 1 : 0) - this.barsA) * Math.min(1, dt * 6);
    for (const s of this.stars) { s.y += dt * 0.004 * s.z; if (s.y > 1) { s.y = 0; s.x = Math.random(); } }
    for (let i = 0; i < this.shapes.length; i++) {
      const s = this.shapes[i];
      s.y -= s.vy * dt; s.rot += s.vr * dt;
      if (s.y < -0.05) this.shapes[i] = this.newShape(false);
    }
    this.shootIn -= dt;
    if (this.shootIn <= 0) {
      this.shoot = { x: rand(0.1, 0.9), y: rand(0.05, 0.3), life: 0.9 };
      this.shootIn = rand(5, 12);
    }
    if (this.shoot) { this.shoot.life -= dt; this.shoot.x += dt * 0.45; this.shoot.y += dt * 0.12; if (this.shoot.life <= 0) this.shoot = null; }

    const n = this.bars.length;
    for (let i = 0; i < n; i++) {
      let v;
      if (bands) v = bands[Math.min(bands.length - 1, Math.floor(Math.pow(i / n, 1.6) * bands.length))] || 0;
      else v = (0.25 + 0.75 * Math.abs(Math.sin(this.t * 1.3 + i * 0.7) * Math.sin(this.t * 0.7 + i * 0.23))) * (0.35 + pulse * 0.65) * 0.6;
      this.bars[i] = v > this.bars[i] ? v : Math.max(v, this.bars[i] - dt * 1.6);
    }
  }

  draw(g, W, H, s, trackY, playerX, pulse, bgImage) {
    // sky
    const sky = g.createLinearGradient(0, 0, 0, trackY);
    sky.addColorStop(0, THEME.background); sky.addColorStop(1, THEME.background2);
    g.fillStyle = sky; g.fillRect(0, 0, W, trackY + 1);

    if (bgImage && bgImage.complete && bgImage.naturalWidth) {
      const sc = Math.max(W / bgImage.naturalWidth, H / bgImage.naturalHeight);
      const iw = bgImage.naturalWidth * sc, ih = bgImage.naturalHeight * sc;
      g.globalAlpha = 0.55;
      g.drawImage(bgImage, (W - iw) / 2 - (playerX - 0.5) * 20 * s, (H - ih) / 2, iw, ih);
      g.globalAlpha = 1;
    }

    // stars
    for (const st of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(this.t * (1 + st.z * 2) + st.ph);
      g.globalAlpha = (0.15 + tw * 0.55) * st.z;
      g.fillStyle = THEME.text;
      const x = st.x * W - (playerX - 0.5) * 30 * st.z * s, y = st.y * trackY;
      const r = st.z > 0.85 ? 1.6 * s : 1 * s;
      g.fillRect(x, y, r, r);
    }
    g.globalAlpha = 1;

    // shooting star
    if (this.shoot) {
      const sh = this.shoot, x = sh.x * W, y = sh.y * trackY;
      const tail = g.createLinearGradient(x, y, x - 90 * s, y - 24 * s);
      tail.addColorStop(0, rgba(THEME.text, 0.8 * Math.min(1, sh.life * 2))); tail.addColorStop(1, rgba(THEME.text, 0));
      g.strokeStyle = tail; g.lineWidth = 1.5 * s;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - 90 * s, y - 24 * s); g.stroke();
    }

    // slow dashed rings, centred on the track
    const cx = W / 2, cy = trackY;
    const rings = [[0.42, 1, [3, 10]], [0.68, -0.6, [18, 14]], [0.98, 0.35, [2, 22]]];
    g.lineWidth = 1.2 * s;
    for (const [rf, dir, dash] of rings) {
      const r = Math.max(W, H) * rf * (1 + pulse * 0.012);
      g.save();
      g.translate(cx, cy); g.rotate(this.t * 0.05 * dir);
      g.setLineDash(dash.map(d => d * s));
      g.strokeStyle = rgba(THEME.accent, 0.1 + pulse * 0.06);
      g.beginPath(); g.arc(0, 0, r, Math.PI, Math.PI * 2); g.stroke();
      g.restore();
    }
    g.setLineDash([]);

    // drifting shapes
    for (const sh of this.shapes) {
      const x = sh.x * W - (playerX - 0.5) * 50 * s, y = sh.y * H, z = sh.size * s;
      if (y > trackY - 10) continue;
      g.save();
      g.translate(x, y); g.rotate(sh.rot);
      g.globalAlpha = sh.a;
      g.strokeStyle = g.fillStyle = THEME[sh.col];
      g.lineWidth = 2 * s; g.lineCap = 'round';
      g.beginPath();
      if (sh.kind === 'plus') { g.moveTo(-z, 0); g.lineTo(z, 0); g.moveTo(0, -z); g.lineTo(0, z); g.stroke(); }
      else if (sh.kind === 'tri') { g.moveTo(0, -z); g.lineTo(z * 0.9, z * 0.6); g.lineTo(-z * 0.9, z * 0.6); g.closePath(); g.stroke(); }
      else if (sh.kind === 'ring') { g.arc(0, 0, z * 0.8, 0, Math.PI * 2); g.stroke(); }
      else if (sh.kind === 'square') { g.strokeRect(-z * 0.7, -z * 0.7, z * 1.4, z * 1.4); }
      else { g.arc(0, 0, z * 0.35, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    g.globalAlpha = 1;

    // hills behind the track, back to front
    const shades = [0.55, 0.8, 1];
    this.ridges.forEach((ridge, li) => {
      const par = (li + 1) * 18 * s;
      const off = -(playerX - 0.5) * par;
      const hMax = 150 * s;
      g.fillStyle = rgba(THEME.ridge, shades[li] * 0.9);
      g.beginPath(); g.moveTo(-40, trackY);
      for (let i = 0; i < ridge.length; i++) {
        const x = -40 + (W + 80) * (i / (ridge.length - 1)) + off;
        g.lineTo(x, trackY - ridge[i] * hMax * (1 - li * 0.15));
      }
      g.lineTo(W + 40, trackY); g.closePath(); g.fill();
    });

    // ground
    g.fillStyle = THEME.ground;
    g.fillRect(0, trackY, W, H - trackY);
    // faint lines on the ground, spreading from the centre
    g.strokeStyle = rgba(THEME.accent, 0.08); g.lineWidth = 1;
    for (let i = -8; i <= 8; i++) {
      g.beginPath(); g.moveTo(W / 2 + i * 40 * s, trackY); g.lineTo(W / 2 + i * 160 * s, H); g.stroke();
    }

    // bars that move with the music, standing on the ground
    const n = this.bars.length, bw = W / n;
    for (let i = 0; i < n && this.barsA > 0.01; i++) {
      const h = this.bars[i] * (H - trackY) * 0.42 * this.barsA;
      if (h < 1) continue;
      g.fillStyle = rgba(i % 7 === 3 ? THEME.player : THEME.accent, 0.12 + this.bars[i] * 0.16);
      g.fillRect(i * bw + bw * 0.22, H - h, bw * 0.56, h);
    }
  }
}
