// Colours used by the game. Mods can override any of these.
export const DEFAULT_THEME = {
  background: '#1c1748',   // top of the sky
  background2: '#26215C',  // bottom of the sky
  ground: '#16113a',       // below the track
  ridge: '#2f2870',        // hills behind the track
  track: '#534AB7',
  accent: '#7F77DD',
  text: '#EEEDFE',
  soft: '#CECBF6',
  player: '#ED93B1',
  ring: '#EEEDFE',
  tap: '#FAC775',
  hold: '#5DCAA5',
  holdLight: '#9FE1CB',
};

export const THEME = { ...DEFAULT_THEME };

export function setTheme(overrides) {
  for (const k of Object.keys(THEME)) THEME[k] = DEFAULT_THEME[k];
  Object.assign(THEME, overrides || {});
  const css = document.documentElement.style;
  css.setProperty('--bg', THEME.background);
  css.setProperty('--bg2', THEME.background2);
  css.setProperty('--track', THEME.track);
  css.setProperty('--violet', THEME.accent);
  css.setProperty('--lav', THEME.soft);
  css.setProperty('--white', THEME.text);
  css.setProperty('--pink', THEME.player);
  css.setProperty('--yellow', THEME.tap);
  css.setProperty('--teal', THEME.hold);
  css.setProperty('--teal-lt', THEME.holdLight);
}

export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// Backgrounds a level can switch to with a trigger (sky top, sky bottom, hills, ground).
export const BG_PRESETS = {
  night:  { background: '#1c1748', background2: '#26215C', ridge: '#2f2870', ground: '#16113a' },
  sunset: { background: '#2b0f2e', background2: '#6b2a3a', ridge: '#4a1c3b', ground: '#1d0a1f' },
  dawn:   { background: '#2a2350', background2: '#7a4e7a', ridge: '#55406e', ground: '#1d1733' },
  mint:   { background: '#06231f', background2: '#0d3b33', ridge: '#12503f', ground: '#041815' },
  storm:  { background: '#101820', background2: '#24323d', ridge: '#2b3d48', ground: '#0a1015' },
  ember:  { background: '#240a08', background2: '#5a1a12', ridge: '#3d140f', ground: '#140504' },
  deep:   { background: '#05040f', background2: '#0d0b24', ridge: '#16133a', ground: '#030208' },
};
export const BG_KEYS = ['background', 'background2', 'ridge', 'ground'];

export function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = sh => Math.round(((pa >> sh) & 255) + ((((pb >> sh) & 255) - ((pa >> sh) & 255)) * t));
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}
