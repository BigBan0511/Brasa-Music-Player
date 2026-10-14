// Motor de audio de Brasa.
// Dos "platos" (elementos <audio> conectados a Web Audio) que se alternan: mientras uno suena,
// el otro precarga la siguiente canción, lo que permite fundidos cruzados y cambios sin silencio.
// Cadena: plato (nivelación → fundido) → preamp → 10 filtros → [limitador] → volumen → analizador → salida
export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const dbToGain = db => Math.pow(10, db / 20);

export function createEngine({ api, S, gainFor, onEnded, onError, onLoading, onDuration }) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'playback' });
  const preamp = ctx.createGain();
  const mkFilter = (f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0;
    return b;
  };
  const filters = BANDS.map(mkFilter);
  const curveFilters = BANDS.map(mkFilter); // copia desconectada, solo para dibujar la curva
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.25;
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.78;
  preamp.connect(filters[0]);
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  const lastF = filters[filters.length - 1];
  limiter.connect(master); master.connect(analyser); analyser.connect(ctx.destination);
  function applyLimiter() { try { lastF.disconnect(); } catch (e) { /* */ } lastF.connect(S.limiter ? limiter : master); }
  applyLimiter();

  let A = 0, playing = false, playToken = 0;

  function makeDeck() {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const src = ctx.createMediaElementSource(el);
    const trim = ctx.createGain(), fade = ctx.createGain();
    fade.gain.value = 0;
    src.connect(trim); trim.connect(fade); fade.connect(preamp);
    const d = { el, trim, fade, track: null, ready: false, converted: false, timer: null, busyUntil: 0, pending: null };
    el.addEventListener('ended', () => { if (d === decks[A] && playing) onEnded(); });
    el.addEventListener('error', () => {
      const err = el.error;
      console.warn('[brasa] error de audio', d.track && d.track.title, err && err.code, err && err.message, 'activo:', d === decks[A], 'listo:', d.ready);
      if (d === decks[A] && playing && d.ready) onError(d.track, el.currentTime || 0, d.converted);
    });
    el.addEventListener('durationchange', () => { if (d.track && isFinite(el.duration) && el.duration > 0) onDuration(d.track, el.duration); });
    return d;
  }
  const decks = [makeDeck(), makeDeck()];
  const active = () => decks[A];

  /* fundidos */
  function hold(p) {
    const at = ctx.currentTime, cur = p.value;
    if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(at); } catch (e) { p.cancelScheduledValues(at); } } else p.cancelScheduledValues(at);
    p.setValueAtTime(cur, at);
    return cur;
  }
  function ramp(p, to, dur, from) {
    const at = ctx.currentTime, cur = hold(p);
    if (from == null) from = cur;
    p.setValueAtTime(from, at);
    if (!(dur > 0.015)) { p.setValueAtTime(to, at); return; }
    if (S.curve === 'linear') { p.linearRampToValueAtTime(to, at + dur); return; }
    const n = 24;
    for (let i = 1; i <= n; i++) {
      const x = i / n;
      const v = to >= from ? from + (to - from) * Math.sin(x * Math.PI / 2) : to + (from - to) * Math.cos(x * Math.PI / 2);
      p.linearRampToValueAtTime(v, at + dur * x);
    }
  }
  function fadeOutAndPause(d, dur, alreadyRamped) {
    if (!alreadyRamped) ramp(d.fade.gain, 0, dur);
    clearTimeout(d.timer);
    d.busyUntil = performance.now() + dur * 1000 + 80;
    d.timer = setTimeout(() => { d.timer = null; d.el.pause(); }, dur * 1000 + 50);
  }
  function hardStop(d) {
    clearTimeout(d.timer); d.timer = null;
    hold(d.fade.gain); d.fade.gain.setValueAtTime(0, ctx.currentTime);
    d.el.pause(); d.busyUntil = 0;
  }

  /* carga */
  function setSrc(d, url) {
    return new Promise((resolve, reject) => {
      const el = d.el;
      const ok = () => { off(); resolve(); };
      const bad = () => { off(); reject(new Error('media')); };
      const off = () => { el.removeEventListener('canplay', ok); el.removeEventListener('error', bad); };
      el.addEventListener('canplay', ok);
      el.addEventListener('error', bad);
      el.src = url;
      el.load();
    });
  }
  const SUPERSEDED = 'superseded';
  async function loadInto(d, track, force) {
    const seq = d.seq = (d.seq || 0) + 1;
    const check = () => { if (d.seq !== seq) throw new Error(SUPERSEDED); };
    d.ready = false; d.track = track;
    let r = await api.prepare(track.id, force);
    check();
    if (r.error) throw new Error(r.error);
    try { await setSrc(d, r.url); check(); }
    catch (e) {
      if (e.message === SUPERSEDED) throw e;
      check();
      if (r.converted) throw new Error('No se pudo reproducir este archivo.');
      r = await api.prepare(track.id, true); // el navegador no lo entiende: se convierte con FFmpeg
      check();
      if (r.error) throw new Error(r.error);
      await setSrc(d, r.url); check();
    }
    d.converted = r.converted;
    d.ready = true;
  }
  function ensureLoaded(d, track, force) {
    if (!force && d.ready && d.track && d.track.id === track.id) return Promise.resolve();
    if (!force && d.pending && d.pending.id === track.id) return d.pending.promise;
    const promise = loadInto(d, track, force).finally(() => { if (d.pending && d.pending.promise === promise) d.pending = null; });
    d.pending = { id: track.id, promise };
    return promise;
  }
  function setTrim(d, track, smooth) {
    const g = dbToGain(S.level ? (gainFor(track) || 0) : 0);
    if (smooth) d.trim.gain.setTargetAtTime(g, ctx.currentTime, 0.4);
    else { hold(d.trim.gain); d.trim.gain.setValueAtTime(g, ctx.currentTime); }
  }

  /* API pública */
  async function play(track, { offset = 0, cross = 0, fade = null, force = false } = {}) {
    const token = ++playToken;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const nd = decks[1 - A], od = decks[A];
    const reuse = !force && nd.ready && nd.track && nd.track.id === track.id && !(nd.pending && nd.pending.id !== track.id);
    if (!reuse) {
      if (!(nd.pending && nd.pending.id === track.id) || force) hardStop(nd);
      onLoading(true);
      try { await ensureLoaded(nd, track, force); }
      catch (e) {
        if (token === playToken && e.message !== SUPERSEDED) { nd.ready = false; nd.track = null; throw e; }
        return false;
      } finally { if (token === playToken) onLoading(false); }
      if (token !== playToken) return false;
    }
    clearTimeout(nd.timer); nd.timer = null;
    try { if (Math.abs(nd.el.currentTime - offset) > 0.01) nd.el.currentTime = offset; } catch (e) { /* */ }
    setTrim(nd, track);
    hold(nd.fade.gain); nd.fade.gain.setValueAtTime(0, ctx.currentTime);
    try { await nd.el.play(); }
    catch (e) { if (token !== playToken) return false; throw new Error('No se pudo empezar la reproducción.'); }
    if (token !== playToken) { nd.el.pause(); return false; }
    if (cross > 0 && playing && od.track && !od.el.paused) {
      ramp(nd.fade.gain, 1, cross, 0);
      ramp(od.fade.gain, 0, cross);
      fadeOutAndPause(od, cross, true);
    } else {
      if (od.track && !od.el.paused) fadeOutAndPause(od, 0.06);
      ramp(nd.fade.gain, 1, fade != null ? fade : S.fadeIn, 0);
    }
    A = 1 - A; playing = true;
    return true;
  }
  function pause() {
    if (!playing) return;
    playing = false; playToken++;
    fadeOutAndPause(decks[A], S.pauseFade);
    const o = decks[1 - A];
    if (!o.el.paused) fadeOutAndPause(o, 0.05);
  }
  function resume() {
    const d = decks[A];
    if (playing || !d.ready) return false;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    clearTimeout(d.timer); d.timer = null;
    d.el.play().catch(() => {});
    ramp(d.fade.gain, 1, Math.max(0.2, S.pauseFade));
    playing = true;
    return true;
  }
  function seek(sec) {
    const d = decks[A];
    if (!d.ready) return;
    const dur = duration();
    // algunos demuxers fallan si se busca en las últimas décimas del archivo
    sec = Math.max(0, Math.min(sec, Math.max(0, dur - 0.6)));
    if (!playing) { d.el.currentTime = sec; return; }
    const o = decks[1 - A];
    if (!o.el.paused) fadeOutAndPause(o, 0.04);
    ramp(d.fade.gain, 0, 0.03);
    d.seekTarget = sec;
    clearTimeout(d.seekTimer);
    d.seekTimer = setTimeout(() => {
      d.seekTarget = null;
      if (d !== decks[A]) return;
      d.el.currentTime = sec;
      if (playing) ramp(d.fade.gain, 1, 0.12, 0);
    }, 35);
  }
  function preload(track) {
    const nd = decks[1 - A];
    if (nd.ready && nd.track && nd.track.id === track.id) return;
    if (nd.pending) return;
    if (performance.now() < nd.busyUntil || !nd.el.paused) return;
    ensureLoaded(nd, track).catch(e => { if (e.message !== SUPERSEDED && nd.track === track) { nd.ready = false; nd.track = null; } });
  }
  const readyFor = id => { const nd = decks[1 - A]; return nd.ready && nd.track && nd.track.id === id; };
  function duration() {
    const d = decks[A];
    if (isFinite(d.el.duration) && d.el.duration > 0) return d.el.duration;
    return (d.track && d.track.duration) || 0;
  }
  function position() { const d = decks[A]; return d.ready ? (d.seekTarget != null ? d.seekTarget : d.el.currentTime) : 0; }
  function stopAll() {
    playToken++; playing = false;
    decks.forEach(d => { if (!d.el.paused) fadeOutAndPause(d, 0.08); });
  }
  function forget() { // tras vaciar la biblioteca
    stopAll();
    decks.forEach(d => { d.track = null; d.ready = false; d.pending = null; d.el.removeAttribute('src'); d.el.load(); });
  }
  function updateTrim(id) { decks.forEach(d => { if (d.track && (!id || d.track.id === id)) setTrim(d, d.track, true); }); }
  function setVolume(v) { master.gain.setTargetAtTime(v * v, ctx.currentTime, 0.02); }
  function applyEQ() {
    const at = ctx.currentTime;
    filters.forEach((f, i) => f.gain.setTargetAtTime(S.eqOn ? S.eq[i] : 0, at, 0.03));
    preamp.gain.setTargetAtTime(S.eqOn ? dbToGain(S.preamp) : 1, at, 0.03);
    curveFilters.forEach((f, i) => { f.gain.value = S.eq[i]; });
  }

  return {
    ctx, analyser, curveFilters, applyLimiter, applyEQ, setVolume, updateTrim,
    play, pause, resume, seek, preload, readyFor, duration, position, stopAll, forget,
    isPlaying: () => playing,
    activeTrack: () => decks[A].track,
    activeReady: () => decks[A].ready,
    activeConverted: () => decks[A].converted
  };
}
