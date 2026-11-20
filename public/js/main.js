import { settings, save, bindingLabel, primaryHitLabel, sameBinding, DEFAULT_BINDINGS } from './settings.js';
import { AudioEngine } from './audio.js';
import { LEVELS, levelDuration, loadRemoteLevels, levelKey } from './levels.js';
import { generateChart } from './chartgen.js';
const { Game, DIFFICULTY } = await import(settings.pixel ? './game.js' : './game-classic.js');
import { Input } from './input.js';
import * as Mods from './mods.js';
import { Editor } from './editor.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const audio = new AudioEngine();
let screen = 'menu';
let currentLevel = null;
let levelPage = 0;
let playtesting = false;
const bufferCache = new Map();

// ---------------- HUD ----------------
const hud = $('hud'), scoreEl = $('score'), comboEl = $('combo'), comboBox = comboEl.parentElement;
const fmt = n => Math.round(n).toLocaleString('en-US');

const game = new Game($('stage'), audio, {
  onScore: s => { scoreEl.textContent = fmt(s); },
  onCombo: (c, bump) => {
    comboEl.textContent = c;
    if (bump && c > 0) { comboBox.classList.remove('bump'); void comboBox.offsetWidth; comboBox.classList.add('bump'); }
  },
  onProgress: p => { $('progressFill').style.width = (p * 100).toFixed(2) + '%'; },
  onHealth: (hp, noFail) => {
    $('hp').classList.toggle('off', noFail);
    $('hp').classList.toggle('low', hp < 0.3);
    $('hpFill').style.width = (hp * 100).toFixed(1) + '%';
  },
  onFinish: stats => setTimeout(() => playtesting ? endPlaytest(stats) : showResults(stats), 700),
  onPortalHover: p => { hoveredPortal = p; if (screen === 'levels') updateLevelCard(p); },
  onPortalSelect: p => {
    if (p.id === 'play') { levelPage = 0; show('levels'); }
    else if (p.id === 'settings') show('settings');
    else if (p.id === 'howto') show('howto');
    else if (p.id === 'waterfall') show('waterfall');
    else if (p.id === 'create') show('editor');
    else if (p.id === 'back') { if (levelPage > 0) { levelPage--; show('levels'); } else show('menu'); }
    else if (p.id === 'more') { levelPage++; show('levels'); }
    else if (p.level) startLevel(p.level);
  },
});

const input = new Input($('stage'), {
  action: (name, down, id) => {
    if (name === 'hit' && down) {
      if (screen === 'pause') return resume();
      if (screen === 'results') return restart();
    }
    if (screen === 'play' || screen === 'menu' || screen === 'levels') game.action(name, down, id);
    else if (!down) game.action(name, false, id);
  },
  key: e => {
    if (e.code === 'Tab' && screen === 'levels') { e.preventDefault(); cycleDifficulty(); return; }
    if (e.code !== 'Escape') return;
    if (screen === 'editor') return;
    if (screen === 'play' && playtesting) { game.quit(); endPlaytest(null); return; }
    if (screen === 'play') pause();
    else if (screen === 'pause') resume();
    else if (screen === 'levels') { levelPage = 0; show('menu'); }
    else if (['settings', 'howto', 'waterfall'].includes(screen)) show('menu');
    else if (screen === 'results') show('levels');
  },
  pointerMove: e => game.pointerMove(e),
  menuClick: () => game.menuClick(),
});

(function padLoop() { input.pollPads(); game.stick = input.stick; requestAnimationFrame(padLoop); })();

// ---------------- screens ----------------
const MENU_PORTALS = [
  { id: 'settings', x: 0.07, label: 'Settings' },
  { id: 'play', x: 0.3, label: 'Play', big: true },
  { id: 'create', x: 0.52, label: 'Create', sub: 'editor' },
  { id: 'waterfall', x: 0.74, label: 'Waterfall', sub: 'mods' },
  { id: 'howto', x: 0.94, label: 'How to' },
];

// ---------------- editor ----------------
const editor = new Editor(audio, {
  exit: () => show('menu'),
  online: () => Mods.waterfallOnline(),
  playtest: (level, buffer, duration, from) => {
    playtesting = true; currentLevel = level;
    show('play');
    $('progressFill').style.width = '0%';
    game.start(level, buffer, duration, { from, noFail: true });
  },
});

