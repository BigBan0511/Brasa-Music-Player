import { createEngine, BANDS } from './engine.js';
import { paletteFor, applyPalette, DEFAULT_PALETTE } from './palette.js';

const api = window.brasa;

/* ───────────── utilidades ───────────── */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num1 = v => v.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace(',0', '');
const fmtDb = v => (v > 0 ? '+' : v < 0 ? '−' : '') + num1(Math.abs(v)) + ' dB';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const coll = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const coverUrl = (t, small) => t && t.cover ? `brasa://app/cover/${t.cover}${small ? '-s' : ''}.jpg` : '';
const NOTE = '<svg class="ico"><use href="#i-note"/></svg>';
function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function fmtLong(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const plural = (n, one, many) => `${n.toLocaleString('es-ES')} ${n === 1 ? one : many}`;
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3400); }
function setArt(el, t, small = true) {
  const u = coverUrl(t, small);
  el.style.backgroundImage = u ? `url("${u}")` : '';
  el.innerHTML = u ? '' : NOTE;
}

/* ───────────── estado ───────────── */
const PRESETS = {
  'Plano': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Graves': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Voz': [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  'Acústico': [3, 2, 1, 1, 0, 1, 2, 3, 3, 2],
  'Electrónica': [5, 4, 1, 0, -2, 0, 1, 2, 4, 5],
  'Brillo': [-1, -1, 0, 0, 0, 1, 2, 4, 5, 6],
  'Nocturno': [2, 2, 1, 0, -1, -2, -3, -4, -5, -6]
};
const BAND_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const DEFAULTS = {
  volume: 0.8, fadeIn: 1.5, pauseFade: 0.6, crossfade: 5, curve: 'power', level: true, limiter: true, viz: true,
  eqOn: true, eq: PRESETS['Plano'].slice(), preamp: 0, preset: 'Plano', shuffle: false, repeat: 'all', remaining: true,
  sort: 'artist', adaptive: true, backdrop: true, onlineLyrics: true, theme: 'system'
};
const S = { ...DEFAULTS };
const tracks = new Map();
let folders = [];
let playlists = [];
let ctxDef = { type: 'library', ids: [], name: 'Biblioteca' };
let curId = null;
let pendingOffset = 0;
let loading = false;
let shuffled = [];
let lastVol = 0.8;
let libDirty = true, libCache = [];
let platform = 'win32';
let ffmpegOk = true;

function saveSettings() { clearTimeout(saveSettings.t); saveSettings.t = setTimeout(() => api.saveState({ settings: S }), 300); }
function savePlaylists() { api.saveState({ playlists }); }
function saveSession() {
  api.saveState({ session: { ctx: ctxDef.type === 'playlist' ? { type: 'playlist', id: ctxDef.id } : ctxDef, curId, pos: currentPos() } });
}
function prepTrack(t) { t._s = norm([t.title, t.artist, t.album, t.albumArtist, t.genre].join(' ')); return t; }

/* ───────────── motor ───────────── */
const engine = createEngine({
  api, S,
  gainFor: t => { const x = tracks.get(t.id) || t; return x.rg != null ? x.rg + 4 : x.lufs != null ? x.lufs : 0; },
  onEnded: () => { if (transitioning) return; const n = nextId(true); if (n) playId(n, { auto: true }); else { engine.stopAll(); pendingOffset = 0; refresh(); } },
  onError: (t, pos, converted) => {
    if (!t) return;
    const dur = engine.duration();
    // un fallo en los últimos segundos se trata como fin de la canción
    if (dur && pos > dur - 2.5) { const n = nextId(true); if (n && n !== t.id) { playId(n, { auto: true }); return; } }
    if (!converted) { playId(t.id, { offset: pos, force: true }); return; }
    if (!t._retry) { t._retry = true; setTimeout(() => { t._retry = false; }, 8000); playId(t.id, { offset: Math.max(0, Math.min(pos, dur - 3)), fade: 0.3 }); return; }
    toast(`No se pudo reproducir «${t.title}».`);
    const n = nextId(true); if (n && n !== t.id) playId(n, { auto: true });
  },
  onLoading: v => { loading = v; updateTransport(); },
  onDuration: (t, d) => { const x = tracks.get(t.id); if (x && !x.duration) { x.duration = d; api.reportDuration(t.id, d); scheduleRender(); } }
});

/* ───────────── contexto y orden ───────────── */
function contextIds() {
  if (ctxDef.type === 'playlist') {
    const pl = playlists.find(p => p.id === ctxDef.id);
    if (pl) return pl.ids.filter(id => tracks.has(id));
    ctxDef = { type: 'library', ids: libraryOrder().map(t => t.id), name: 'Biblioteca' };
  }
  const ids = ctxDef.ids.filter(id => tracks.has(id));
  return ids.length ? ids : libraryOrder().map(t => t.id);
}
function ctxName() { if (ctxDef.type === 'playlist') { const p = playlists.find(x => x.id === ctxDef.id); return p ? p.name : 'Playlist'; } return ctxDef.name || 'Biblioteca'; }
function order() {
  const ids = contextIds();
  if (!S.shuffle) return ids;
  if (shuffled.length !== ids.length || shuffled.some(id => !ids.includes(id))) reshuffle(ids);
  return shuffled;
}
function reshuffle(ids = contextIds(), first = curId) {
  const rest = ids.filter(id => id !== first);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  shuffled = first && ids.includes(first) ? [first, ...rest] : rest;
}
function nextId(auto) {
  const o = order(); if (!o.length) return null;
  if (auto && S.repeat === 'one' && curId) return curId;
  const i = o.indexOf(curId);
  if (i < 0) return o[0];
  if (i + 1 < o.length) return o[i + 1];
  if (auto && S.repeat === 'off') return null;
  return o[0];
}
function prevId() { const o = order(); if (!o.length) return null; const i = o.indexOf(curId); return o[(i - 1 + o.length) % o.length]; }
function setContext(def) { ctxDef = def; shuffled = []; }

/* ───────────── reproducción ───────────── */
let transitioning = false;
const manualCross = () => S.crossfade > 0 ? Math.min(S.crossfade, 2.5) : 0;
const currentPos = () => engine.activeReady() && engine.activeTrack() && engine.activeTrack().id === curId ? engine.position() : pendingOffset;
const curTrack = () => tracks.get(curId);

async function playId(id, o = {}) {
  const t = tracks.get(id); if (!t) return;
  const prev = curId;
  curId = id;
  if (prev !== id) { pendingOffset = 0; onTrackChanged(); }
  try {
    const ok = await engine.play(t, {
      offset: o.offset || 0, force: !!o.force,
      cross: engine.isPlaying() ? (o.cross ?? 0) : 0,
      fade: o.fade
    });
    if (ok) { pendingOffset = 0; transitioning = false; refresh(); preloadNext(); saveSession(); }
  } catch (e) {
    toast(e.message && !/media/.test(e.message) ? e.message : `No se pudo reproducir «${t.title}».`);
    transitioning = false;
    if (o.auto) {
      const failed = (o.failed || 0) + 1;
      const n = nextId(false);
      if (n && n !== id && failed < 5) playId(n, { auto: true, failed });
      else { engine.stopAll(); refresh(); }
    } else refresh();
  }
}
function togglePlay() {
  if (!tracks.size) { addFolders(); return; }
  if (loading) return;
  if (engine.isPlaying()) { engine.pause(); pendingOffset = currentPos(); refresh(); saveSession(); return; }
  const t = curTrack();
  if (t && engine.activeTrack() && engine.activeTrack().id === t.id && engine.activeReady()) { engine.resume(); refresh(); return; }
  const id = t ? t.id : order()[0];
  playId(id, { offset: pendingOffset, fade: pendingOffset > 0 ? Math.max(0.25, S.pauseFade) : null });
}
function next() {
  const id = nextId(false); if (!id) return;
  if (engine.isPlaying()) playId(id, { cross: manualCross() });
  else select(id);
}
function prev() {
  if (curTrack() && currentPos() > 3) { seek(0); return; }
  const id = prevId(); if (!id) return;
  if (engine.isPlaying()) playId(id, { cross: manualCross() });
  else select(id);
}
function select(id) { curId = id; pendingOffset = 0; onTrackChanged(); preloadNext(); saveSession(); }
function seek(sec) {
  const t = curTrack(); if (!t) return;
  if (engine.activeReady() && engine.activeTrack() && engine.activeTrack().id === curId) engine.seek(sec);
  else pendingOffset = clamp(sec, 0, Math.max(0, (t.duration || 0) - 0.05));
  lyricsFollow = 0;
}
function preloadNext() {
  const n = nextId(true); const t = n && tracks.get(n);
  if (t && n !== curId) engine.preload(t);
}
function analyzeSoon(id) {
  const t = tracks.get(id);
  if (!t || !S.level || t.rg != null || t.lufs != null || t._analyzing) return;
  t._analyzing = true;
  api.analyze(id).then(g => { t._analyzing = false; if (g != null && t.rg == null) { t.lufs = g; engine.updateTrim(id); } });
}

// transiciones automáticas (fundido cruzado o encadenado sin silencio)
setInterval(() => {
  if (!engine.isPlaying() || transitioning || loading) return;
  const t = engine.activeTrack(); if (!t || t.id !== curId) return;
  const dur = engine.duration(); if (!dur) return;
  const rem = dur - engine.position();
  const nid = nextId(true); if (!nid) return;
  const nt = tracks.get(nid);
  if (rem < S.crossfade + 15) { if (nid === curId) engine.preload(nt); else preloadNext(); analyzeSoon(nid); }
  if (S.crossfade > 0) {
    const win = Math.min(S.crossfade, dur / 2, nt.duration ? nt.duration / 2 : S.crossfade);
    if (rem <= win && engine.readyFor(nid)) { transitioning = true; playId(nid, { cross: Math.max(0.3, rem), auto: true }); }
  } else if (rem <= 0.05 && engine.readyFor(nid)) { transitioning = true; playId(nid, { cross: 0.04, auto: true }); }
}, 25);

/* ───────────── cambios de canción ───────────── */
let paletteKey = null;
function onTrackChanged() {
  const t = curTrack();
  refresh();
  updateMediaSession();
  updateLook(t);
  if (t) analyzeSoon(t.id);
  if (!np.hidden) renderNP(true);
}
function updateLook(t) {
  const small = coverUrl(t, true);
  // fondo
  setBackdrop(S.backdrop ? small : '');
  // colores
  const key = S.adaptive ? small : '';
  if (key === paletteKey) return;
  paletteKey = key;
  const go = p => { if (paletteKey === key) applyPalette(p, done => { readColors(); if (done) { syncOverlay(); drawCurve(); } }); };
  if (!key) go(DEFAULT_PALETTE); else paletteFor(key).then(go);
}
let bdTurn = 0, bdUrl = null;
function setBackdrop(url) {
  if (url === bdUrl) return;
  bdUrl = url;
  const layers = [$('#bdA'), $('#bdB')];
  const next = layers[bdTurn ^ 1], cur = layers[bdTurn];
  if (!url) { layers.forEach(l => l.classList.remove('on')); return; }
  const img = new Image();
  img.onload = () => {
    if (bdUrl !== url) return;
    next.style.backgroundImage = `url("${url}")`;
    next.classList.add('on'); cur.classList.remove('on');
    bdTurn ^= 1;
  };
  img.src = url;
}

/* ───────────── colores resueltos (canvas, barra de título) ───────────── */
const probe = $('#probe');
const colors = { a1: '#e88', a2: '#e57', ink3: '#999', ink: '#333' };
function resolve(v) { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; }
function readColors() { colors.a1 = resolve('--accent-1'); colors.a2 = resolve('--accent-2'); colors.ink3 = resolve('--ink-3'); colors.ink = resolve('--ink'); }
function toHex(color) {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 1, 1);
  const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
  return '#' + [r, gg, b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function syncOverlay() { if (platform !== 'darwin') api.setOverlay({ symbolColor: toHex(colors.ink) }); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); syncOverlay(); drawCurve(); });

