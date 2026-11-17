// Gemeinsame Höhenkarten-Verarbeitung: Glättung, Pegel, Gamma, Invertierung, Stufen,
// Formmaske, Hintergrund, Histogramm und PNG-Export (mit DPI-Angabe).
import { zlibSync } from 'three/addons/libs/fflate.module.js';

/* ------------------------------------------------------------------ */
/* Glättung (Gauß-Näherung über 3 Box-Filter, Laufzeit unabhängig vom Radius) */

function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxBlurH(s, d, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = r * s[row];
    for (let x = 0; x < r; x++) acc += s[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += s[row + Math.min(x + r, w - 1)];
      d[row + x] = acc * iarr;
      acc -= s[row + Math.max(x - r, 0)];
    }
  }
}

function boxBlurV(s, d, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = r * s[x];
    for (let y = 0; y < r; y++) acc += s[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += s[Math.min(y + r, h - 1) * w + x];
      d[y * w + x] = acc * iarr;
      acc -= s[Math.max(y - r, 0) * w + x];
    }
  }
}

export function gaussBlur(data, w, h, sigma) {
  const a = Float32Array.from(data);
  if (!(sigma > 0.25)) return a;
  const b = new Float32Array(a.length);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return a;
}

/** Glättung nur innerhalb des Objekts (Hintergrund „blutet“ nicht in die Kanten). */
export function maskedBlur(height, alpha, w, h, sigma) {
  if (!(sigma > 0.25)) return height;
  const n = w * h;
  const num = new Float32Array(n);
  for (let i = 0; i < n; i++) num[i] = height[i] * alpha[i];
  const bn = gaussBlur(num, w, h, sigma);
  const ba = gaussBlur(alpha, w, h, sigma);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ba[i] > 1e-4 ? bn[i] / ba[i] : height[i];
  return out;
}

