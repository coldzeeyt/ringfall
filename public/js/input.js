// All inputs in one place: keyboard, mouse buttons, drawing pad pen, touch, gamepad.
// Anything can be bound to "hit", "left" or "right" in Settings.
import { settings, sameBinding } from './settings.js';

const MOUSE_BITS = [1, 4, 2, 8, 16]; // event.button -> event.buttons bit

export class Input {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers; // { action(name, down, id), key(e), pointerMove(e), menuClick(e) }
    this.mouseButtons = 0;
    this.padPrev = new Map();
    this.capture = null;
    this.stick = 0;

    addEventListener('keydown', e => this.onKey(e, true));
    addEventListener('keyup', e => this.onKey(e, false));
    addEventListener('pointerdown', e => this.onPointer(e, 'down'));
    addEventListener('pointermove', e => this.onPointer(e, 'move'));
    addEventListener('pointerup', e => this.onPointer(e, 'up'));
    addEventListener('pointercancel', e => this.onPointer(e, 'up'));
    addEventListener('contextmenu', e => { if (e.target === canvas || this.capture) e.preventDefault(); });
    addEventListener('blur', () => this.releaseAll());
  }

  actionsFor(b) {
    return ['hit', 'left', 'right'].filter(a => settings.bindings[a].some(x => sameBinding(x, b)));
  }

  // Wait for the next input of any kind and hand it to cb (null = cancelled with Esc).
  startCapture(cb) {
    this.capture = { cb, armedAt: performance.now() + 200 };
  }
  finishCapture(b) {
    const c = this.capture; this.capture = null;
    c.cb(b);
  }

  fire(b, down, id, e) {
    const acts = this.actionsFor(b);
    for (const a of acts) this.h.action(a, down, id, e);
    return acts.length > 0;
  }

  onKey(e, down) {
    if (this.capture) {
      if (!down) return;
      e.preventDefault();
      return this.finishCapture(e.code === 'Escape' ? null : { type: 'key', code: e.code });
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' && t.type !== 'range' || t.tagName === 'TEXTAREA')) return;
    if (down && e.repeat) { if (this.actionsFor({ type: 'key', code: e.code }).length) e.preventDefault(); return; }
    const used = this.fire({ type: 'key', code: e.code }, down, 'k:' + e.code, e);
    if (used) e.preventDefault();
    if (down && !used) this.h.key(e);
  }

  onPointer(e, phase) {
    if (phase === 'move' || phase === 'down') this.h.pointerMove(e);
    const onCanvas = e.target === this.canvas;

    if (e.pointerType === 'mouse') {
      const prev = this.mouseButtons, now = e.buttons;
      this.mouseButtons = now;
      MOUSE_BITS.forEach((bit, button) => {
        const was = prev & bit, is = now & bit;
        if (was === is) return;
        if (is && this.capture) {
          if (performance.now() < this.capture.armedAt) return;
          e.preventDefault();
          return this.finishCapture({ type: 'mouse', button });
        }
        if (is && !onCanvas) return;
        const used = this.fire({ type: 'mouse', button }, !!is, 'm:' + button, e);
        if (is && !used && button === 0) this.h.menuClick(e);
      });
      return;
    }

    if (e.pointerType === 'pen') {
      // tip = button 0; barrel buttons arrive as other buttons
      if (phase === 'down' && e.button !== 0) {
        if (this.capture && performance.now() >= this.capture.armedAt) return this.finishCapture({ type: 'mouse', button: e.button === 5 ? 2 : e.button });
        if (onCanvas) this.fire({ type: 'mouse', button: e.button === 5 ? 2 : e.button }, true, 'pb:' + e.button, e);
        return;
      }
      if (phase === 'up' && e.button !== 0 && e.button !== -1) {
        this.fire({ type: 'mouse', button: e.button === 5 ? 2 : e.button }, false, 'pb:' + e.button, e);
        return;
      }
      if (phase === 'down' && onCanvas) {
        if (settings.penTipHits) this.h.action('hit', true, 'pen', e);
        else this.h.menuClick(e);
      } else if (phase === 'up') {
        this.h.action('hit', false, 'pen', e);
      }
      return;
    }

    // touch: finger down moves you there and hits
    if (e.pointerType === 'touch') {
      if (phase === 'down' && onCanvas) this.h.action('hit', true, 't:' + e.pointerId, e);
      if (phase === 'up') this.h.action('hit', false, 't:' + e.pointerId, e);
    }
  }

  // called every frame
  pollPads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let stick = 0;
    for (const p of pads) {
      if (!p) continue;
      const prev = this.padPrev.get(p.index) || [];
      const now = p.buttons.map(b => b.pressed || b.value > 0.5);
      now.forEach((on, button) => {
        if (on === !!prev[button]) return;
        if (on && this.capture) return this.finishCapture({ type: 'pad', button });
        const used = this.fire({ type: 'pad', button }, on, `p${p.index}:${button}`);
        if (on && !used && button === 9) this.h.key({ code: 'Escape', pad: true });
      });
      this.padPrev.set(p.index, now);
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.2) stick = ax;
    }
    this.stick = stick;
  }

  releaseAll() {
    this.mouseButtons = 0;
    this.h.action('hit', false, '*');
    this.h.action('left', false, '*');
    this.h.action('right', false, '*');
  }
}