function endPlaytest(st) {
  playtesting = false;
  game.quit();
  // wait a tick so the key that ended the playtest doesn't also reach the editor
  setTimeout(() => show('editor'), 0);
  if (st) {
    const judged = st.perfect + st.good + st.miss;
    const acc = judged ? (st.perfect + st.good * 0.6) / judged : 0;
    editor.status(`Playtest: ${(acc * 100).toFixed(1)}% · ${st.perfect} perfect · ${st.good} good · ${st.miss} miss · best combo ${st.maxCombo}`);
  }
}

function allLevels() { return [...LEVELS, ...Mods.modLevels()]; }

function levelPortals() {
  const all = allLevels();
  const perPage = 3;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  levelPage = Math.min(levelPage, pages - 1);
  const slice = all.slice(levelPage * perPage, levelPage * perPage + perPage);
  const xs = [0.32, 0.54, 0.76];
  const list = [{ id: 'back', x: 0.08, label: levelPage ? '‹' : 'Back', big: !!levelPage }];
  slice.forEach((lv, i) => list.push({
    id: 'level' + lv.slot, x: xs[i], label: String(lv.slot), big: true,
    sub: lv.modName ? 'mod' : '', locked: !!lv.locked, level: lv,
  }));
  if (levelPage < pages - 1) list.push({ id: 'more', x: 0.94, label: '›', big: true, sub: 'mods' });
  return list;
}

function show(name) {
  screen = name;
  document.querySelectorAll('.screen').forEach(el => el.classList.toggle('active', el.id === 'screen-' + name));
  const inWorld = name === 'menu' || name === 'levels';
  const playing = name === 'play';
  hud.classList.toggle('show', playing || name === 'pause');
  document.body.classList.toggle('playing', playing);
  game.inputLocked = !(inWorld || playing);
  if (name === 'menu') game.setPortals(MENU_PORTALS, 'menu');
  if (name === 'levels') { game.setPortals(levelPortals(), 'levels'); updateLevelCard(null); }
  if (name === 'settings') syncSettingsUI();
  if (name === 'waterfall') openWaterfall();
  if (name === 'editor') editor.open();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { if (screen === 'results') game.quit(); show(go.dataset.go); }
});