/* ------------------------------------------------------------------ */
/* Euklidische Distanztransformation (Felzenszwalb & Huttenlocher) */

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]) k--; else break;
    } while (k >= 0);
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/** Abstand (in Pixeln) jedes Objektpixels zum nächsten Hintergrundpixel; Bildrand zählt als Hintergrund. */
export function distanceToEdge(mask, w, h) {
  const W = w + 2, H = h + 2, INF = 1e20;
  const g = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x > 0 && y > 0 && x <= w && y <= h && mask[(y - 1) * w + (x - 1)];
    g[y * W + x] = inside ? INF : 0;
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(g[(y + 1) * W + x + 1]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Formmaske (Kreis / abgerundetes Rechteck) */

export function shapeMask(w, h, shape, cornerPct = 15) {
  const m = new Uint8Array(w * h);
  if (shape === 'circle') {
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2, r2 = r * r;
    for (let y = 0; y < h; y++) {
      const dy = y + 0.5 - cy;
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx;
        m[y * w + x] = dx * dx + dy * dy <= r2 ? 1 : 0;
      }
    }
  } else if (shape === 'rounded') {
    const r = Math.min(w, h) * Math.min(50, Math.max(0, cornerPct)) / 100;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5, py = y + 0.5;
        const qx = Math.max(r - px, 0, px - (w - r));
        const qy = Math.max(r - py, 0, py - (h - r));
        m[y * w + x] = (qx * qx + qy * qy) <= r * r ? 1 : 0;
      }
    }
  } else {
    m.fill(1);
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Haupt-Pipeline */

export const GRAY_DEFAULTS = {
  invert: false,
  black: 0,        // Schwarzpunkt in % der Rohhöhe
  white: 100,      // Weißpunkt in % der Rohhöhe
  gamma: 1,
  blurMm: 0,       // Glättung in mm
  steps: 256,      // Graustufen
  outMin: 0,       // tiefster Grauwert
  outMax: 255,     // höchster Grauwert
  mirrorX: false,
  mirrorY: false,
  softEdges: false,
};

/**
 * src: { w, h, height: Float32Array (0..1, 1 = höchster Punkt), alpha: Float32Array (0..1) }
 * o:   Graustufen- und Ausgabe-Optionen
 * pxPerMm: Auflösung, um mm-Angaben in Pixel umzurechnen
 */
export function processHeight(src, o, pxPerMm) {
  const { w, h } = src;
  const n = w * h;
  let H = src.height;
  const A = src.alpha;

  const sigma = (o.blurMm || 0) * pxPerMm;
  if (sigma > 0.25) H = maskedBlur(H, A, w, h, sigma);

  const lo = Math.min(o.black, o.white - 0.5) / 100;
  const hi = Math.max(o.white, o.black + 0.5) / 100;
  const span = hi - lo;
  const invG = 1 / Math.max(0.05, o.gamma);
  const steps = Math.max(2, Math.min(256, o.steps | 0));
  const qs = steps - 1;
  const outMin = Math.min(o.outMin, o.outMax), outMax = Math.max(o.outMin, o.outMax);
  const outSpan = outMax - outMin;

  const shape = shapeMask(w, h, o.shape, o.corner);
  const rgba = new Uint8ClampedArray(n * 4);
  const hist = new Uint32Array(256);
  let objCount = 0, gMin = 255, gMax = 0;

  const bgGray = o.bg === 'white' ? 255 : o.bg === 'black' ? 0 : -1;

  for (let y = 0; y < h; y++) {
    const sy = o.mirrorY ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const di = y * w + x;
      const si = sy * w + (o.mirrorX ? w - 1 - x : x);
      const p = di * 4;
      if (!shape[di]) { // außerhalb der Form: immer transparent
        rgba[p] = rgba[p + 1] = rgba[p + 2] = 255; rgba[p + 3] = 0;
        continue;
      }
      let a = A[si];
      if (!o.softEdges) a = a >= 0.5 ? 1 : 0;
      if (a <= 0) {
        if (bgGray < 0) { rgba[p] = rgba[p + 1] = rgba[p + 2] = 255; rgba[p + 3] = 0; }
        else { rgba[p] = rgba[p + 1] = rgba[p + 2] = bgGray; rgba[p + 3] = 255; }
        continue;
      }
      let t = (H[si] - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (invG !== 1) t = Math.pow(t, invG);
      if (o.invert) t = 1 - t;
      if (steps < 256) t = Math.round(t * qs) / qs;
      const g = Math.round(outMin + t * outSpan);
      if (a < 1 && bgGray >= 0) {
        // weiche Kante auf deckendem Hintergrund: mischen
        const m = Math.round(g * a + bgGray * (1 - a));
        rgba[p] = rgba[p + 1] = rgba[p + 2] = m; rgba[p + 3] = 255;
      } else {
        rgba[p] = rgba[p + 1] = rgba[p + 2] = g;
        rgba[p + 3] = Math.round(a * 255);
      }
      hist[g]++; objCount++;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
    }
  }
  return { w, h, rgba, shape, hist, objCount, gMin, gMax };
}

/** Perzentile der Rohhöhe (für Auto-Pegel) */
export function heightPercentiles(src, pLo = 0.005, pHi = 0.995) {
  const bins = new Uint32Array(1024);
  let n = 0;
  for (let i = 0; i < src.height.length; i++) {
    if (src.alpha[i] < 0.5) continue;
    const v = Math.min(1023, Math.max(0, Math.round(src.height[i] * 1023)));
    bins[v]++; n++;
  }
  if (!n) return [0, 100];
  const find = q => {
    let acc = 0; const target = q * n;
    for (let i = 0; i < 1024; i++) { acc += bins[i]; if (acc >= target) return i / 1023; }
    return 1;
  };
  return [find(pLo) * 100, find(pHi) * 100];
}

/* ------------------------------------------------------------------ */
/* Anzeige */

export function drawResult(container, result) {
  let cv = container.querySelector('canvas');
  if (!cv) {
    container.innerHTML = '';
    cv = document.createElement('canvas');
    container.append(cv);
  }
  cv.width = result.w; cv.height = result.h;
  cv.getContext('2d').putImageData(new ImageData(result.rgba, result.w, result.h), 0, 0);
  container.style.aspectRatio = `${result.w} / ${result.h}`;
  // Sehr flache oder hohe Formate begrenzen
  if (result.w / result.h < 0.6) container.style.aspectRatio = '0.6';
}

export function drawHistogram(canvas, result) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Grauverlauf als Achse
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - 8, W, 8);
  if (!result || !result.objCount) return;
  let max = 0;
  for (let i = 0; i < 256; i++) max = Math.max(max, result.hist[i]);
  const bw = W / 256;
  ctx.fillStyle = '#d9a441';
  for (let i = 0; i < 256; i++) {
    if (!result.hist[i]) continue;
    // Wurzel-Skalierung, damit kleine Werte sichtbar bleiben
    const v = Math.sqrt(result.hist[i] / max);
    const bh = Math.max(1, v * (H - 12));
    ctx.fillRect(i * bw, H - 10 - bh, Math.max(1, bw - 0.3), bh);
  }
}

/* ------------------------------------------------------------------ */
/* PNG-Export: echtes RGBA-PNG mit pHYs-Chunk (DPI), damit die Größe in mm stimmt.
   Transparente Pixel behalten Weiß als Farbwert – Programme, die Alpha ignorieren,
   gravieren dort also nichts. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export function encodePNG(rgba, w, h, dpi) {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  // Filter "Paeth" je Zeile – gute Kompression bei Verläufen
  for (let y = 0; y < h; y++) {
    const ro = y * (stride + 1);
    raw[ro] = 4;
    const cur = y * stride, prev = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[cur + i - 4] : 0;
      const b = y > 0 ? rgba[prev + i] : 0;
      const c = (y > 0 && i >= 4) ? rgba[prev + i - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      raw[ro + 1 + i] = (rgba[cur + i] - pred) & 0xff;
    }
  }
  const idat = zlibSync(raw, { level: 6 });

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8;  // Bittiefe
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const phys = new Uint8Array(9);
  const ppm = Math.round(dpi / 0.0254);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, ppm); pv.setUint32(4, ppm); phys[8] = 1; // Einheit: Meter

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('pHYs', phys), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function exportPNG(result, filename, dpi) {
  const png = encodePNG(result.rgba, result.w, result.h, dpi);
  downloadBlob(new Blob([png], { type: 'image/png' }), filename);
}

export function safeBase(name) {
  return (name || 'depthmap').replace(/\.[^.]+$/, '').replace(/[^\w\-äöüÄÖÜß]+/g, '_').slice(0, 60) || 'depthmap';
}
