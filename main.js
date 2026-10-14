'use strict';
/*
 * Brasa · proceso principal
 * - Sirve la interfaz y el audio por el protocolo brasa:// (con soporte de Range para poder buscar).
 * - Mantiene la biblioteca (pistas, carpetas, playlists, ajustes) en un JSON dentro de la carpeta de datos.
 * - Lee etiquetas, carátulas y letras con music-metadata.
 * - Convierte con FFmpeg los formatos que Chromium no reproduce (WMA, APE, ALAC, AIFF, DSD, WavPack…).
 * - Mide la sonoridad (EBU R128) para nivelar el volumen entre pistas.
 * - Busca letras sincronizadas: .lrc junto al archivo, etiquetas incrustadas o LRCLIB (opcional).
 */
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, nativeTheme, nativeImage, net, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

protocol.registerSchemesAsPrivileged([{
  scheme: 'brasa',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

if (process.env.BRASA_DATA) app.setPath('userData', process.env.BRASA_DATA);

/* ───────── rutas y constantes ───────── */
const RENDERER = path.join(__dirname, 'renderer');
const DATA = () => app.getPath('userData');
const DIR = {
  covers: () => path.join(DATA(), 'covers'),
  cache: () => path.join(DATA(), 'conversiones'),
  lyrics: () => path.join(DATA(), 'letras')
};
const STORE_FILE = () => path.join(DATA(), 'biblioteca.json');

const AUDIO_EXT = new Set(('mp3 mp2 mp1 mpga m4a m4b m4p mp4 aac adts alac flac ogg oga ogx opus spx wav wave w64 rf64 bwf ' +
  'aif aiff aifc webm weba mka wma asf ape wv mpc mp+ mpp tta tak dsf dff ac3 eac3 ec3 dts dtshd thd mlp truehd ' +
  'amr awb 3gp 3g2 caf au snd ra rm voc shn ofr ofs gsm vqf').split(' '));
const NATIVE_EXT = new Set(['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'webm', 'weba']);
const IMG_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'portada', 'caratula', 'carátula'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.webm': 'audio/webm', '.weba': 'audio/webm'
};
const ext = p => path.extname(p).slice(1).toLowerCase();
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const exists = p => fsp.access(p).then(() => true, () => false);

function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (p) p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* sin binario empaquetado */ }
  return 'ffmpeg';
}
const FFMPEG = ffmpegPath();
let ffmpegOk = null;
function checkFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise(res => {
    try {
      const p = spawn(FFMPEG, ['-hide_banner', '-version'], { windowsHide: true });
      p.on('error', () => res(ffmpegOk = false));
      p.on('close', c => res(ffmpegOk = c === 0));
    } catch (e) { res(ffmpegOk = false); }
  });
}

let mmMod = null;
const MM = async () => mmMod || (mmMod = await import('music-metadata'));

/* ───────── almacén ───────── */
const store = { version: 1, tracks: [], folders: [], excluded: [], playlists: [], settings: {}, session: {} };
const isExcluded = p => (store.excluded || []).includes(p);
const tracks = new Map();
let saveTimer = null;
async function loadStore() {
  try {
    const raw = JSON.parse(await fsp.readFile(STORE_FILE(), 'utf8'));
    Object.assign(store, raw);
  } catch (e) { /* primera vez */ }
  tracks.clear();
  for (const t of store.tracks || []) tracks.set(t.id, t);
}
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStore, 600);
}
async function flushStore() {
  clearTimeout(saveTimer); saveTimer = null;
  store.tracks = [...tracks.values()];
  const tmp = STORE_FILE() + '.tmp';
  try {
    await fsp.mkdir(DATA(), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(store));
    await fsp.rename(tmp, STORE_FILE());
  } catch (e) { console.error('No se pudo guardar la biblioteca', e); }
}

/* ───────── envío al renderer ───────── */
let win = null;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

/* ───────── escaneo ───────── */
async function walk(dir, out, depth = 0) {
  if (depth > 24) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) { try { const st = await fsp.stat(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch (er) { continue; } }
    if (isDir) await walk(p, out, depth + 1);
    else if (isFile && AUDIO_EXT.has(ext(p))) out.push(p);
  }
}

