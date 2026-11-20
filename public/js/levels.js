// ─────────────────────────────────────────────────────────────
//  LEVELS
//
//  Each level:
//    title, artist   shown on the level card
//    bpm             tempo of the song
//    offset          seconds from the start of the audio to beat 0
//    music           URL of an audio file, or null for the built-in beat
//    beats           length in beats (built-in beat only)
//    notes           the chart, in beats (see tap / hold below)
//                    null = generate a chart from the song automatically
//
//  Chart helpers:
//    tap(beat, x)        x = 0 (left end of track) … 1 (right end)
//    hold(beat, x, len)  len = how many beats to hold
//
//  Triggers (made in the editor), each { b, type, value, fade }:
//    flip        value true = notes rise up from below, false = back to falling
//    mirror      value true = left and right swap
//    bars        value false = hide the music bars, true = show them
//    background  value = preset name (night, sunset, dawn, mint, storm, ember, deep)
//    speed       value = note speed multiplier (0.5 … 2.5)
//
//  Songs uploaded on the /admin page override slots 1–3 on the
//  deployed site. Sprites live in js/game.js (see SPRITES).
// ─────────────────────────────────────────────────────────────

export const tap = (b, x) => ({ b, x });
export const hold = (b, x, len) => ({ b, x, len });
export const trig = (b, type, value, fade = 1) => ({ b, type, value, fade });

// A chart is either a list of notes or { notes, triggers }.
export function normChart(c) {
  if (!c) return null;
  if (Array.isArray(c)) return { notes: c, triggers: [] };
  return { notes: Array.isArray(c.notes) ? c.notes : [], triggers: Array.isArray(c.triggers) ? c.triggers : [] };
}

function testChart() {
  return [
    // warm-up: a tap every two beats
    tap(4, .5), tap(6, .35), tap(8, .5), tap(10, .65),
    tap(12, .5), tap(14, .3), tap(16, .5), tap(18, .7),
    // first holds
    hold(20, .7, 3), tap(24, .55), tap(25, .4), tap(26, .25),
    hold(28, .25, 3), tap(32, .45), tap(33, .6), tap(34, .75), tap(35, .6),
    // every beat, zig-zag
    tap(36, .5), tap(37, .7), tap(38, .5), tap(39, .3),
    hold(40, .3, 2), tap(43, .55), hold(44, .8, 3),
    tap(48, .6), tap(49, .4), tap(50, .2), tap(51, .4),
    // breakdown: long ribbons
    hold(52, .5, 4), hold(58, .25, 3), hold(62, .75, 4), tap(67, .5),
    // finale: off-beats
    tap(68, .3), tap(68.5, .4), tap(69, .5), tap(70, .7), tap(70.5, .6), tap(71, .5),
    hold(72, .5, 2), tap(75, .3), tap(75.5, .2), tap(76, .3), tap(77, .5),
    tap(78, .7), tap(78.5, .8), tap(79, .7),
    hold(80, .5, 4), tap(85, .5), tap(86, .35), tap(87, .65), tap(88, .5),
  ];
}

export const LEVELS = [
  {
    slot: 1,
    title: 'Test Level',
    artist: 'Built-in beat',
    bpm: 120,
    offset: 0,
    music: null,
    beats: 88,
    notes: testChart(),
    triggers: [
      trig(52, 'background', 'deep', 2), trig(52, 'bars', false),
      trig(66, 'background', 'sunset', 2), trig(66, 'bars', true), trig(66, 'flip', true, 1),
      trig(84, 'flip', false, 0.75), trig(84, 'background', 'night', 2),
    ],
  },
  { slot: 2, title: 'Level 2', locked: true },
  { slot: 3, title: 'Level 3', locked: true },
];

// Length in seconds for levels whose duration is known up front.
export function levelDuration(level) {
  if (level.duration) return level.duration;
  if (!level.music && level.beats) return (level.offset || 0) + (level.beats + 4) * 60 / level.bpm;
  return null;
}

// Pull uploaded songs from the server (only exists on the deployed site).
export async function loadRemoteLevels() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('api/levels', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return false;
    const data = await res.json();
    let changed = false;
    for (const slot of [1, 2, 3]) {
      const r = data[slot];
      if (!r || !r.file) continue;
      const chart = normChart(r.chart);
      LEVELS[slot - 1] = {
        slot,
        title: r.title || 'Level ' + slot,
        artist: r.artist || '',
        bpm: Number(r.bpm) || 120,
        offset: (Number(r.offsetMs) || 0) / 1000,
        music: 'music/' + encodeURIComponent(r.file),
        notes: chart && chart.notes.length ? chart.notes : null,
        triggers: chart ? chart.triggers : [],
        density: r.density || 'normal',
        version: r.updated || '',
      };
      changed = true;
    }
    return changed;
  } catch {
    return false;
  }
}

export function levelKey(level) {
  return `slot${level.slot}:${level.title}:${level.version || ''}`;
}