/* ───────────── vistas ───────────── */
let view = 'now';
let openPlaylistId = null;
const main = $('#main');
function show(v, opts = {}) {
  view = v;
  $$('.nav-btn').forEach(b => {
    const on = b.dataset.view === v || (v === 'playlist' && b.dataset.view === 'playlists');
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  ['now', 'library', 'playlists', 'playlist', 'eq', 'settings'].forEach(k => { $('#view-' + k).hidden = k !== v; });
  if (!opts.keepScroll) main.scrollTop = 0;
  if (v === 'library') renderLibrary(true);
  if (v === 'playlists') renderPlaylists();
  if (v === 'playlist') renderPlaylist(true);
  if (v === 'eq') requestAnimationFrame(drawCurve);
  if (v === 'settings') renderSettings();
  updateMini();
}
$$('.nav-btn').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

let renderQ = false;
function scheduleRender() { if (renderQ) return; renderQ = true; requestAnimationFrame(() => { renderQ = false; refresh(); }); }
function refresh() {
  updateNow(); updateTransport(); updateMini();
  if (view === 'library') renderLibrary();
  if (view === 'playlist') renderPlaylist();
  if (view === 'playlists') renderPlaylists();
  if (!np.hidden) renderNP();
}

function greet() {
  const d = new Date(), h = d.getHours();
  const hi = h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  $('#greet').textContent = `${hi} · ${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}`;
}
const artistLine = t => t.artist || t.albumArtist || 'Artista desconocido';

function updateNow() {
  const t = curTrack();
  $('#pillTitle').textContent = t ? t.title : tracks.size ? '—' : 'Sin canciones';
  $('#pillArtist').textContent = t ? `${artistLine(t)}${t.album ? ' · ' + t.album : ''}` : 'Añade una carpeta de música';
  setArt($('#pillArt'), t);
  const n = tracks.size ? nextId(true) : null, nt = n && tracks.get(n);
  $('#nextTitle').textContent = nt ? (n === curId && S.repeat === 'one' ? 'La misma canción' : nt.title) : tracks.size ? 'Fin de la lista' : '—';
  $('#nextArtist').textContent = nt ? artistLine(nt) : '';
  setArt($('#nextArt'), nt);
  const o = order(); const i = o.indexOf(curId);
  $('#posStat').textContent = o.length ? `${Math.max(1, i + 1)} de ${o.length.toLocaleString('es-ES')}` : '0 de 0';
  $('#ctxName').textContent = tracks.size ? ctxName() : 'Biblioteca';
  const parts = [S.crossfade > 0 ? `Fundido cruzado de ${num1(S.crossfade)} s` : 'Canciones encadenadas sin silencio', S.eqOn ? `ecualizador ${S.preset.toLowerCase()}` : 'ecualizador apagado'];
  $('#foot').textContent = parts.join(' · ') + '. Toca la canción para ver su letra.';
  $('#eqDot').classList.toggle('on', S.eqOn);
  $('#eqPillText').textContent = S.eqOn ? `EQ · ${S.preset}` : 'EQ apagado';
}
function updateTransport() {
  const playing = engine.isPlaying();
  $$('[data-transport] [data-act="play"]').forEach(b => {
    b.classList.toggle('loading', loading);
    b.querySelector('use').setAttribute('href', loading ? '#i-spin' : playing ? '#i-pause' : '#i-play');
    const sp = b.querySelector('span');
    if (sp && !b.classList.contains('round')) sp.textContent = loading ? 'Cargando' : playing ? 'Pausa' : tracks.size ? 'Reproducir' : 'Añadir música';
    b.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  });
  $$('[data-act="shuffle"]').forEach(b => b.setAttribute('aria-pressed', S.shuffle));
  $$('[data-act="repeat"]').forEach(b => {
    b.setAttribute('aria-pressed', S.repeat !== 'off');
    const l = { all: 'Repetir: toda la lista', one: 'Repetir: esta canción', off: 'Repetir: desactivado' }[S.repeat];
    b.setAttribute('aria-label', l); b.title = l;
    b.querySelector('.badge').textContent = S.repeat === 'one' ? '1' : '';
  });
}
function updateMini() {
  const m = $('#mini'), t = curTrack();
  m.hidden = view === 'now' || !t;
  if (m.hidden) return;
  $('#miniTitle').textContent = t.title; $('#miniArtist').textContent = artistLine(t);
  setArt($('#miniArt'), t);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-transport] [data-act]'); if (!b) return;
  ({ play: togglePlay, next, prev, shuffle: toggleShuffle, repeat: cycleRepeat })[b.dataset.act]();
});
function toggleShuffle() { S.shuffle = !S.shuffle; if (S.shuffle) reshuffle(); saveSettings(); refresh(); preloadNext(); toast(S.shuffle ? 'Orden aleatorio' : 'Orden de la lista'); }
function cycleRepeat() { S.repeat = { all: 'one', one: 'off', off: 'all' }[S.repeat]; saveSettings(); refresh(); preloadNext(); toast({ all: 'Repetir toda la lista', one: 'Repetir esta canción', off: 'Sin repetición' }[S.repeat]); }

$('#trackPill').addEventListener('click', () => tracks.size ? openNP() : addFolders());
$('#miniOpen').addEventListener('click', openNP);
$('#eqPill').addEventListener('click', () => show('eq'));
$('#upNext').addEventListener('click', () => {
  if (ctxDef.type === 'playlist' && playlists.some(p => p.id === ctxDef.id)) { openPlaylistId = ctxDef.id; show('playlist'); }
  else show('library');
  requestAnimationFrame(() => scrollToCurrent());
});

