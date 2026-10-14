// Extrae de una carátula los números que tiñen toda la interfaz:
//   h  → tono dominante (OKLCH, grados)
//   h2 → segundo tono, para los degradados
//   c  → cuánto color tiene la portada (0 = gris, 1 = muy saturada)
export const DEFAULT_PALETTE = { h: 52, h2: 12, c: 1 };

const cache = new Map();
const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

function oklab(r, g, b) {
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

export async function paletteFor(url) {
  if (!url) return DEFAULT_PALETTE;
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const N = 56;
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data;
    const B = 24, w = new Float64Array(B), sx = new Float64Array(B), sy = new Float64Array(B);
    let totalC = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const [L, a, b] = oklab(d[i], d[i + 1], d[i + 2]);
      const C = Math.hypot(a, b);
      n++; totalC += C;
      if (C < 0.025) continue;
      const lw = L < 0.22 ? 0.25 : L > 0.94 ? 0.35 : 1;
      const wt = C * C * lw;
      let h = Math.atan2(b, a); if (h < 0) h += Math.PI * 2;
      const k = Math.floor(h / (Math.PI * 2) * B) % B;
      w[k] += wt; sx[k] += Math.cos(h) * wt; sy[k] += Math.sin(h) * wt;
    }
    if (!n) return DEFAULT_PALETTE;
    const score = k => w[(k + B - 1) % B] * 0.5 + w[k] + w[(k + 1) % B] * 0.5;
    const hueOf = k => {
      let x = 0, y = 0;
      for (const j of [k - 1, k, k + 1]) { const q = (j + B) % B; x += sx[q]; y += sy[q]; }
      let deg = Math.atan2(y, x) * 180 / Math.PI; if (deg < 0) deg += 360;
      return deg;
    };
    let k1 = 0; for (let k = 1; k < B; k++) if (score(k) > score(k1)) k1 = k;
    const avgC = totalC / n;
    const c = Math.max(0.16, Math.min(1, (avgC - 0.012) / 0.085));
    if (!score(k1)) return { h: DEFAULT_PALETTE.h, h2: DEFAULT_PALETTE.h2, c: 0.16 };
    const h = hueOf(k1);
    let k2 = -1;
    for (let k = 0; k < B; k++) {
      const dist = Math.min(Math.abs(k - k1), B - Math.abs(k - k1));
      if (dist >= 3 && (k2 < 0 || score(k) > score(k2))) k2 = k;
    }
    let h2 = k2 >= 0 && score(k2) > score(k1) * 0.22 ? hueOf(k2) : h - 38;
    // si el segundo tono está muy lejos, se acerca para que el degradado no resulte chillón
    let diff = ((h2 - h + 540) % 360) - 180;
    if (Math.abs(diff) > 70) diff = Math.sign(diff) * 70;
    h2 = (h + diff + 360) % 360;
    return { h, h2, c };
  })().catch(() => DEFAULT_PALETTE);
  cache.set(url, p);
  return p;
}

// Transición suave entre paletas (por el camino corto del círculo de tonos)
let cur = { ...DEFAULT_PALETTE }, raf = 0;
const root = document.documentElement;
function set(p) {
  root.style.setProperty('--h', p.h.toFixed(2));
  root.style.setProperty('--h2', p.h2.toFixed(2));
  root.style.setProperty('--c', p.c.toFixed(3));
}
export function applyPalette(target, onFrame, ms = 1100) {
  cancelAnimationFrame(raf);
  const from = { ...cur };
  const dh = ((target.h - from.h + 540) % 360) - 180;
  const dh2 = ((target.h2 - from.h2 + 540) % 360) - 180;
  const t0 = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const step = now => {
    const x = reduce ? 1 : Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - x, 3);
    cur = { h: (from.h + dh * e + 360) % 360, h2: (from.h2 + dh2 * e + 360) % 360, c: from.c + (target.c - from.c) * e };
    set(cur);
    onFrame && onFrame(x >= 1);
    if (x < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
set(cur);
