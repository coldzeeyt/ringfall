// Player settings, input bindings and best scores, saved in this browser.
const KEY = 'ringfall.settings.v2';

// A binding is one physical input:
//   { type: 'key', code: 'Space' }        keyboard (KeyboardEvent.code)
//   { type: 'mouse', button: 0 }           mouse / pen barrel buttons (0 left, 1 middle, 2 right, 3/4 side)
//   { type: 'pad', button: 0 }             gamepad button (standard mapping)
export const DEFAULT_BINDINGS = {
  hit: [{ type: 'key', code: 'Space' }, { type: 'key', code: 'KeyZ' }, { type: 'key', code: 'KeyX' }, { type: 'pad', button: 0 }],
  left: [{ type: 'key', code: 'ArrowLeft' }, { type: 'key', code: 'KeyA' }, { type: 'pad', button: 14 }],
  right: [{ type: 'key', code: 'ArrowRight' }, { type: 'key', code: 'KeyD' }, { type: 'pad', button: 15 }],
};

const defaults = {
  bindings: structuredClone(DEFAULT_BINDINGS),
  penTipHits: true,     // drawing pad: touching the tablet = hit, hovering = move
  difficulty: 'normal', // easy | normal | hard
  pixelFound: false,    // secret: found the 8-bit mode
  pixel: false,
  volume: 0.8,
  speed: 1.0,
  offsetMs: 0,
  hitSounds: true,
  best: {},
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw) {
      // carry over a hit key from the first version
      const v1 = JSON.parse(localStorage.getItem('ringfall.settings.v1') || 'null');
      const s = structuredClone(defaults);
      if (v1) {
        Object.assign(s, { volume: v1.volume ?? s.volume, speed: v1.speed ?? s.speed, offsetMs: v1.offsetMs ?? 0, best: v1.best || {} });
        if (v1.hitCode && v1.hitCode !== 'Space') s.bindings.hit.unshift({ type: 'key', code: v1.hitCode });
      }
      return s;
    }
    return { ...structuredClone(defaults), ...raw, bindings: { ...structuredClone(DEFAULT_BINDINGS), ...(raw.bindings || {}) } };
  } catch {
    return structuredClone(defaults);
  }
}

export const settings = load();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'Home'];
const MOUSE_NAMES = ['Left click', 'Middle click', 'Right click', 'Mouse 4', 'Mouse 5'];

export function keyLabel(code) {
  if (!code) return '?';
  const named = {
    Space: 'Space', Enter: 'Enter', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Tab: 'Tab', CapsLock: 'Caps',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export function bindingLabel(b) {
  if (b.type === 'key') return keyLabel(b.code);
  if (b.type === 'mouse') return MOUSE_NAMES[b.button] || 'Mouse ' + (b.button + 1);
  if (b.type === 'pad') return 'Pad ' + (PAD_NAMES[b.button] || b.button);
  return '?';
}

export function sameBinding(a, b) {
  return a.type === b.type && a.code === b.code && a.button === b.button;
}

export function primaryHitLabel() {
  const k = settings.bindings.hit.find(b => b.type === 'key') || settings.bindings.hit[0];
  return k ? bindingLabel(k) : 'Pen tip';
}