/* volumen */
const vol = $('#vol');
function fillRange(el) { const mn = +el.min, mx = +el.max; el.style.setProperty('--p', ((+el.value - mn) / (mx - mn) * 100) + '%'); }
function setVolume(v) { S.volume = clamp(v, 0, 1); engine.setVolume(S.volume); updateVolUI(); saveSettings(); }
function updateVolUI() {
  vol.value = S.volume; fillRange(vol); $('#volOut').textContent = Math.round(S.volume * 100);
  $('#volUse').setAttribute('href', S.volume === 0 ? '#i-mute' : '#i-vol');
  $('#muteBtn').setAttribute('aria-label', S.volume === 0 ? 'Activar sonido' : 'Silenciar');
}
vol.addEventListener('input', () => setVolume(+vol.value));
function toggleMute() { if (S.volume > 0) { lastVol = S.volume; setVolume(0); } else setVolume(lastVol || 0.8); }
$('#muteBtn').addEventListener('click', toggleMute);

/* ───────────── dial y espectro ───────────── */
const dial = $('#dial'), ringProg = $('#ringProg'), ringKnob = $('#ringKnob');
const CIRC = 2 * Math.PI * 100;
let scrub = null, lastAria = -1;
function angleFrac(e) {
  const r = dial.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  let a = Math.atan2(dx, -dy); if (a < 0) a += 2 * Math.PI;
  return { frac: a / (2 * Math.PI), dist: Math.hypot(dx, dy) / (r.width / 2) };
}
const curDur = () => (engine.activeTrack() && engine.activeTrack().id === curId && engine.duration()) || (curTrack() && curTrack().duration) || 0;
dial.addEventListener('pointerdown', e => {
  if (e.target.closest('.dial-center') || !curDur()) return;
  const { frac, dist } = angleFrac(e); if (dist < 0.55) return;
  scrub = frac; dial.classList.add('scrub'); dial.setPointerCapture(e.pointerId); e.preventDefault();
});
dial.addEventListener('pointermove', e => { if (scrub != null) scrub = angleFrac(e).frac; });
dial.addEventListener('pointerup', () => { if (scrub == null) return; const f = scrub; scrub = null; dial.classList.remove('scrub'); seek(f * curDur()); });
dial.addEventListener('pointercancel', () => { scrub = null; dial.classList.remove('scrub'); });
dial.addEventListener('keydown', e => {
  const map = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 };
  if (e.key in map) { e.preventDefault(); e.stopPropagation(); seek(currentPos() + map[e.key]); }
});
$('#dialCenter').addEventListener('click', () => { S.remaining = !S.remaining; saveSettings(); });

const viz = $('#viz'), vctx = viz.getContext('2d');
const freq = new Uint8Array(engine.analyser.frequencyBinCount);
const NB = 90, vals = new Float32Array(NB);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function drawViz(active) {
  const r = viz.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = Math.round(r.width * dpr); if (viz.width !== W) { viz.width = W; viz.height = W; }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0); vctx.clearRect(0, 0, r.width, r.width);
  if (!S.viz || reduceMotion.matches) return;
  if (active) engine.analyser.getByteFrequencyData(freq);
  let any = false;
  for (let i = 0; i < NB; i++) {
    const k = i < NB / 2 ? i : NB - 1 - i;
    const f = Math.pow(k / (NB / 2), 1.7);
    const bi = Math.min(freq.length - 1, 2 + Math.floor(f * freq.length * 0.55));
    const target = active ? freq[bi] / 255 : 0;
    vals[i] = target > vals[i] ? target : vals[i] * 0.9;
    if (vals[i] > 0.01) any = true;
  }
  if (!any) return;
  const c = r.width / 2, base = (106 / 240) * (r.width / 1.3) + 7, maxL = r.width / 2 - base - 4;
  const grad = vctx.createLinearGradient(0, 0, r.width, r.width); grad.addColorStop(0, colors.a1); grad.addColorStop(1, colors.a2);
  vctx.strokeStyle = grad; vctx.lineCap = 'round'; vctx.lineWidth = 2.6; vctx.globalAlpha = 0.5;
  vctx.beginPath();
  for (let i = 0; i < NB; i++) {
    const v = vals[i]; if (v < 0.02) continue;
    const a = (i / NB) * Math.PI * 2 - Math.PI / 2, l = Math.max(1.5, v * v * maxL);
    vctx.moveTo(c + Math.cos(a) * base, c + Math.sin(a) * base);
    vctx.lineTo(c + Math.cos(a) * (base + l), c + Math.sin(a) * (base + l));
  }
  vctx.stroke(); vctx.globalAlpha = 1;
}

function frame() {
  requestAnimationFrame(frame);
  const t = curTrack(), dur = curDur();
  const pos = t ? currentPos() : 0;
  const shown = scrub != null ? scrub * dur : pos;
  const p = dur ? clamp(shown / dur, 0, 1) : 0;
  if (view === 'now') {
    ringProg.style.strokeDashoffset = CIRC * (1 - p);
    ringProg.style.opacity = p > 0.003 ? 1 : 0;
    const ang = p * 2 * Math.PI;
    ringKnob.setAttribute('cx', 120 + 100 * Math.sin(ang)); ringKnob.setAttribute('cy', 120 - 100 * Math.cos(ang));
    const big = !t ? '0:00' : S.remaining && dur ? fmt(Math.ceil(dur - shown)) : fmt(shown);
    const bt = $('#bigTime'); if (bt.textContent !== big) bt.textContent = big;
    const sub = !tracks.size ? 'Añade música para empezar' : !dur ? 'Lista para sonar' : S.remaining ? `restantes de ${fmt(dur)}` : `de ${fmt(dur)}`;
    const st = $('#subTime'); if (st.textContent !== sub) st.textContent = sub;
    drawViz(engine.isPlaying());
    const sec = Math.floor(shown);
    if (sec !== lastAria) {
      lastAria = sec;
      dial.setAttribute('aria-valuemax', Math.floor(dur)); dial.setAttribute('aria-valuenow', sec);
      dial.setAttribute('aria-valuetext', `${fmt(shown)} de ${fmt(dur)}`);
    }
  }
  if (!$('#mini').hidden) $('#miniBar').style.width = (p * 100) + '%';
  if (!np.hidden) frameNP(pos, dur);
}

/* ───────────── lista virtual ───────────── */
class VList {
  constructor(el, render) {
    this.el = el; this.render = render; this.items = []; this.range = [-1, -1]; this.empty = '';
    main.addEventListener('scroll', () => this.update(), { passive: true });
    window.addEventListener('resize', () => this.update(true));
  }
  rowH() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 60; }
  set(items, empty) {
    this.items = items; this.empty = empty || '';
    this.el.style.height = items.length ? items.length * this.rowH() + 'px' : 'auto';
    this.update(true);
  }
  update(force) {
    if (!this.el.offsetParent) return;
    if (!this.items.length) { this.el.innerHTML = this.empty; this.range = [-1, -1]; return; }
    const h = this.rowH();
    const top = this.el.getBoundingClientRect().top - main.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-top / h) - 6);
    const last = Math.min(this.items.length - 1, Math.ceil((main.clientHeight - top) / h) + 6);
    if (!force && first === this.range[0] && last === this.range[1]) return;
    this.range = [first, last];
    let html = '';
    for (let i = first; i <= last; i++) html += this.render(this.items[i], i, h);
    this.el.innerHTML = html;
  }
  indexAt(clientY) { const r = this.el.getBoundingClientRect(); return clamp(Math.round((clientY - r.top) / this.rowH()), 0, this.items.length); }
}
function rowHTML(t, i, h, { grip = false } = {}) {
  const cur = t.id === curId;
  const n = cur ? `<span class="bars${engine.isPlaying() ? '' : ' paused'}" aria-hidden="true"><i></i><i></i><i></i></span>` : String(i + 1);
  const u = coverUrl(t, true);
  const art = u ? `<span class="art" style="background-image:url('${u}')"></span>` : `<span class="art">${NOTE}</span>`;
  return `<div class="row${cur ? ' cur' : ''}" style="top:${i * h}px" data-i="${i}" data-id="${t.id}">
    ${grip ? `<span class="row-btn row-grip" data-act="grip" title="Arrastra para reordenar"><svg class="ico"><use href="#i-grip"/></svg></span>` : ''}
    <button class="row-main" data-act="play" aria-label="Reproducir ${esc(t.title)}">
      <span class="row-n">${n}</span>${art}
      <span class="row-text"><b>${esc(t.title)}</b><small>${esc(artistLine(t))}</small></span>
      <span class="row-album">${esc(t.album || '')}</span>
      <span class="row-dur">${t.duration ? fmt(t.duration) : '—'}</span>
    </button>
    <button class="row-btn" data-act="more" aria-label="Más opciones para ${esc(t.title)}"><svg class="ico"><use href="#i-more"/></svg></button>
  </div>`;
}

