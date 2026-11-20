// Waterfall: browse, install and switch on mods.
// A mod is data only (colours, pictures, sounds, levels) so anyone's mod is safe to load.
import { setTheme } from './theme.js';
import { normChart } from './levels.js';

const KEY = 'ringfall.mods.v1';
export const WATERFALL_HOME = 'https://ringfall-production.up.railway.app';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export const installed = load();
function persist() { try { localStorage.setItem(KEY, JSON.stringify(installed)); } catch { } }

let online = null;
export async function waterfallOnline() {
  if (online !== null) return online;
  try {
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch('api/mods', { signal: ctrl.signal, cache: 'no-store' });
    online = r.ok && (r.headers.get('content-type') || '').includes('json');
  } catch { online = false; }
  return online;
}

export async function fetchCatalog() {
  const r = await fetch('api/mods', { cache: 'no-store' });
  if (!r.ok) throw new Error('Waterfall is unreachable');
  return (await r.json()).mods || [];
}

export function isInstalled(id) { return installed.some(m => m.id === id); }

export async function install(id) {
  const r = await fetch('api/mods/' + encodeURIComponent(id), { cache: 'no-store' });
  if (!r.ok) throw new Error('That mod could not be downloaded');
  const mod = await r.json();
  const i = installed.findIndex(m => m.id === id);
  const entry = { ...mod, enabled: true, installedAt: Date.now() };
  if (i >= 0) installed[i] = entry; else installed.push(entry);
  persist();
  fetch('api/mods/' + encodeURIComponent(id) + '/download', { method: 'POST' }).catch(() => { });
  return entry;
}

export function uninstall(id) {
  const i = installed.findIndex(m => m.id === id);
  if (i >= 0) installed.splice(i, 1);
  persist();
}

export function setEnabled(id, on) {
  const m = installed.find(m => m.id === id);
  if (m) { m.enabled = on; persist(); }
}

// Apply every switched-on mod; later ones win.
export async function applyMods(game, audio) {
  const on = installed.filter(m => m.enabled);
  let theme = {};
  const sprites = {};
  let hitsound = null;
  for (const m of on) {
    Object.assign(theme, m.theme || {});
    for (const [k, url] of Object.entries(m.sprites || {})) if (url) sprites[k] = url;
    if (m.hitsound) hitsound = m.hitsound;
  }
  setTheme(theme);
  game.setSprites(sprites);
  audio.hitBuffer = null;
  if (hitsound) { try { audio.hitBuffer = await audio.loadBuffer(hitsound); } catch { } }
}

export function modLevels() {
  const out = [];
  for (const m of installed.filter(m => m.enabled)) {
    (m.levels || []).forEach((lv, i) => {
      const chart = normChart(lv.chart);
      out.push({
        slot: out.length + 4,
        modId: m.id, modName: m.name,
        title: lv.title || m.name, artist: lv.artist || m.author || '',
        bpm: Number(lv.bpm) || 120, offset: (Number(lv.offsetMs) || 0) / 1000,
        music: lv.music, notes: chart && chart.notes.length ? chart.notes : null, triggers: chart ? chart.triggers : [],
        density: lv.density || 'normal', version: `${m.id}:${m.version || ''}:${i}`,
      });
    });
  }
  return out;
}