function parseName(file) {
  let base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  let trackNo = null;
  const m = /^(\d{1,3})\s*[-.)]?\s+(.*)$/.exec(base);
  if (m && m[2]) { trackNo = +m[1]; base = m[2]; }
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), trackNo };
  return { artist: '', title: base || path.basename(file), trackNo };
}

async function saveCover(data) {
  if (!data || !data.length) return null;
  const hash = sha(data);
  const big = path.join(DIR.covers(), hash + '.jpg');
  const small = path.join(DIR.covers(), hash + '-s.jpg');
  if (await exists(small)) return hash;
  await fsp.mkdir(DIR.covers(), { recursive: true });
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(data));
    if (img.isEmpty()) throw new Error('vacía');
    const { width } = img.getSize();
    await fsp.writeFile(big, (width > 1000 ? img.resize({ width: 1000, quality: 'best' }) : img).toJPEG(90));
    await fsp.writeFile(small, img.resize({ width: 192, quality: 'best' }).toJPEG(86));
  } catch (e) {
    await fsp.writeFile(big, data);
    await fsp.writeFile(small, data);
  }
  return hash;
}

const folderArt = new Map();
async function folderCover(dir) {
  if (folderArt.has(dir)) return folderArt.get(dir);
  const p = (async () => {
    let names;
    try { names = await fsp.readdir(dir); } catch (e) { return null; }
    const imgs = names.filter(n => /\.(jpe?g|png|webp)$/i.test(n));
    if (!imgs.length) return null;
    const pick = imgs.find(n => IMG_NAMES.includes(n.replace(/\.[^.]+$/, '').toLowerCase())) || (imgs.length === 1 ? imgs[0] : null);
    if (!pick) return null;
    try { return await saveCover(await fsp.readFile(path.join(dir, pick))); } catch (e) { return null; }
  })();
  folderArt.set(dir, p);
  return p;
}

async function readTrack(file, st) {
  const id = sha(file);
  const fromName = parseName(file);
  const t = {
    id, path: file, size: st.size, mtime: st.mtimeMs, added: (tracks.get(id) || {}).added || Date.now(),
    title: fromName.title, artist: fromName.artist, album: '', albumArtist: '',
    trackNo: fromName.trackNo, discNo: null, year: null, genre: '', duration: null,
    codec: ext(file).toUpperCase(), container: ext(file), sampleRate: null, bits: null, channels: null, lossless: null,
    cover: null, rg: null, lufs: (tracks.get(id) || {}).lufs ?? null, hasLyrics: false
  };
  try {
    const mm = await MM();
    const meta = await mm.parseFile(file, { duration: /^(ogg|oga|opus|spx)$/.test(ext(file)), skipCovers: false });
    const c = meta.common, f = meta.format;
    if (c.title) t.title = String(c.title).trim();
    if (c.artist) t.artist = String(c.artist).trim();
    else if (c.albumartist) t.artist = String(c.albumartist).trim();
    if (c.album) t.album = String(c.album).trim();
    if (c.albumartist) t.albumArtist = String(c.albumartist).trim();
    if (c.track && c.track.no) t.trackNo = c.track.no;
    if (c.disk && c.disk.no) t.discNo = c.disk.no;
    if (c.year) t.year = c.year;
    if (c.genre && c.genre.length) t.genre = c.genre.join(', ');
    if (f.duration) t.duration = f.duration;
    if (f.codec) t.codec = f.codec;
    if (f.container) t.container = f.container;
    t.sampleRate = f.sampleRate || null; t.bits = f.bitsPerSample || null;
    t.channels = f.numberOfChannels || null; t.lossless = f.lossless ?? null;
    if (c.replaygain_track_gain && isFinite(c.replaygain_track_gain.dB)) t.rg = c.replaygain_track_gain.dB;
    t.hasLyrics = !!(c.lyrics && c.lyrics.length) || nativeLyrics(meta).length > 0;
    const pic = mm.selectCover(c.picture);
    if (pic) t.cover = await saveCover(pic.data);
  } catch (e) { /* sin etiquetas legibles: se queda con el nombre de archivo */ }
  if (!t.cover) t.cover = await folderCover(path.dirname(file));
  return t;
}

let scan = { active: false, done: 0, total: 0 };
const scanQueue = [];
let scanPromise = null;
let pendingUpserts = [], upsertTimer = null;
function flushUpserts() {
  clearTimeout(upsertTimer); upsertTimer = null;
  if (pendingUpserts.length) { send('lib:upsert', pendingUpserts); pendingUpserts = []; }
  send('lib:progress', scan);
}
function queueUpsert(t) {
  pendingUpserts.push(t);
  if (!upsertTimer) upsertTimer = setTimeout(flushUpserts, 350);
}