// ---------------- level card ----------------
function fmtTime(sec) {
  if (!sec) return null;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateLevelCard(p) {
  const card = $('levelCard');
  const lv = p && p.level;
  if (!lv) { card.classList.add('hide'); return; }
  card.classList.remove('hide');
  card.classList.toggle('locked', !!lv.locked);
  $('lcNum').textContent = lv.slot;
  $('lcTitle').textContent = lv.locked ? 'Coming soon' : lv.title;
  const meta = [];
  if (!lv.locked) {
    if (lv.modName) meta.push('from ' + lv.modName);
    else if (lv.artist) meta.push(lv.artist);
    meta.push(lv.bpm + ' BPM');
    const d = fmtTime(levelDuration(lv) || bufferCache.get(lv.music)?.duration);
    if (d) meta.push(d);
  }
  $('lcMeta').textContent = meta.join(' · ');
  if (!lv.locked) {
    const d = DIFFICULTY[settings.difficulty];
    $('lcTitle').insertAdjacentHTML('beforeend', `<span class="lc-diff ${settings.difficulty}">${d.label}</span>`);
  }
  const best = settings.best[bestKey(lv)];
  $('lcGrade').textContent = best ? best.grade : '';
  $('lcScore').textContent = best ? fmt(best.score) : '';
}

// ---------------- playing ----------------
async function startLevel(level) {
  if (level.locked) return;
  currentLevel = level;
  let buffer = null, duration = levelDuration(level);
  if (level.music) {
    show('loading');
    $('loadingText').textContent = 'Loading ' + level.title;
    try {
      buffer = bufferCache.get(level.music);
      if (!buffer) { buffer = await audio.loadBuffer(level.music); bufferCache.set(level.music, buffer); }
    } catch (err) {
      $('loadingText').textContent = 'That song could not be loaded';
      setTimeout(() => show('levels'), 1600);
      return;
    }
    if (!level.notes) {
      level.notes = generateChart(buffer, { bpm: level.bpm, offset: level.offset, density: level.density, seed: level.title });
    }
    duration = buffer.duration;
  }
  show('play');
  $('progressFill').style.width = '0%';
  game.start(level, buffer, duration);
}

function pause() {
  if (screen !== 'play') return;
  if (playtesting) { game.quit(); endPlaytest(null); return; }
  game.pause(); show('pause');
}
function resume() { show('play'); game.resume(); }
function restart() { game.quit(); startLevel(currentLevel); }
function quit() { game.quit(); show('levels'); }

$('pauseBtn').addEventListener('click', pause);
$('resumeBtn').addEventListener('click', resume);
$('restartBtn').addEventListener('click', restart);
$('quitBtn').addEventListener('click', quit);
$('retryBtn').addEventListener('click', restart);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

const bestKey = lv => levelKey(lv) + ':' + settings.difficulty;
let hoveredPortal = null;

function cycleDifficulty() {
  const order = ['easy', 'normal', 'hard'];
  settings.difficulty = order[(order.indexOf(settings.difficulty) + 1) % 3];
  save(); syncDifficulty();
  updateLevelCard(hoveredPortal);
  audio.ensure(); audio.hitSound('good');
}

function syncDifficulty() {
  $('diffHint').textContent = DIFFICULTY[settings.difficulty].label;
  document.querySelectorAll('[data-diff]').forEach(b => b.classList.toggle('on', b.dataset.diff === settings.difficulty));
}
document.querySelectorAll('[data-diff]').forEach(b => b.addEventListener('click', () => { settings.difficulty = b.dataset.diff; save(); syncDifficulty(); }));

function grade(acc, miss) {
  if (acc >= 0.97 && miss === 0) return 'S';
  if (acc >= 0.93) return 'A';
  if (acc >= 0.85) return 'B';
  if (acc >= 0.72) return 'C';
  return 'D';
}

function showResults(st) {
  const judged = st.perfect + st.good + st.miss;
  const acc = judged ? (st.perfect + st.good * 0.6) / judged : 0;
  const g = st.failed ? 'F' : grade(acc, st.miss);
  const key = bestKey(currentLevel);
  const prev = settings.best[key];
  const isBest = !st.failed && (!prev || st.score > prev.score);
  if (isBest) { settings.best[key] = { score: Math.round(st.score), grade: g, acc }; save(); }
  $('failed').classList.toggle('show', !!st.failed);
  $('grade').textContent = g;
  $('resTitle').textContent = `${currentLevel.title} · ${DIFFICULTY[settings.difficulty].label}`;
  $('resScore').textContent = fmt(st.score);
  $('newBest').classList.toggle('show', isBest && st.score > 0);
  $('resAcc').textContent = (acc * 100).toFixed(1) + '%';
  $('resCombo').textContent = st.maxCombo;
  $('resPerfect').textContent = st.perfect;
  $('resGood').textContent = st.good;
  $('resMiss').textContent = st.miss;
  show('results');
}

// ---------------- settings ----------------
function refreshKeyLabels() {
  const label = primaryHitLabel();
  $('keyPill').textContent = 'Hit: ' + label;
  document.querySelectorAll('[data-keylabel]').forEach(el => { el.textContent = label; });
}

function renderBinds() {
  document.querySelectorAll('.bind-row').forEach(row => {
    const action = row.dataset.action;
    const list = settings.bindings[action];
    const box = row.querySelector('.binds');
    box.innerHTML = list.map((b, i) =>
      `<span class="bind">${esc(bindingLabel(b))}<button data-remove="${i}" aria-label="Remove">×</button></span>`
    ).join('') + `<button class="bind add" data-add>+ Add</button>`;
    box.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => {
      list.splice(Number(btn.dataset.remove), 1); save(); renderBinds(); refreshKeyLabels();
    }));
    box.querySelector('[data-add]').addEventListener('click', e => {
      const btn = e.currentTarget;
      btn.textContent = 'Press anything'; btn.classList.add('listening');
      input.startCapture(b => {
        if (b && !list.some(x => sameBinding(x, b))) {
          // one input does one job
          for (const a of ['hit', 'left', 'right']) settings.bindings[a] = settings.bindings[a].filter(x => !sameBinding(x, b));
          settings.bindings[action].push(b);
          save();
        }
        renderBinds(); refreshKeyLabels();
      });
    });
  });
}