/* ───────────── biblioteca ───────────── */
function libraryOrder() {
  if (!libDirty && libCache.sort === S.sort) return libCache.list;
  const list = [...tracks.values()];
  const by = {
    artist: (a, b) => coll.compare(a.albumArtist || a.artist || '￿', b.albumArtist || b.artist || '￿') || coll.compare(a.album || '', b.album || '') || (a.discNo || 0) - (b.discNo || 0) || (a.trackNo || 0) - (b.trackNo || 0) || coll.compare(a.title, b.title),
    album: (a, b) => coll.compare(a.album || '￿', b.album || '￿') || (a.discNo || 0) - (b.discNo || 0) || (a.trackNo || 0) - (b.trackNo || 0) || coll.compare(a.title, b.title),
    title: (a, b) => coll.compare(a.title, b.title) || coll.compare(a.artist || '', b.artist || ''),
    added: (a, b) => (b.added || 0) - (a.added || 0) || coll.compare(a.title, b.title)
  }[S.sort] || ((a, b) => 0);
  list.sort(by);
  libCache = { sort: S.sort, list }; libDirty = false;
  return list;
}
let libQuery = '';
function libraryVisible() {
  const all = libraryOrder();
  if (!libQuery) return all;
  const words = norm(libQuery).split(/\s+/).filter(Boolean);
  return all.filter(t => words.every(w => t._s.includes(w)));
}
const libList = new VList($('#libList'), (t, i, h) => rowHTML(t, i, h));
function renderLibrary(force) {
  const vis = libraryVisible();
  const total = [...tracks.values()].reduce((s, t) => s + (t.duration || 0), 0);
  $('#libMeta').textContent = tracks.size ? `${plural(tracks.size, 'canción', 'canciones')} · ${fmtLong(total)}${libQuery ? ` · ${plural(vis.length, 'resultado', 'resultados')}` : ''}` : 'Sin canciones';
  const empty = tracks.size
    ? `<div class="empty"><b>Nada coincide</b><p>No hay canciones con «${esc(libQuery)}» en el título, el artista o el álbum.</p></div>`
    : `<div class="empty"><b>Tu biblioteca está vacía</b><p>Añade la carpeta donde guardas tu música. Brasa la revisa cada vez que se abre y añade lo nuevo.</p><button class="btn primary" data-empty="folder"><svg class="ico"><use href="#i-folder"/></svg>Añadir carpeta</button></div>`;
  if (force || libList.items !== vis || libList.items.length !== vis.length) libList.set(vis, empty);
  else libList.update(true);
  $$('#sortSeg [data-sort]').forEach(b => b.setAttribute('aria-pressed', b.dataset.sort === S.sort));
}
$('#search').addEventListener('input', e => { libQuery = e.target.value.trim(); renderLibrary(true); });
$('#sortSeg').addEventListener('click', e => { const b = e.target.closest('[data-sort]'); if (!b) return; S.sort = b.dataset.sort; libDirty = true; saveSettings(); renderLibrary(true); });
$('#libPlay').addEventListener('click', () => playList(libraryVisible().map(t => t.id), libQuery ? `Búsqueda «${libQuery}»` : 'Biblioteca', false));
$('#libShuffle').addEventListener('click', () => playList(libraryVisible().map(t => t.id), libQuery ? `Búsqueda «${libQuery}»` : 'Biblioteca', true));
$('#addFolder').addEventListener('click', addFolders);
$('#addFolder2').addEventListener('click', addFolders);
$('#addFilesBtn').addEventListener('click', async () => { const r = await api.addFiles(); if (r) toast(`Añadiendo ${plural(r.count, 'canción', 'canciones')}`); });
document.addEventListener('click', e => { if (e.target.closest('[data-empty="folder"]')) addFolders(); });

function playList(ids, name, shuffle) {
  if (!ids.length) return;
  setContext({ type: 'library', ids, name });
  if (shuffle !== S.shuffle) { S.shuffle = shuffle; saveSettings(); }
  shuffled = [];
  const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
  if (shuffle) reshuffle(ids, first);
  playId(first, { cross: manualCross() });
}
async function addFolders() {
  const r = await api.addFolders();
  if (r) toast(r.count ? `Añadiendo ${plural(r.count, 'canción', 'canciones')}` : 'No hay archivos de audio en esa carpeta.');
}

function onListClick(e, listName) {
  const row = e.target.closest('.row'); if (!row) return;
  const id = row.dataset.id, act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'more') { trackMenu(id, act, listName); return; }
  if (act.dataset.act !== 'play') return;
  if (id === curId && engine.activeTrack() && engine.activeTrack().id === id) { togglePlay(); return; }
  if (listName === 'playlist') setContext({ type: 'playlist', id: openPlaylistId });
  else setContext({ type: 'library', ids: libraryVisible().map(t => t.id), name: libQuery ? `Búsqueda «${libQuery}»` : 'Biblioteca' });
  if (S.shuffle) reshuffle(contextIds(), id);
  playId(id, { cross: manualCross() });
}
$('#libList').addEventListener('click', e => onListClick(e, 'library'));
$('#plList').addEventListener('click', e => onListClick(e, 'playlist'));
function scrollToCurrent() {
  const list = view === 'playlist' ? plList : libList;
  const i = list.items.findIndex(t => t.id === curId);
  if (i < 0) return;
  const r = list.el.getBoundingClientRect(), mr = main.getBoundingClientRect();
  main.scrollTop += r.top - mr.top + i * list.rowH() - main.clientHeight / 3;
}