/** Añade archivos a la cola de lectura. Devuelve los ids en el mismo orden. */
function enqueueFiles(files) {
  const ids = files.map(f => sha(f));
  scanQueue.push(...files);
  scan.total += files.length;
  if (!scanPromise) scanPromise = runScan().finally(() => { scanPromise = null; });
  return ids;
}
async function runScan() {
  scan.active = true; flushUpserts();
  const worker = async () => {
    while (scanQueue.length) {
      const file = scanQueue.shift();
      try {
        const st = await fsp.stat(file);
        const old = tracks.get(sha(file));
        if (!old || old.mtime !== st.mtimeMs || old.size !== st.size) {
          const t = await readTrack(file, st);
          tracks.set(t.id, t); queueUpsert(t);
        }
      } catch (e) { /* archivo inaccesible */ }
      scan.done++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  scan = { active: false, done: 0, total: 0 };
  flushUpserts(); saveStore();
}
async function waitScan() { while (scanPromise) await scanPromise; }

function underFolder(p, folder) {
  const rel = path.relative(folder, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
async function importPaths(paths) {
  const files = [];
  for (const p of paths) {
    let st; try { st = await fsp.stat(p); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (!store.folders.some(f => f === p || underFolder(p, f))) {
        store.folders = store.folders.filter(f => !underFolder(f, p));
        store.folders.push(p);
      }
      const found = []; await walk(p, found);
      files.push(...found.filter(f => !isExcluded(f)));
    } else if (AUDIO_EXT.has(ext(p))) { files.push(p); store.excluded = (store.excluded || []).filter(x => x !== p); }
  }
  saveStore();
  send('lib:folders', store.folders);
  return { ids: enqueueFiles(files), count: files.length };
}
async function rescan() {
  const files = [];
  for (const f of store.folders) await walk(f, files);
  for (let i = files.length - 1; i >= 0; i--) if (isExcluded(files[i])) files.splice(i, 1);
  const set = new Set(files);
  const gone = [];
  for (const t of tracks.values()) {
    if (set.has(t.path)) continue;
    if (!(await exists(t.path))) gone.push(t.id);
  }
  if (gone.length) { gone.forEach(id => tracks.delete(id)); send('lib:remove', gone); saveStore(); }
  enqueueFiles(files);
  return { found: files.length, removed: gone.length };
}

/* ───────── conversión (FFmpeg) ───────── */
function needsConvert(t) {
  const e = ext(t.path), codec = String(t.codec || '');
  if (!NATIVE_EXT.has(e)) return true;
  if (/alac|ac-?3|dts|truehd|mlp/i.test(codec)) return true;
  if ((e === 'wav' || e === 'wave') && codec && !/pcm|float|mpeg|mp3/i.test(codec)) return true;
  if ((t.sampleRate || 0) > 192000) return true;
  return false;
}
const convertJobs = new Map();
function cachedPath(t) { return path.join(DIR.cache(), t.id + '.flac'); }
function runFfmpeg(args, collect) {
  return new Promise((resolve, reject) => {
    let err = '';
    let p;
    try { p = spawn(FFMPEG, args, { windowsHide: true }); } catch (e) { reject(e); return; }
    p.stderr.on('data', d => { err += d; if (!collect && err.length > 20000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(err.slice(-600) || 'FFmpeg terminó con código ' + code)));
  });
}
async function convert(t) {
  const out = cachedPath(t);
  try { const st = await fsp.stat(out); if (st.mtimeMs >= t.mtime && st.size > 0) { fsp.utimes(out, new Date(), st.mtime).catch(() => {}); return out; } } catch (e) { /* no existe */ }
  if (convertJobs.has(t.id)) return convertJobs.get(t.id);
  const job = (async () => {
    if (!(await checkFfmpeg())) throw new Error('FFmpeg no está disponible');
    await fsp.mkdir(DIR.cache(), { recursive: true });
    const tmp = out + '.part';
    const args = ['-hide_banner', '-nostdin', '-y', '-i', t.path, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-c:a', 'flac', '-compression_level', '1'];
    if ((t.sampleRate || 0) > 192000) args.push('-ar', '96000');
    if ((t.channels || 2) > 8) args.push('-ac', '2');
    args.push('-f', 'flac', tmp);
    await runFfmpeg(args);
    await fsp.rename(tmp, out);
    trimCache().catch(() => {});
    return out;
  })();
  convertJobs.set(t.id, job);
  try { return await job; } finally { convertJobs.delete(t.id); }
}
async function cacheEntries() {
  let names = [];
  try { names = await fsp.readdir(DIR.cache()); } catch (e) { return []; }
  const out = [];
  for (const n of names) { try { const st = await fsp.stat(path.join(DIR.cache(), n)); out.push({ p: path.join(DIR.cache(), n), size: st.size, at: st.atimeMs }); } catch (e) { /* */ } }
  return out;
}
async function trimCache(limit = 4 * 1024 ** 3) {
  const ents = (await cacheEntries()).sort((a, b) => a.at - b.at);
  let total = ents.reduce((s, e) => s + e.size, 0);
  for (const e of ents) { if (total <= limit) break; await fsp.rm(e.p, { force: true }); total -= e.size; }
}

/* ───────── sonoridad (EBU R128) ───────── */
const TARGET_LUFS = -14;
const loudJobs = new Map();
async function analyze(id) {
  const t = tracks.get(id); if (!t) return null;
  if (t.rg != null) return t.rg + (TARGET_LUFS + 18); // ReplayGain usa −18 LUFS de referencia
  if (t.lufs != null) return t.lufs;
  if (loudJobs.has(id)) return loudJobs.get(id);
  const job = (async () => {
    if (!(await checkFfmpeg())) return null;
    const run = filter => runFfmpeg(['-hide_banner', '-nostdin', '-nostats', '-i', t.path, '-map', '0:a:0', '-vn', '-af', filter, '-f', 'null', '-'], true);
    let log;
    try { log = await run('ebur128=framelog=quiet'); } catch (e) { try { log = await run('ebur128'); } catch (er) { return null; } }
    const all = [...log.matchAll(/I:\s+(-?[\d.]+)\s+LUFS/g)];
    if (!all.length) return null;
    const I = parseFloat(all[all.length - 1][1]);
    if (!isFinite(I) || I < -70) return null;
    t.lufs = Math.round(clamp(TARGET_LUFS - I, -12, 6) * 10) / 10;
    saveStore();
    return t.lufs;
  })();
  loudJobs.set(id, job);
  try { return await job; } finally { loudJobs.delete(id); }
}

/* ───────── letras ───────── */
function parseLRC(text) {
  const lines = [];
  let offset = 0;
  const plain = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
    if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
    if (/^\[(ar|ti|al|au|by|re|ve|length|la|id|#):/i.test(raw)) continue;
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    const body = raw.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (tags.length) {
      for (const m of tags) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text: body });
    } else plain.push(raw.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, ''));
  }
  if (lines.length >= 2) {
    lines.sort((a, b) => a.t - b.t);
    lines.forEach(l => { l.t = Math.max(0, l.t - offset); });
    return { synced: lines, plain: null };
  }
  const p = plain.join('\n').trim();
  return { synced: null, plain: p || null };
}
async function readText(file) {
  const buf = await fsp.readFile(file);
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) s = buf.toString('latin1');
  return s.replace(/^\uFEFF/, '');
}
// Algunos programas guardan la letra en campos propios (TXXX:LYRICS, UNSYNCEDLYRICS…)
function nativeLyrics(meta) {
  const out = [];
  for (const list of Object.values(meta.native || {})) {
    for (const tag of list) {
      const id = String(tag.id || '');
      if (!/lyric|TXXX:USLT/i.test(id) || /^(USLT|SYLT)$/.test(id)) continue;
      const v = tag.value;
      const text = typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : null;
      if (text && text.trim().length > 3) out.push(text);
    }
  }
  return out;
}
async function lyricsFromTags(t) {
  try {
    const meta = await (await MM()).parseFile(t.path, { duration: false, skipCovers: true });
    for (const l of [...(meta.common.lyrics || []), ...nativeLyrics(meta)]) {
      if (typeof l === 'string') { const r = parseLRC(l); if (r.synced || r.plain) return r; continue; }
      if (l.syncText && l.syncText.length > 1) {
        const lines = l.syncText.filter(x => x.timestamp != null).map(x => ({ t: x.timestamp / 1000, text: String(x.text || '').trim() }));
        if (lines.length > 1) return { synced: lines.sort((a, b) => a.t - b.t), plain: null };
      }
      if (l.text) { const r = parseLRC(l.text); if (r.synced || r.plain) return r; }
    }
  } catch (e) { /* */ }
  return null;
}
async function lrclib(t) {
  const UA = 'Brasa/1.0 (reproductor de musica de escritorio)';
  const get = async url => {
    const r = await net.fetch(url, { headers: { 'User-Agent': UA, 'Lrclib-Client': UA } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('LRCLIB ' + r.status);
    return r.json();
  };
  const artist = t.artist || t.albumArtist;
  if (!t.title || !artist) return null;
  const q = new URLSearchParams({ track_name: t.title, artist_name: artist });
  if (t.album) q.set('album_name', t.album);
  if (t.duration) q.set('duration', String(Math.round(t.duration)));
  let hit = await get('https://lrclib.net/api/get?' + q);
  if (!hit) {
    const list = await get('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: t.title, artist_name: artist }));
    if (Array.isArray(list) && list.length) {
      const scored = list.map(x => ({ x, d: t.duration && x.duration ? Math.abs(x.duration - t.duration) : 5, s: x.syncedLyrics ? 0 : 1 }))
        .filter(o => o.d < 6).sort((a, b) => a.s - b.s || a.d - b.d);
      hit = scored.length ? scored[0].x : null;
    }
  }
  if (!hit) return { none: true };
  if (hit.instrumental) return { instrumental: true };
  if (hit.syncedLyrics) { const r = parseLRC(hit.syncedLyrics); if (r.synced) return r; }
  if (hit.plainLyrics) return { synced: null, plain: hit.plainLyrics.trim() };
  return { none: true };
}
async function getLyrics(id, online) {
  const t = tracks.get(id); if (!t) return { none: true };
  await fsp.mkdir(DIR.lyrics(), { recursive: true });
  // 1. archivo añadido a mano desde la app
  const user = path.join(DIR.lyrics(), id + '.lrc');
  if (await exists(user)) { const r = parseLRC(await readText(user)); if (r.synced || r.plain) return { ...r, source: 'Archivo añadido' }; }
  // 2. .lrc junto a la canción
  const base = t.path.slice(0, t.path.length - path.extname(t.path).length);
  for (const cand of [base + '.lrc', base + '.LRC', base + '.txt']) {
    if (await exists(cand)) { const r = parseLRC(await readText(cand)); if (r.synced || r.plain) return { ...r, source: 'Archivo .lrc' }; }
  }
  // 3. etiquetas del archivo
  const tag = await lyricsFromTags(t);
  if (tag) return { ...tag, source: 'Etiquetas del archivo' };
  // 4. caché de LRCLIB
  const cacheFile = path.join(DIR.lyrics(), id + '.json');
  let cached = null;
  try { cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8')); } catch (e) { /* */ }
  if (cached && !cached.none) return { ...cached, source: 'LRCLIB' };
  if (!online) return { none: true, offline: true };
  if (cached && cached.none && Date.now() - cached.at < 7 * 864e5) return { none: true };
  try {
    const r = await lrclib(t);
    if (r) { await fsp.writeFile(cacheFile, JSON.stringify({ ...r, at: Date.now() })); }
    if (r && !r.none) return { ...r, source: 'LRCLIB' };
    return { none: true };
  } catch (e) {
    return { none: true, error: 'No se pudo conectar con LRCLIB.' };
  }
}

/* ───────── protocolo brasa:// ───────── */
async function serveFile(req, file, type) {
  let st;
  try { st = await fsp.stat(file); } catch (e) { return new Response('No encontrado', { status: 404 }); }
  if (!st.isFile()) return new Response('No encontrado', { status: 404 });
  const size = st.size;
  const headers = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache'
  };
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0, end = size - 1;
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    }
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}
function registerProtocol() {
  protocol.handle('brasa', async req => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname);
    if (p.startsWith('/media/')) {
      const t = tracks.get(p.slice(7));
      if (!t) return new Response('No encontrado', { status: 404 });
      if (u.searchParams.get('v') === 'c') return serveFile(req, cachedPath(t), 'audio/flac');
      return serveFile(req, t.path, MIME['.' + ext(t.path)]);
    }
    if (p.startsWith('/cover/')) {
      const name = path.basename(p);
      if (!/^[0-9a-f]{16}(-s)?\.jpg$/.test(name)) return new Response('No encontrado', { status: 404 });
      const r = await serveFile(req, path.join(DIR.covers(), name), 'image/jpeg');
      r.headers.set('Cache-Control', 'max-age=31536000, immutable');
      return r;
    }
    const file = path.normalize(path.join(RENDERER, p === '/' ? 'index.html' : p));
    if (!file.startsWith(RENDERER + path.sep)) return new Response('No encontrado', { status: 404 });
    return serveFile(req, file);
  });
}

/* ───────── IPC ───────── */
const AUDIO_FILTER = [{ name: 'Audio', extensions: [...AUDIO_EXT] }, { name: 'Todos los archivos', extensions: ['*'] }];
function registerIpc() {
  ipcMain.handle('lib:get', async () => ({
    tracks: [...tracks.values()], folders: store.folders, playlists: store.playlists || [],
    settings: store.settings || {}, session: store.session || {}, platform: process.platform,
    ffmpeg: await checkFfmpeg(), scan
  }));
  ipcMain.handle('lib:addFolders', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Añadir carpetas de música', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return null;
    return importPaths(r.filePaths);
  });
  ipcMain.handle('lib:addFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Añadir canciones', properties: ['openFile', 'multiSelections'], filters: AUDIO_FILTER });
    if (r.canceled || !r.filePaths.length) return null;
    return importPaths(r.filePaths);
  });
  ipcMain.handle('lib:importPaths', (e, paths) => importPaths((paths || []).filter(p => typeof p === 'string')));
  ipcMain.handle('lib:rescan', () => rescan());
  ipcMain.handle('lib:removeTracks', (e, ids) => {
    store.excluded = store.excluded || [];
    for (const id of ids || []) {
      const t = tracks.get(id); if (!t) continue;
      if (store.folders.some(f => underFolder(t.path, f))) store.excluded.push(t.path);
      tracks.delete(id);
    }
    saveStore(); return true;
  });
  ipcMain.handle('lib:removeFolder', (e, folder) => {
    store.folders = store.folders.filter(f => f !== folder);
    const gone = [];
    for (const t of tracks.values()) if (underFolder(t.path, folder)) gone.push(t.id);
    gone.forEach(id => tracks.delete(id));
    saveStore();
    return { folders: store.folders, removed: gone };
  });
  ipcMain.on('state:save', (e, part) => {
    if (part && typeof part === 'object') {
      for (const k of ['playlists', 'settings', 'session']) if (k in part) store[k] = part[k];
      saveStore();
    }
  });
  ipcMain.handle('media:prepare', async (e, id, force) => {
    const t = tracks.get(id);
    if (!t) return { error: 'La canción ya no está en la biblioteca.' };
    if (!(await exists(t.path))) return { error: 'No se encuentra el archivo. ¿Se ha movido o borrado?' };
    if (!force && !needsConvert(t)) return { url: `brasa://app/media/${id}?v=o`, converted: false };
    try {
      await convert(t);
      return { url: `brasa://app/media/${id}?v=c`, converted: true };
    } catch (er) {
      return { error: ffmpegOk === false ? 'Este formato necesita FFmpeg y no se encuentra.' : 'No se pudo convertir este archivo.' };
    }
  });
  ipcMain.handle('media:analyze', (e, id) => analyze(id));
  ipcMain.handle('media:duration', (e, id, d) => {
    const t = tracks.get(id);
    if (t && isFinite(d) && d > 0 && !t.duration) { t.duration = d; saveStore(); }
  });
  ipcMain.handle('lyrics:get', (e, id, online) => getLyrics(id, !!online));
  ipcMain.handle('lyrics:pick', async (e, id) => {
    const r = await dialog.showOpenDialog(win, { title: 'Elegir archivo de letra', properties: ['openFile'], filters: [{ name: 'Letras', extensions: ['lrc', 'txt'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    await fsp.mkdir(DIR.lyrics(), { recursive: true });
    await fsp.writeFile(path.join(DIR.lyrics(), id + '.lrc'), await readText(r.filePaths[0]));
    return getLyrics(id, false);
  });
  ipcMain.handle('pl:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Importar playlist', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const out = [];
    for (const file of r.filePaths) {
      const dir = path.dirname(file);
      const lines = (await readText(file)).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
      const paths = [];
      for (let l of lines) {
        if (/^file:\/\//i.test(l)) { try { l = require('node:url').fileURLToPath(l); } catch (er) { continue; } }
        else if (/^[a-z]+:\/\//i.test(l)) continue;
        const abs = path.isAbsolute(l) ? l : path.resolve(dir, l.replace(/[\\/]/g, path.sep));
        if (AUDIO_EXT.has(ext(abs)) && await exists(abs)) paths.push(abs);
      }
      const ids = enqueueFiles(paths);
      out.push({ name: path.basename(file, path.extname(file)), ids, missing: lines.length - paths.length });
    }
    await waitScan();
    return out.map(o => ({ ...o, ids: o.ids.filter(id => tracks.has(id)) }));
  });
  ipcMain.handle('pl:export', async (e, name, ids) => {
    const safe = String(name || 'Playlist').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(win, { title: 'Exportar playlist', defaultPath: safe + '.m3u8', filters: [{ name: 'Playlist M3U', extensions: ['m3u8'] }] });
    if (r.canceled || !r.filePath) return false;
    const body = ['#EXTM3U', `#PLAYLIST:${name}`];
    for (const id of ids || []) {
      const t = tracks.get(id); if (!t) continue;
      body.push(`#EXTINF:${Math.round(t.duration || -1)},${t.artist ? t.artist + ' - ' : ''}${t.title}`, t.path);
    }
    await fsp.writeFile(r.filePath, body.join('\n') + '\n', 'utf8');
    return true;
  });
  ipcMain.handle('shell:show', (e, id) => { const t = tracks.get(id); if (t) shell.showItemInFolder(t.path); });
  ipcMain.handle('cache:info', async () => (await cacheEntries()).reduce((s, x) => s + x.size, 0));
  ipcMain.handle('cache:clear', async () => { await fsp.rm(DIR.cache(), { recursive: true, force: true }); return true; });
  ipcMain.handle('win:theme', (e, src) => { if (['system', 'light', 'dark'].includes(src)) nativeTheme.themeSource = src; });
  ipcMain.on('win:overlay', (e, o) => {
    if (!win || process.platform === 'darwin' || !win.setTitleBarOverlay) return;
    try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: o.symbolColor, height: 44 }); } catch (er) { /* */ }
  });
}

/* ───────── abrir archivos desde el sistema ───────── */
const pendingOpen = [];
function argvAudio(argv) {
  return argv.slice(1).filter(a => !a.startsWith('-') && AUDIO_EXT.has(ext(a)) && fs.existsSync(a)).map(a => path.resolve(a));
}
async function openExternal(paths) {
  if (!paths.length) return;
  if (!win) { pendingOpen.push(...paths); return; }
  const files = [];
  for (const p of paths) if (AUDIO_EXT.has(ext(p))) files.push(p);
  const ids = enqueueFiles(files);
  await waitScan();
  send('app:open', ids.filter(id => tracks.has(id)));
  if (win.isMinimized()) win.restore();
  win.focus();
}

/* ───────── ventana ───────── */
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 420, minHeight: 560, show: false, title: 'Brasa',
    backgroundColor: dark ? '#1d1315' : '#fbd8c2',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: dark ? '#f7e6dc' : '#3a2420', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('brasa://')) e.preventDefault(); });
  win.loadURL('brasa://app/index.html');
  win.webContents.once('did-finish-load', () => {
    if (pendingOpen.length) { const p = pendingOpen.splice(0); setTimeout(() => openExternal(p), 600); }
    if (store.folders.length) setTimeout(() => rescan().catch(() => {}), 1500);
  });
  win.on('closed', () => { win = null; });
}

const gotLock = process.env.BRASA_TEST ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (e, argv) => openExternal(argvAudio(argv)));
  app.on('open-file', (e, p) => { e.preventDefault(); openExternal([p]); });
  pendingOpen.push(...argvAudio(process.argv));
  app.whenReady().then(async () => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    await loadStore();
    registerProtocol();
    registerIpc();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let flushed = false;
  app.on('before-quit', e => {
    if (flushed || !saveTimer) return;
    e.preventDefault();
    flushStore().finally(() => { flushed = true; app.quit(); });
  });
}

module.exports = { importPaths, waitScan, get win() { return win; } };