function setSliderFill(inp) {
  const p = (inp.value - inp.min) / (inp.max - inp.min) * 100;
  inp.style.setProperty('--p', p + '%');
}

function syncSettingsUI() {
  const v = $('volume'), sp = $('speed'), of = $('offset');
  v.value = settings.volume; sp.value = settings.speed; of.value = settings.offsetMs;
  $('volumeOut').textContent = Math.round(settings.volume * 100) + '%';
  $('speedOut').textContent = Number(settings.speed).toFixed(1) + '×';
  $('offsetOut').textContent = (settings.offsetMs > 0 ? '+' : '') + settings.offsetMs + ' ms';
  [v, sp, of].forEach(setSliderFill);
  $('hitsoundBtn').classList.toggle('on', settings.hitSounds);
  $('penBtn').classList.toggle('on', settings.penTipHits);
  renderBinds();
  refreshKeyLabels();
}

$('volume').addEventListener('input', e => { settings.volume = Number(e.target.value); audio.setVolume(settings.volume); save(); syncSettingsUI(); });
$('speed').addEventListener('input', e => { settings.speed = Number(e.target.value); save(); syncSettingsUI(); });
$('offset').addEventListener('input', e => { settings.offsetMs = Number(e.target.value); save(); syncSettingsUI(); });
$('hitsoundBtn').addEventListener('click', () => { settings.hitSounds = !settings.hitSounds; save(); syncSettingsUI(); });
// ---- secret: 8-bit mode. Konami code on the main menu, or click the logo 8 times ----
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','KeyB','KeyA'];
let konami = 0, logoClicks = 0, logoTimer = 0;
function togglePixel() {
  settings.pixelFound = true; settings.pixel = !settings.pixel; save();
  document.body.classList.add('glitch');
  setTimeout(() => location.reload(), 450);
}
addEventListener('keydown', e => {
  if (!$('screen-menu').classList.contains('active')) { konami = 0; return; }
  konami = e.code === KONAMI[konami] ? konami + 1 : (e.code === KONAMI[0] ? 1 : 0);
  if (konami === KONAMI.length) { konami = 0; togglePixel(); }
}, true);
document.querySelector('#screen-menu .logo').addEventListener('click', () => {
  clearTimeout(logoTimer); logoTimer = setTimeout(() => logoClicks = 0, 1500);
  if (++logoClicks >= 8) { logoClicks = 0; togglePixel(); }
});
$('pixelRow').hidden = !settings.pixelFound;
$('pixelBtn').classList.toggle('on', settings.pixel);
$('pixelBtn').addEventListener('click', togglePixel);

$('penBtn').addEventListener('click', () => { settings.penTipHits = !settings.penTipHits; save(); syncSettingsUI(); });
$('resetBindsBtn').addEventListener('click', () => { settings.bindings = structuredClone(DEFAULT_BINDINGS); save(); syncSettingsUI(); });

let resetArmed = null;
$('resetBtn').addEventListener('click', e => {
  const b = e.currentTarget;
  if (!resetArmed) {
    b.textContent = 'Sure?'; b.classList.add('armed');
    resetArmed = setTimeout(() => { resetArmed = null; b.textContent = 'Reset'; b.classList.remove('armed'); }, 2500);
    return;
  }
  clearTimeout(resetArmed); resetArmed = null;
  settings.best = {}; save();
  b.textContent = 'Cleared'; b.classList.remove('armed');
  setTimeout(() => { b.textContent = 'Reset'; }, 1500);
});

// ---------------- Waterfall ----------------
let wfTab = 'browse', catalog = null, wfQuery = '';

function modThumb(m) {
  const img = m.thumb || (m.sprites && (m.sprites.background || m.sprites.player));
  if (img) return `<img src="${esc(img)}" alt="">`;
  const t = m.theme || {};
  const cols = [t.background2 || '#26215C', t.player || '#ED93B1', t.tap || '#FAC775', t.hold || '#5DCAA5'];
  return `<div class="sw">${cols.map(c => `<i style="background:${esc(c)}"></i>`).join('')}</div>`;
}