/* ───────────── menús y hojas ───────────── */
const menu = $('#menu');
let menuAnchor = null;
function openMenu(anchor, items) {
  closeMenu();
  menu.innerHTML = items.map((it, i) => it.sep ? '<hr>' : it.label && !it.action ? `<div class="label">${esc(it.label)}</div>`
    : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? `<svg class="ico"><use href="#i-${it.icon}"/></svg>` : ''}<span>${esc(it.text)}</span></button>`).join('');
  menu._items = items;
  menu.hidden = false;
  menuAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = r.right - mw, y = r.bottom + 6;
  if (x < 8) x = Math.min(r.left, innerWidth - mw - 8);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  const first = menu.querySelector('button'); if (first) first.focus({ preventScroll: true });
}
function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  if (menuAnchor) { menuAnchor.setAttribute('aria-expanded', 'false'); menuAnchor = null; }
}
menu.addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  const it = menu._items[+b.dataset.i]; const anchor = menuAnchor;
  if (it.keepOpen) { it.action(anchor); return; }
  closeMenu(); it.action(anchor);
});
document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target) && e.target !== menuAnchor && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu(); }, true);
main.addEventListener('scroll', closeMenu, { passive: true });
window.addEventListener('blur', closeMenu);
menu.addEventListener('keydown', e => {
  const bs = [...menu.querySelectorAll('button')]; const i = bs.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
});

function sheet({ title, text = '', value = null, ok = 'Aceptar', danger = false }) {
  return new Promise(resolve => {
    const wrap = $('#sheet'), input = $('#sheetInput');
    $('#sheetTitle').textContent = title;
    $('#sheetText').textContent = text; $('#sheetText').hidden = !text;
    input.hidden = value == null; input.value = value ?? '';
    const okBtn = $('#sheetOk'); okBtn.textContent = ok; okBtn.className = 'btn ' + (danger ? 'danger' : 'primary');
    wrap.hidden = false;
    setTimeout(() => (value != null ? input : okBtn).focus(), 30);
    if (value != null) input.select();
    const done = v => { wrap.hidden = true; $('#sheetForm').onsubmit = null; $('#sheetCancel').onclick = null; wrap.onpointerdown = null; resolve(v); };
    $('#sheetForm').onsubmit = e => { e.preventDefault(); if (value != null && !input.value.trim()) { input.focus(); return; } done(value != null ? input.value.trim() : true); };
    $('#sheetCancel').onclick = () => done(null);
    wrap.onpointerdown = e => { if (e.target === wrap) done(null); };
    sheet.cancel = () => done(null);
  });
}

function trackMenu(id, anchor, listName) {
  const t = tracks.get(id); if (!t) return;
  const items = [
    { text: id === curId && engine.isPlaying() ? 'Pausar' : 'Reproducir', icon: id === curId && engine.isPlaying() ? 'pause' : 'play', action: () => { const b = anchor.closest('.row').querySelector('.row-main'); b.click(); } },
    { text: 'Añadir a playlist…', icon: 'pl', keepOpen: true, action: a => playlistPicker([id], a) },
    { sep: true },
    { text: 'Mostrar en la carpeta', icon: 'folder', action: () => api.showInFolder(id) }
  ];
  if (listName === 'playlist') items.push({ text: 'Quitar de esta playlist', icon: 'x', action: () => removeFromPlaylist(openPlaylistId, id) });
  else items.push({ text: 'Quitar de la biblioteca', icon: 'x', danger: true, action: () => removeFromLibrary([id]) });
  openMenu(anchor, items);
}
function playlistPicker(ids, anchor) {
  const items = [{ label: ids.length === 1 ? 'Añadir a' : `Añadir ${ids.length} canciones a` }, { text: 'Nueva playlist…', icon: 'plus', action: async () => { const p = await createPlaylist(); if (p) addToPlaylist(p.id, ids); } }];
  if (playlists.length) items.push({ sep: true });
  playlists.forEach(p => items.push({ text: p.name, icon: 'pl', action: () => addToPlaylist(p.id, ids) }));
  openMenu(anchor, items);
}
async function removeFromLibrary(ids) {
  const t = tracks.get(ids[0]);
  const ok = await sheet({ title: 'Quitar de la biblioteca', text: `«${t.title}» desaparecerá de Brasa y de tus playlists. El archivo no se borra del disco.`, ok: 'Quitar', danger: true });
  if (!ok) return;
  await api.removeTracks(ids);
  removeLocal(ids);
  toast('Quitada de la biblioteca');
}
function removeLocal(ids) {
  const set = new Set(ids);
  ids.forEach(id => tracks.delete(id));
  playlists.forEach(p => { p.ids = p.ids.filter(id => !set.has(id)); });
  libDirty = true;
  if (set.has(curId)) {
    const wasPlaying = engine.isPlaying();
    engine.stopAll();
    const n = order()[0] || null;
    curId = n; pendingOffset = 0;
    if (wasPlaying && n) playId(n); else onTrackChanged();
  }
  savePlaylists(); refresh();
}

/* ───────────── playlists ───────────── */
async function createPlaylist(initial = '') {
  const name = await sheet({ title: 'Nueva playlist', text: 'Ponle un nombre. Podrás cambiarlo después.', value: initial || `Playlist ${playlists.length + 1}`, ok: 'Crear' });
  if (!name) return null;
  const p = { id: uid(), name, ids: [], created: Date.now() };
  playlists.push(p); savePlaylists();
  if (view === 'playlists') renderPlaylists();
  return p;
}
function addToPlaylist(pid, ids) {
  const p = playlists.find(x => x.id === pid); if (!p) return;
  const fresh = ids.filter(id => !p.ids.includes(id));
  p.ids.push(...fresh); p.updated = Date.now();
  savePlaylists();
  toast(fresh.length ? (fresh.length === 1 ? `Añadida a «${p.name}»` : `${fresh.length} canciones añadidas a «${p.name}»`) : `Ya estaba en «${p.name}»`);
  if (view === 'playlist' || view === 'playlists') refresh();
}
function removeFromPlaylist(pid, id) {
  const p = playlists.find(x => x.id === pid); if (!p) return;
  p.ids = p.ids.filter(x => x !== id); savePlaylists(); renderPlaylist(true); updateNow();
  toast(`Quitada de «${p.name}»`);
}
function mosaicHTML(ids, cls = '') {
  const covers = [];
  for (const id of ids) { const t = tracks.get(id); if (t && t.cover && !covers.includes(t.cover)) covers.push(t.cover); if (covers.length === 4) break; }
  if (!covers.length) return `<div class="mosaic none ${cls}"><svg class="ico"><use href="#i-pl"/></svg></div>`;
  const use = covers.length >= 4 ? covers : covers.slice(0, 1);
  return `<div class="mosaic ${use.length === 1 ? 'one' : ''} ${cls}">${use.map(c => `<span style="background-image:url('brasa://app/cover/${c}-s.jpg')"></span>`).join('')}</div>`;
}
const plStats = p => { const list = p.ids.map(id => tracks.get(id)).filter(Boolean); return { n: list.length, d: list.reduce((s, t) => s + (t.duration || 0), 0) }; };
function renderPlaylists() {
  $('#plMeta').textContent = playlists.length ? plural(playlists.length, 'playlist', 'playlists') : 'Agrupa canciones para cada momento. Añade canciones desde la Biblioteca con el botón ⋯.';
  $('#plGrid').innerHTML = playlists.map(p => {
    const s = plStats(p);
    return `<button class="card pl-card" data-pl="${p.id}">${mosaicHTML(p.ids)}<b>${esc(p.name)}</b><small>${plural(s.n, 'canción', 'canciones')}${s.d ? ' · ' + fmtLong(s.d) : ''}</small></button>`;
  }).join('') + `<button class="card pl-card new" id="plNewCard"><svg class="ico"><use href="#i-plus"/></svg><b>Nueva playlist</b></button>`;
}
$('#plGrid').addEventListener('click', async e => {
  if (e.target.closest('#plNewCard')) { const p = await createPlaylist(); if (p) { openPlaylistId = p.id; show('playlist'); } return; }
  const c = e.target.closest('[data-pl]'); if (!c) return;
  openPlaylistId = c.dataset.pl; show('playlist');
});
$('#newPl').addEventListener('click', async () => { const p = await createPlaylist(); if (p) { openPlaylistId = p.id; show('playlist'); } });
$('#importPl').addEventListener('click', async () => {
  const res = await api.importPlaylists(); if (!res) return;
  for (const r of res) {
    playlists.push({ id: uid(), name: r.name, ids: r.ids, created: Date.now() });
    toast(r.missing ? `«${r.name}»: ${r.ids.length} canciones; ${r.missing} no se encontraron` : `Importada «${r.name}» con ${plural(r.ids.length, 'canción', 'canciones')}`);
  }
  savePlaylists(); renderPlaylists();
});

const plList = new VList($('#plList'), (t, i, h) => rowHTML(t, i, h, { grip: true }));
function renderPlaylist(force) {
  const p = playlists.find(x => x.id === openPlaylistId);
  if (!p) { if (view === 'playlist') show('playlists'); return; }
  const list = p.ids.map(id => tracks.get(id)).filter(Boolean);
  const s = plStats(p);
  $('#plName').textContent = p.name;
  $('#plInfo').textContent = `${plural(s.n, 'canción', 'canciones')}${s.d ? ' · ' + fmtLong(s.d) : ''}`;
  $('#plMosaic').outerHTML = mosaicHTML(p.ids, 'big').replace('<div class="', '<div id="plMosaic" class="');
  const empty = `<div class="empty"><b>Esta playlist está vacía</b><p>Ve a la Biblioteca y usa el botón ⋯ de cada canción, o busca y pulsa «Añadir resultados».</p><button class="btn" data-goto="library"><svg class="ico"><use href="#i-lib"/></svg>Ir a la Biblioteca</button></div>`;
  if (force || plList.items.length !== list.length || plList.items.some((t, i) => t !== list[i])) plList.set(list, empty);
  else plList.update(true);
}
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) show(g.dataset.goto); });
$('#plBack').addEventListener('click', () => show('playlists'));
$('#plPlay').addEventListener('click', () => playPlaylist(openPlaylistId, false));
$('#plShuffle').addEventListener('click', () => playPlaylist(openPlaylistId, true));
function playPlaylist(pid, shuffle) {
  const p = playlists.find(x => x.id === pid); if (!p) return;
  const ids = p.ids.filter(id => tracks.has(id)); if (!ids.length) { toast('La playlist está vacía.'); return; }
  setContext({ type: 'playlist', id: pid });
  if (shuffle !== S.shuffle) { S.shuffle = shuffle; saveSettings(); }
  const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
  if (shuffle) reshuffle(ids, first);
  playId(first, { cross: manualCross() });
}
$('#plMore').addEventListener('click', e => {
  const p = playlists.find(x => x.id === openPlaylistId); if (!p) return;
  openMenu(e.currentTarget, [
    { text: 'Cambiar nombre', icon: 'lyrics', action: async () => { const n = await sheet({ title: 'Cambiar nombre', value: p.name, ok: 'Guardar' }); if (n) { p.name = n; savePlaylists(); renderPlaylist(); updateNow(); } } },
    { text: 'Exportar como M3U', icon: 'import', action: async () => { if (await api.exportPlaylist(p.name, p.ids)) toast('Playlist exportada'); } },
    { sep: true },
    { text: 'Eliminar playlist', icon: 'x', danger: true, action: async () => {
      if (!(await sheet({ title: 'Eliminar playlist', text: `Se borra «${p.name}». Las canciones siguen en tu biblioteca.`, ok: 'Eliminar', danger: true }))) return;
      playlists = playlists.filter(x => x.id !== p.id); savePlaylists();
      if (ctxDef.type === 'playlist' && ctxDef.id === p.id) setContext({ type: 'library', ids: contextIds(), name: 'Biblioteca' });
      show('playlists'); toast('Playlist eliminada');
    } }
  ]);
});
// añadir resultados de búsqueda a una playlist
const libTools = $('.list-tools');
const addResults = document.createElement('button');
addResults.className = 'btn'; addResults.id = 'addResults'; addResults.hidden = true;
addResults.innerHTML = '<svg class="ico"><use href="#i-pl"/></svg><span>Añadir resultados</span>';
libTools.appendChild(addResults);
$('#search').addEventListener('input', () => { addResults.hidden = !libQuery; });
addResults.addEventListener('click', e => { const ids = libraryVisible().map(t => t.id); if (ids.length) playlistPicker(ids, e.currentTarget); });

// reordenar arrastrando
(() => {
  let drag = null;
  const listEl = $('#plList');
  listEl.addEventListener('pointerdown', e => {
    const g = e.target.closest('[data-act="grip"]'); if (!g) return;
    const row = g.closest('.row');
    e.preventDefault();
    drag = { from: +row.dataset.i, to: +row.dataset.i, line: document.createElement('div'), row, scroll: 0 };
    drag.line.className = 'drop-line'; listEl.appendChild(drag.line);
    row.classList.add('dragging');
    g.setPointerCapture(e.pointerId);
    const move = ev => {
      drag.to = plList.indexAt(ev.clientY);
      drag.line.style.top = drag.to * plList.rowH() + 'px';
      const mr = main.getBoundingClientRect();
      drag.scroll = ev.clientY < mr.top + 70 ? -12 : ev.clientY > mr.bottom - 70 ? 12 : 0;
    };
    const tick = () => { if (!drag) return; if (drag.scroll) main.scrollTop += drag.scroll; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const up = () => {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      const { from, to } = drag; drag.line.remove(); drag = null;
      const p = playlists.find(x => x.id === openPlaylistId); if (!p) return;
      const vis = plList.items.map(t => t.id);
      if (to === from || to === from + 1) { renderPlaylist(true); return; }
      const [id] = vis.splice(from, 1); vis.splice(to > from ? to - 1 : to, 0, id);
      const missing = p.ids.filter(x => !tracks.has(x));
      p.ids = [...vis, ...missing]; savePlaylists(); renderPlaylist(true); updateNow();
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    move(e);
  });
})();

/* ───────────── ecualizador ───────────── */
const bandsEl = $('#bands');
BANDS.forEach((f, i) => {
  const b = document.createElement('div'); b.className = 'band';
  b.innerHTML = `<output class="band-v" id="bv${i}">0</output>
    <div class="vs" id="band${i}" role="slider" tabindex="0" aria-orientation="vertical" aria-label="${BAND_LABELS[i]}${f >= 1000 ? 'Hz' : ' Hz'}" aria-valuemin="-12" aria-valuemax="12" data-i="${i}">
      <span class="vs-track"></span><span class="vs-fill"></span><span class="vs-thumb"></span></div>
    <span class="band-f">${BAND_LABELS[i]}</span>`;
  bandsEl.appendChild(b);
});
function applyEQ() { engine.applyEQ(); drawCurve(); updateEqUI(); updateNow(); }
function setBand(i, v) {
  v = clamp(Math.round(v * 2) / 2, -12, 12);
  if (S.eq[i] === v) return;
  S.eq[i] = v; S.preset = Object.keys(PRESETS).find(k => PRESETS[k].every((x, j) => x === S.eq[j])) || 'Personalizado';
  applyEQ(); saveSettings();
}
$$('.vs').forEach(el => {
  const i = +el.dataset.i;
  const fromY = e => { const r = el.getBoundingClientRect(); const t = clamp((e.clientY - r.top - 11) / (r.height - 22), 0, 1); return 12 - t * 24; };
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true }); setBand(i, fromY(e)); e.preventDefault(); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) setBand(i, fromY(e)); });
  el.addEventListener('dblclick', () => setBand(i, 0));
  el.addEventListener('keydown', e => {
    const d = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
    if (d != null) { e.preventDefault(); e.stopPropagation(); setBand(i, S.eq[i] + d); }
    else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setBand(i, 0); }
  });
});
$('#presets').innerHTML = Object.keys(PRESETS).map(k => `<button class="chip-btn" data-p="${esc(k)}" aria-pressed="false">${esc(k)}</button>`).join('');
$('#presets').addEventListener('click', e => {
  const b = e.target.closest('[data-p]'); if (!b) return;
  S.preset = b.dataset.p; S.eq = PRESETS[S.preset].slice(); S.eqOn = true;
  applyEQ(); saveSettings();
});
$('#eqReset').addEventListener('click', () => { S.eq = PRESETS['Plano'].slice(); S.preamp = 0; S.preset = 'Plano'; applyEQ(); saveSettings(); });
$('#eqOn').addEventListener('click', () => { S.eqOn = !S.eqOn; applyEQ(); saveSettings(); });
const pre = $('#preamp');
pre.addEventListener('input', () => { S.preamp = +pre.value; applyEQ(); saveSettings(); });
function updateEqUI() {
  S.eq.forEach((v, i) => {
    const el = $('#band' + i), t = (12 - v) / 24;
    el.querySelector('.vs-thumb').style.top = `calc(11px + ${t} * (100% - 22px))`;
    const fill = el.querySelector('.vs-fill'), a = Math.min(t, 0.5), b = Math.max(t, 0.5);
    fill.style.top = `calc(11px + ${a} * (100% - 22px))`; fill.style.height = `calc(${b - a} * (100% - 22px))`;
    el.setAttribute('aria-valuenow', v); el.setAttribute('aria-valuetext', fmtDb(v));
    $('#bv' + i).textContent = v === 0 ? '0' : (v > 0 ? '+' : '−') + num1(Math.abs(v));
  });
  $('#eqCard').classList.toggle('eq-off', !S.eqOn);
  $('#eqOn').setAttribute('aria-checked', S.eqOn); $('#eqOnLabel').textContent = S.eqOn ? 'Activo' : 'Apagado';
  $$('#presets [data-p]').forEach(b => b.setAttribute('aria-pressed', S.eqOn && b.dataset.p === S.preset));
  pre.value = S.preamp; fillRange(pre); $('#preampOut').textContent = fmtDb(S.preamp);
}
const curveCv = $('#eqCurve');
function drawCurve() {
  const r = curveCv.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  curveCv.width = Math.round(r.width * dpr); curveCv.height = Math.round(r.height * dpr);
  const g = curveCv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, pad = 11;
  const y = db => pad + (12 - clamp(db, -12, 12)) / 24 * (H - 2 * pad);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = colors.ink3; g.globalAlpha = 0.35; g.lineWidth = 1; g.setLineDash([3, 5]);
  [6, 0, -6].forEach(d => { g.beginPath(); g.moveTo(0, y(d)); g.lineTo(W, y(d)); g.stroke(); });
  g.setLineDash([]); g.globalAlpha = 1;
  const N = 220, fr = new Float32Array(N), m = new Float32Array(N), ph = new Float32Array(N), tot = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) fr[i] = 32 * Math.pow(2, (i / (N - 1)) * 10 - 0.5);
  engine.curveFilters.forEach(f => { f.getFrequencyResponse(fr, m, ph); for (let i = 0; i < N; i++) tot[i] *= m[i]; });
  const pts = []; for (let i = 0; i < N; i++) pts.push([i / (N - 1) * W, y(20 * Math.log10(tot[i]) + S.preamp)]);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, S.eqOn ? colors.a1 : colors.ink3); grad.addColorStop(1, S.eqOn ? colors.a2 : colors.ink3);
  g.beginPath(); g.moveTo(0, y(0)); pts.forEach(p => g.lineTo(p[0], p[1])); g.lineTo(W, y(0)); g.closePath();
  g.fillStyle = grad; g.globalAlpha = 0.14; g.fill(); g.globalAlpha = 1;
  g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
  g.strokeStyle = grad; g.lineWidth = 2.2; g.stroke();
}
window.addEventListener('resize', () => { if (view === 'eq') drawCurve(); });

/* ───────────── ajustes ───────────── */
function bindRange(id, outId, key, fmtFn) {
  const el = $(id), out = $(outId);
  const upd = () => { el.value = S[key]; fillRange(el); out.textContent = fmtFn(S[key]); };
  el.addEventListener('input', () => { S[key] = +el.value; upd(); saveSettings(); updateNow(); });
  return upd;
}
const secs = v => v === 0 ? 'No' : num1(v) + ' s';
const rangeUpdaters = [
  bindRange('#sFadeIn', '#oFadeIn', 'fadeIn', secs),
  bindRange('#sPause', '#oPause', 'pauseFade', secs),
  bindRange('#sCross', '#oCross', 'crossfade', v => v === 0 ? 'Sin pausa' : secs(v))
];
$$('[data-curve]').forEach(b => b.addEventListener('click', () => { S.curve = b.dataset.curve; saveSettings(); renderSettings(); }));
$$('[data-theme-src]').forEach(b => b.addEventListener('click', () => { S.theme = b.dataset.themeSrc; api.setTheme(S.theme); saveSettings(); renderSettings(); }));
const switchActions = {
  level: () => engine.updateTrim(),
  limiter: () => engine.applyLimiter(),
  adaptive: () => { paletteKey = null; updateLook(curTrack()); },
  backdrop: () => { document.body.classList.toggle('no-backdrop', !S.backdrop); bdUrl = null; updateLook(curTrack()); },
  onlineLyrics: () => { lyricsCache.clear(); if (!np.hidden) loadLyrics(curId); }
};
$$('[data-setting]').forEach(el => el.addEventListener('click', () => {
  const k = el.dataset.setting; S[k] = !S[k]; el.setAttribute('aria-checked', S[k]); saveSettings();
  if (switchActions[k]) switchActions[k]();
}));
function renderFolders() {
  $('#folders').innerHTML = folders.length ? folders.map(f => `<li><svg class="ico"><use href="#i-folder"/></svg><span title="${esc(f)}">‎${esc(f)}‎</span><button class="row-btn" data-folder="${esc(f)}" aria-label="Quitar la carpeta ${esc(f)}"><svg class="ico"><use href="#i-x"/></svg></button></li>`).join('')
    : '<li class="none">Todavía no has añadido ninguna carpeta.</li>';
}
$('#folders').addEventListener('click', async e => {
  const b = e.target.closest('[data-folder]'); if (!b) return;
  const f = b.dataset.folder;
  if (!(await sheet({ title: 'Quitar carpeta', text: `Sus canciones salen de la biblioteca y de tus playlists. Los archivos siguen en ${f}.`, ok: 'Quitar', danger: true }))) return;
  const r = await api.removeFolder(f);
  folders = r.folders; removeLocal(r.removed); renderFolders();
  toast(`Quitada la carpeta y ${plural(r.removed.length, 'canción', 'canciones')}`);
});
$('#rescanBtn').addEventListener('click', async () => {
  const r = await api.rescan();
  toast(`Revisando ${plural(r.found, 'archivo', 'archivos')}${r.removed ? ` · ${r.removed} ya no existen` : ''}`);
});
$('#clearCache').addEventListener('click', async () => { await api.clearCache(); toast('Conversiones borradas'); renderSettings(); });
async function renderSettings() {
  rangeUpdaters.forEach(f => f());
  $$('[data-curve]').forEach(b => b.setAttribute('aria-pressed', b.dataset.curve === S.curve));
  $$('[data-theme-src]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeSrc === S.theme));
  $$('[data-setting]').forEach(el => el.setAttribute('aria-checked', !!S[el.dataset.setting]));
  renderFolders();
  $('#ffStatus').textContent = ffmpegOk ? 'Todos los formatos de audio' : 'FFmpeg no encontrado';
  const bytes = await api.cacheInfo();
  $('#cacheText').textContent = bytes ? `${(bytes / 1024 ** 2).toLocaleString('es-ES', { maximumFractionDigits: bytes > 1024 ** 3 ? 0 : 1 })} MB en archivos convertidos. Se borran solos los más antiguos al pasar de 4 GB.` : 'No hay conversiones guardadas.';
}

/* ───────────── vista completa con letra ───────────── */
const np = $('#np');
const lyricsCache = new Map();
let lyr = null, lyIdx = -2, lyricsFollow = 0;
function openNP() {
  if (!curTrack()) return;
  np.hidden = false; closeMenu();
  renderNP(true);
  np.focus({ preventScroll: true });
}
function closeNP() { np.hidden = true; }
$('#npClose').addEventListener('click', closeNP);
function techLine(t) {
  const e = (t.path || '').split('.').pop().toLowerCase();
  const codec = String(t.codec || '');
  const names = { mp3: 'MP3', flac: 'FLAC', ogg: /opus/i.test(codec) ? 'Opus' : 'Ogg Vorbis', oga: 'Ogg', opus: 'Opus', wav: 'WAV', wave: 'WAV', aif: 'AIFF', aiff: 'AIFF', aifc: 'AIFF', wma: 'WMA', ape: "Monkey's Audio", wv: 'WavPack', dsf: 'DSD', dff: 'DSD', mpc: 'Musepack', tta: 'TTA', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', mka: 'Matroska', webm: 'WebM', caf: 'CAF', amr: 'AMR' };
  let name = names[e] || (/(m4a|m4b|mp4|aac)/.test(e) ? (/alac/i.test(codec) ? 'ALAC' : 'AAC') : e.toUpperCase());
  const bits = [name];
  if (t.bits && (t.lossless || /flac|wav|aiff|alac|wavpack|ape|dsd/i.test(name))) bits.push(`${t.bits} bit`);
  if (t.sampleRate) bits.push(`${(t.sampleRate / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} kHz`);
  if (engine.activeTrack() && engine.activeTrack().id === t.id && engine.activeConverted()) bits.push('convertido a FLAC');
  return bits.join(' · ');
}
let npId = null;
function renderNP(force) {
  const t = curTrack(); if (!t) { closeNP(); return; }
  if (force || npId !== t.id) {
    npId = t.id;
    const big = coverUrl(t, false);
    const cv = $('#npCover');
    cv.style.backgroundImage = big ? `url("${big}")` : ''; cv.innerHTML = big ? '' : NOTE;
    $('#npBg').style.backgroundImage = big ? `url("${coverUrl(t, true)}")` : '';
    $('#npTitle').textContent = t.title;
    $('#npArtist').textContent = [artistLine(t), t.album, t.year].filter(Boolean).join(' · ');
    loadLyrics(t.id);
  }
  $('#npTech').textContent = techLine(t);
  $('#npCtx').textContent = `Reproduciendo desde ${ctxName()}`;
}
async function loadLyrics(id, online) {
  const t = tracks.get(id); if (!t) return;
  const box = $('#npLyrics');
  lyr = null; lyIdx = -2;
  box.innerHTML = '<p class="ly-plain" style="opacity:.6">Buscando la letra…</p>'; $('#npSource').textContent = '';
  let r = !online && lyricsCache.get(id);
  if (!r) {
    r = await api.getLyrics(id, online || S.onlineLyrics);
    if (!r.error) lyricsCache.set(id, r);
  }
  if (curId !== id) return;
  lyr = { id, ...r };
  if (r.synced) {
    box.innerHTML = r.synced.map((l, i) => l.text
      ? `<button class="ly" data-i="${i}" data-t="${l.t}">${esc(l.text)}</button>`
      : `<button class="ly gap" data-i="${i}" data-t="${l.t}" aria-label="Pausa instrumental">♪</button>`).join('');
  } else if (r.plain) {
    box.innerHTML = `<div class="ly-plain">${esc(r.plain)}</div>`;
  } else {
    const msg = r.instrumental ? ['Canción instrumental', 'Según LRCLIB, esta canción no tiene letra.']
      : r.error ? ['Sin conexión', r.error]
      : r.offline ? ['Sin letra guardada', 'Esta canción no trae letra ni tiene un archivo .lrc al lado, y la búsqueda en internet está desactivada.']
      : ['No hay letra', 'No viene en el archivo, no hay un .lrc con el mismo nombre y LRCLIB no la tiene.'];
    box.innerHTML = `<div class="ly-empty"><b>${msg[0]}</b><p>${esc(msg[1])}</p><div class="actions">
      <button class="btn" data-ly="pick"><svg class="ico"><use href="#i-lyrics"/></svg>Elegir archivo .lrc</button>
      ${r.offline || r.error ? '<button class="btn" data-ly="online"><svg class="ico"><use href="#i-search"/></svg>Buscar en internet</button>' : ''}</div></div>`;
  }
  $('#npSource').textContent = r.source ? `Letra: ${r.source}${r.synced ? ' · sincronizada' : ''}` : '';
  box.scrollTop = 0; lyricsFollow = 0;
}
$('#npLyrics').addEventListener('click', async e => {
  const l = e.target.closest('.ly');
  if (l) { seek(+l.dataset.t); lyricsFollow = 0; if (!engine.isPlaying()) togglePlay(); return; }
  const b = e.target.closest('[data-ly]'); if (!b) return;
  if (b.dataset.ly === 'online') { lyricsCache.delete(curId); loadLyrics(curId, true); }
  if (b.dataset.ly === 'pick') { const r = await api.pickLyrics(curId); if (r) { lyricsCache.set(curId, r); loadLyrics(curId); } }
});
['wheel', 'touchmove'].forEach(ev => $('#npLyrics').addEventListener(ev, () => { lyricsFollow = performance.now() + 4000; }, { passive: true }));
function frameNP(pos, dur) {
  const seekEl = $('#npSeek');
  if (!seekEl.matches(':active')) { seekEl.value = dur ? pos / dur : 0; fillRange(seekEl); }
  const a = fmt(pos), b = fmt(dur);
  if ($('#npPos').textContent !== a) $('#npPos').textContent = a;
  if ($('#npDur').textContent !== b) $('#npDur').textContent = b;
  if (!lyr || !lyr.synced || lyr.id !== curId) return;
  const L = lyr.synced; const p = pos + 0.25;
  let lo = 0, hi = L.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= p) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx === lyIdx) return;
  lyIdx = idx;
  const box = $('#npLyrics');
  box.querySelectorAll('.ly').forEach((el, i) => { el.classList.toggle('on', i === idx); el.classList.toggle('past', i < idx); });
  if (performance.now() < lyricsFollow) return;
  const el = box.querySelector(`.ly[data-i="${Math.max(0, idx)}"]`);
  if (el) box.scrollTo({ top: el.offsetTop - box.clientHeight * 0.32, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}
$('#npSeek').addEventListener('input', e => { fillRange(e.target); const d = curDur(); if (d) seek(+e.target.value * d); });

/* ───────────── teclas multimedia y atajos ───────────── */
// La carátula se pasa al sistema (Windows, macOS, Linux) como blob, que es lo que acepta MediaSession
let msArt = { cover: null, url: null };
async function updateMediaSession() {
  const ms = navigator.mediaSession; if (!ms) return;
  const t = curTrack();
  const meta = art => { try { ms.metadata = t ? new MediaMetadata({ title: t.title, artist: artistLine(t), album: t.album || '', artwork: art ? [{ src: art, sizes: '1000x1000', type: 'image/jpeg' }] : [] }) : null; } catch (e) { /* */ } };
  if (!t || !t.cover) { meta(null); return; }
  if (msArt.cover === t.cover) { meta(msArt.url); return; }
  meta(null);
  try {
    const blob = await (await fetch(coverUrl(t))).blob();
    if (curTrack() !== t) return;
    if (msArt.url) URL.revokeObjectURL(msArt.url);
    msArt = { cover: t.cover, url: URL.createObjectURL(blob) };
    meta(msArt.url);
  } catch (e) { /* sin carátula para el sistema */ }
}
try {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => { if (!engine.isPlaying()) togglePlay(); });
  ms.setActionHandler('pause', () => { if (engine.isPlaying()) togglePlay(); });
  ms.setActionHandler('nexttrack', next);
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('seekto', d => seek(d.seekTime));
} catch (e) { /* */ }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#sheet').hidden) { sheet.cancel && sheet.cancel(); return; }
    if (!menu.hidden) { closeMenu(); return; }
    if (!np.hidden) { closeNP(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); closeNP(); show('library'); $('#search').focus(); $('#search').select(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#sheet').hidden) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'range') return;
  if (e.target.getAttribute && e.target.getAttribute('role') === 'slider' && e.key.startsWith('Arrow')) return;
  if (!menu.hidden && e.key.startsWith('Arrow')) return;
  switch (e.key) {
    case ' ': if (tag === 'BUTTON') return; e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': if (tag === 'INPUT') return; e.preventDefault(); seek(currentPos() + (e.shiftKey ? 30 : 5)); break;
    case 'ArrowLeft': if (tag === 'INPUT') return; e.preventDefault(); seek(currentPos() - (e.shiftKey ? 30 : 5)); break;
    case 'ArrowUp': if (tag === 'INPUT') return; e.preventDefault(); setVolume(S.volume + 0.05); break;
    case 'ArrowDown': if (tag === 'INPUT') return; e.preventDefault(); setVolume(S.volume - 0.05); break;
    case 'n': case 'N': next(); break;
    case 'p': case 'P': prev(); break;
    case 'm': case 'M': toggleMute(); break;
    case 's': case 'S': toggleShuffle(); break;
    case 'r': case 'R': cycleRepeat(); break;
    case 'l': case 'L': np.hidden ? openNP() : closeNP(); break;
  }
});

/* ───────────── arrastrar y soltar ───────────── */
let dragN = 0;
const isFileDrag = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!isFileDrag(e)) return; e.preventDefault(); dragN++; $('#drop').hidden = false; });
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!isFileDrag(e)) return; dragN = Math.max(0, dragN - 1); if (!dragN) $('#drop').hidden = true; });
window.addEventListener('drop', async e => {
  if (!isFileDrag(e)) return; e.preventDefault(); dragN = 0; $('#drop').hidden = true;
  const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await api.importPaths(paths);
  toast(r.count ? `Añadiendo ${plural(r.count, 'canción', 'canciones')}` : 'No hay archivos de audio en lo que has soltado.');
});

/* ───────────── eventos de la biblioteca ───────────── */
api.onUpsert(list => {
  const firstLoad = !tracks.size;
  list.forEach(t => {
    const old = tracks.get(t.id);
    if (old) { t._analyzing = old._analyzing; if (old.duration && !t.duration) t.duration = old.duration; }
    tracks.set(t.id, prepTrack(t));
  });
  libDirty = true;
  if (!curId || !tracks.has(curId)) { curId = libraryOrder()[0] ? libraryOrder()[0].id : null; if (firstLoad) onTrackChanged(); }
  if (ctxDef.type === 'library' && ctxDef.name === 'Biblioteca' && !libQuery) ctxDef.ids = libraryOrder().map(t => t.id);
  if (list.some(t => t.id === curId)) { paletteKey = null; updateLook(curTrack()); }
  scheduleRender();
});
api.onRemove(ids => removeLocal(ids));
api.onFolders(f => { folders = f; if (view === 'settings') renderFolders(); });
api.onProgress(p => {
  $('#scanPill').hidden = !p.active;
  if (p.active) $('#scanText').textContent = p.total > 1 ? `Leyendo ${p.done.toLocaleString('es-ES')} de ${p.total.toLocaleString('es-ES')}` : 'Leyendo biblioteca';
});
api.onOpen(ids => {
  if (!ids.length) return;
  setContext({ type: 'library', ids, name: 'Archivos abiertos' });
  playId(ids[0], { cross: manualCross() });
});

/* ───────────── arranque ───────────── */
async function init() {
  const lib = await api.getLibrary();
  platform = lib.platform; ffmpegOk = lib.ffmpeg;
  document.body.classList.add('platform-' + platform);
  Object.assign(S, DEFAULTS, lib.settings || {});
  if (!Array.isArray(S.eq) || S.eq.length !== 10) S.eq = DEFAULTS.eq.slice();
  lastVol = S.volume || 0.8;
  if (S.theme !== 'system') api.setTheme(S.theme);
  document.body.classList.toggle('no-backdrop', !S.backdrop);
  lib.tracks.forEach(t => tracks.set(t.id, prepTrack(t)));
  folders = lib.folders || [];
  playlists = (lib.playlists || []).filter(p => p && p.id && Array.isArray(p.ids));
  const sess = lib.session || {};
  if (sess.ctx && sess.ctx.type === 'playlist' && playlists.some(p => p.id === sess.ctx.id)) ctxDef = { type: 'playlist', id: sess.ctx.id };
  else if (sess.ctx && Array.isArray(sess.ctx.ids)) ctxDef = { type: 'library', ids: sess.ctx.ids, name: sess.ctx.name || 'Biblioteca' };
  else ctxDef = { type: 'library', ids: libraryOrder().map(t => t.id), name: 'Biblioteca' };
  if (sess.curId && tracks.has(sess.curId)) { curId = sess.curId; pendingOffset = sess.pos || 0; }
  else curId = libraryOrder()[0] ? libraryOrder()[0].id : null;
  if (lib.scan && lib.scan.active) $('#scanPill').hidden = false;

  readColors();
  engine.setVolume(S.volume); updateVolUI();
  engine.applyEQ(); updateEqUI();
  greet(); setInterval(greet, 60000);
  onTrackChanged();
  requestAnimationFrame(frame);
  setInterval(() => { if (engine.isPlaying()) saveSession(); }, 10000);
  window.addEventListener('beforeunload', saveSession);
}
init();