const modTags = m => (m.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');

function renderWaterfall() {
  const list = $('wfList');
  document.querySelectorAll('.wf-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === wfTab));
  const q = wfQuery.trim().toLowerCase();
  const match = m => !q || `${m.name} ${m.author} ${m.description}`.toLowerCase().includes(q);

  if (wfTab === 'installed') {
    const mods = Mods.installed.filter(match);
    if (!mods.length) { list.innerHTML = `<div class="wf-empty">No mods installed yet. Find some in Browse.</div>`; return; }
    list.innerHTML = mods.map(m => `
      <div class="mod">
        <div class="mod-thumb">${modThumb(m)}</div>
        <div><div class="mod-name">${esc(m.name)}</div><div class="mod-by">by ${esc(m.author || 'someone')}</div><div class="mod-tags">${modTags(m)}</div></div>
        <div class="mod-act">
          <button class="toggle ${m.enabled ? 'on' : ''}" data-toggle="${esc(m.id)}" role="switch" aria-label="On"><i></i></button>
          <button class="chip danger" data-remove-mod="${esc(m.id)}">Remove</button>
        </div>
      </div>`).join('');
    return;
  }
  if (catalog === 'offline') {
    list.innerHTML = `<div class="wf-empty">Waterfall mods live on the online version of Ringfall.<br><a href="${esc(Mods.WATERFALL_HOME)}" target="_blank" rel="noopener">Open Ringfall online</a></div>`;
    return;
  }
  if (!catalog) { list.innerHTML = `<div class="wf-empty"><div class="spinner" style="margin:0 auto"></div></div>`; return; }
  const mods = catalog.filter(match);
  if (!mods.length) { list.innerHTML = `<div class="wf-empty">${q ? 'Nothing matches that.' : 'No mods yet. Be the first:'} <a href="waterfall" target="_blank" rel="noopener">make one</a></div>`; return; }
  list.innerHTML = mods.map(m => {
    const has = Mods.isInstalled(m.id);
    return `
    <div class="mod">
      <div class="mod-thumb">${modThumb(m)}</div>
      <div>
        <div class="mod-name">${esc(m.name)}</div>
        <div class="mod-by">by ${esc(m.author || 'someone')} · ${m.downloads || 0} download${m.downloads === 1 ? "" : "s"}</div>
        ${m.description ? `<div class="mod-desc">${esc(m.description)}</div>` : ''}
        <div class="mod-tags">${modTags(m)}</div>
      </div>
      <div class="mod-act">
        <button class="chip ${has ? 'done' : 'install'}" data-install="${esc(m.id)}">${has ? 'Installed' : 'Get'}</button>
      </div>
    </div>`;
  }).join('');
}

async function openWaterfall() {
  renderWaterfall();
  if (!(await Mods.waterfallOnline())) {
    catalog = 'offline';
    $('makeModLink').href = Mods.WATERFALL_HOME + '/waterfall';
    renderWaterfall();
    return;
  }
  try { catalog = await Mods.fetchCatalog(); } catch { catalog = []; }
  renderWaterfall();
}

$('wfList').addEventListener('click', async e => {
  const inst = e.target.closest('[data-install]');
  const tog = e.target.closest('[data-toggle]');
  const rem = e.target.closest('[data-remove-mod]');
  if (inst && !Mods.isInstalled(inst.dataset.install)) {
    inst.textContent = 'Getting…';
    try { await Mods.install(inst.dataset.install); await Mods.applyMods(game, audio); }
    catch { inst.textContent = 'Failed'; return; }
    const m = Array.isArray(catalog) && catalog.find(x => x.id === inst.dataset.install);
    if (m) m.downloads = (m.downloads || 0) + 1;
    renderWaterfall();
  } else if (tog) {
    const m = Mods.installed.find(x => x.id === tog.dataset.toggle);
    Mods.setEnabled(m.id, !m.enabled); await Mods.applyMods(game, audio); renderWaterfall();
  } else if (rem) {
    Mods.uninstall(rem.dataset.removeMod); await Mods.applyMods(game, audio); renderWaterfall();
  }
});
document.querySelectorAll('.wf-tab').forEach(t => t.addEventListener('click', () => { wfTab = t.dataset.tab; renderWaterfall(); }));
$('wfSearch').addEventListener('input', e => { wfQuery = e.target.value; renderWaterfall(); });

// ---------------- boot ----------------
window.ringfall = { game, audio, editor };
refreshKeyLabels();
syncDifficulty();
show('menu');
Mods.applyMods(game, audio);
loadRemoteLevels().then(changed => { if (changed && screen === 'levels') show('levels'); });
