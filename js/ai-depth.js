// KI-Tiefenschätzung aus einem einzelnen Foto (monokulare Depth Estimation).
//
// Modelle: Depth Anything V2 Small (schnell, auch Handy) und Depth Anything 3 Mono Large (beste Details, PC).
// Beide Apache-2.0. Sie laufen über ONNX Runtime Web direkt im Browser – per WebGPU (Grafikkarte) oder
// WebAssembly (Prozessor). Das Foto verlässt den Rechner nicht. Modelle werden beim ersten Mal von
// Hugging Face geladen und dauerhaft im Browser gespeichert (Cache Storage), danach nie wieder geladen.
//
// Speicherbedarf: Die Modelle sind Vision-Transformer (Patch 14 px). Die größten Zwischenpuffer wachsen
// mit dem QUADRAT der Patch-Anzahl. Die Arbeitsauflösung wird daher an die Grenzen des Geräts angepasst
// und bei Fehlern automatisch stufenweise reduziert.

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.bundle.min.mjs';
const HF = 'https://huggingface.co/';
const CACHE_NAME = 'depthmapper-models-v1';
const PATCH = 14;
const MIN_RES = 252;

/**
 * Modell-Katalog.
 * mode: 'flex' (beliebiges Seitenverhältnis, Vielfache von 14), 'square' (feste quadratische Größen)
 * out:  'disp' = größer ist näher, 'depth' = größer ist weiter weg
 * files: gpu16 = WebGPU mit FP16, gpu32 = WebGPU ohne FP16, cpu = WebAssembly
 */
export const MODELS = {
  da2s: {
    name: 'Depth Anything V2 Small', vendor: 'TikTok / HKU', license: 'Apache-2.0 (frei, auch kommerziell)',
    pcOnly: false, mode: 'flex', heads: 6, norm: 'imagenet', layout: 'nchw', out: 'disp',
    files: {
      gpu16: { url: HF + 'onnx-community/depth-anything-v2-small/resolve/main/onnx/model_fp16.onnx', mb: 50 },
      gpu32: { url: HF + 'onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx', mb: 99 },
      cpu: { url: HF + 'onnx-community/depth-anything-v2-small/resolve/main/onnx/model_fp16.onnx', mb: 50 },
    },
    note: 'Schnell, läuft auch am Handy. Gute Allround-Qualität.',
  },
  da3ml: {
    name: 'Depth Anything 3 Mono Large', vendor: 'ByteDance', license: 'Apache-2.0 (frei, auch kommerziell)',
    pcOnly: true, mode: 'square', sizes: [252, 364, 518, 728, 1036], heads: 16, norm: 'imagenet', layout: 'nchw', out: 'disp',
    files: {
      gpu16: { url: HF + 'Jens-Duttke/Depth-Anything-3-MONO-ONNX/resolve/main/da-v3-mono-large_q4f16_opset21_optimized.onnx', mb: 353 },
      cpu: { url: HF + 'Jens-Duttke/Depth-Anything-3-MONO-ONNX/resolve/main/da-v3-mono-large_q4f16_opset21_optimized.onnx', mb: 353 },
    },
    note: 'Beste Gesichts- und Formdetails im Test. Empfohlen am PC.',
  },
};

export const isMobile = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);

/* ------------------------------------------------------------------ */
/* Laufzeit & Gerät */

let ortPromise = null;
let gpuInfo = null;       // { f16, budget } oder false
let active = null;        // { key, device, file, session }

function loadORT() {
  if (!ortPromise) {
    ortPromise = import(ORT_URL).then(ort => {
      ort.env.logLevel = 'error';
      return ort;
    }).catch(err => { ortPromise = null; throw err; });
  }
  return ortPromise;
}

async function detectGPU() {
  if (gpuInfo !== null) return gpuInfo;
  gpuInfo = false;
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const lim = Math.min(adapter.limits.maxBufferSize || 256e6, adapter.limits.maxStorageBufferBindingSize || 128e6);
        gpuInfo = { f16: adapter.features.has('shader-f16'), budget: Math.min(lim * 0.85, isMobile() ? 220e6 : 2e9) };
      }
    } catch { /* kein WebGPU */ }
  }
  return gpuInfo;
}

function cpuBudget() {
  const mem = navigator.deviceMemory || (isMobile() ? 3 : 8);
  if (isMobile()) return mem <= 3 ? 100e6 : mem <= 4 ? 150e6 : 220e6;
  return mem <= 4 ? 400e6 : 900e6;
}

/** Datei + Gerät für ein Modell wählen */
async function plan(model, forceCPU) {
  const gpu = forceCPU ? false : await detectGPU();
  const f = model.files;
  if (gpu) {
    if (f.any) return { device: 'webgpu', file: f.any, half: false, budget: gpu.budget };
    if (gpu.f16 && f.gpu16) return { device: 'webgpu', file: f.gpu16, half: true, budget: gpu.budget };
    if (f.gpu32) return { device: 'webgpu', file: f.gpu32, half: false, budget: gpu.budget };
  }
  return { device: 'wasm', file: f.any || f.cpu, half: false, budget: cpuBudget() };
}

/** Dateigröße (MB) des Modells, das auf diesem Gerät geladen würde */
export async function modelDownloadMB(key) {
  const p = await plan(MODELS[key], false);
  return p.file.mb;
}

/* ------------------------------------------------------------------ */
/* Dauerhafter Modell-Speicher (Cache Storage) */

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}

export async function isCached(key) {
  const cache = await openCache();
  if (!cache) return false;
  const p = await plan(MODELS[key], false);
  return !!(await cache.match(p.file.url));
}

export async function storageInfo() {
  const cache = await openCache();
  let count = 0;
  if (cache) count = (await cache.keys()).length;
  let usage = 0;
  try { usage = (await navigator.storage.estimate()).usage || 0; } catch { /* egal */ }
  return { count, usageMB: usage / 1e6 };
}

export async function clearModelCache() {
  if (active) { try { await active.session.release(); } catch { /* egal */ } active = null; }
  try { await caches.delete(CACHE_NAME); } catch { /* egal */ }
  // Reste älterer Versionen (Transformers.js-Cache) ebenfalls entfernen
  try { await caches.delete('transformers-cache'); } catch { /* egal */ }
}

async function fetchModel(url, progress) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      progress?.({ status: 'cached' });
      return new Uint8Array(await hit.arrayBuffer());
    }
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let buf;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      progress?.({ status: 'download', loaded, total });
    }
    buf = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
  } else {
    buf = new Uint8Array(await res.arrayBuffer());
  }
  if (cache) {
    try {
      await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
      // Browser bitten, den Speicher nicht automatisch zu leeren
      try { await navigator.storage?.persist?.(); } catch { /* egal */ }
    } catch (err) {
      console.warn('Modell konnte nicht dauerhaft gespeichert werden (Speicher voll?):', err);
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* Sitzung */

async function getSession(key, progress, forceCPU = false) {
  const model = MODELS[key];
  const p = await plan(model, forceCPU);
  if (active && active.key === key && active.file.url === p.file.url && active.device === p.device) return active;
  if (active) { try { await active.session.release(); } catch { /* egal */ } active = null; }
  progress?.({ status: 'lib' });
  const ort = await loadORT();
  const bytes = await fetchModel(p.file.url, progress);
  progress?.({ status: 'init' });
  await new Promise(r => setTimeout(r, 30));
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [p.device === 'webgpu' ? 'webgpu' : 'wasm'],
    graphOptimizationLevel: 'all',
  });
  const meta = session.inputMetadata?.[0];
  const inF16 = meta?.type === 'float16';
  active = { key, ort, session, device: p.device, file: p.file, half: p.half, budget: p.budget, inF16 };
  return active;
}

/* ------------------------------------------------------------------ */
/* Größenplanung */

function sizeFor(w, h, res) {
  const k = res / Math.max(w, h);
  return {
    width: Math.max(PATCH, Math.round(w * k / PATCH) * PATCH),
    height: Math.max(PATCH, Math.round(h * k / PATCH) * PATCH),
  };
}
const attnBytes = (tokens, heads, half) => (tokens + 1) * (tokens + 1) * heads * (half ? 2 : 4);
const tokensOf = s => (s.width / PATCH) * (s.height / PATCH);

/** Konkrete Eingabe für eine gewünschte Auflösung ermitteln (passend zum Speicherbudget). */
function planInput(model, w, h, res, half, budget) {
  const limit = Number(globalThis.DEPTHMAPPER_AI_BUDGET) || budget; // für Tests überschreibbar
  if (model.mode === 'square') {
    const target = model.sizes.filter(s => s <= Math.max(res, model.sizes[0]));
    for (let i = target.length - 1; i >= 0; i--) {
      const s = target[i];
      if (i === 0 || attnBytes((s / PATCH) ** 2, model.heads, half) <= limit) return { size: { width: s, height: s }, res: s };
    }
  }
  // flex
  let r = res;
  while (r > MIN_RES && attnBytes(tokensOf(sizeFor(w, h, r)), model.heads, half) > limit) r -= PATCH;
  r = Math.max(MIN_RES, r);
  return { size: sizeFor(w, h, r), res: r };
}

function smaller(model, w, h, cur) {
  if (model.mode === 'square') {
    const i = model.sizes.indexOf(cur.size.width);
    return i > 0 ? { size: { width: model.sizes[i - 1], height: model.sizes[i - 1] }, res: model.sizes[i - 1] } : null;
  }
  if (cur.res <= MIN_RES + PATCH) return null;
  const r = Math.max(MIN_RES, Math.round(cur.res * 0.75 / PATCH) * PATCH);
  return { size: sizeFor(w, h, r), res: r };
}

/* ------------------------------------------------------------------ */
/* Vor-/Nachverarbeitung */

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const s = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  const m = x & 0x7fffff;
  if (e <= 0) return s;
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | (m >>> 13);
}
function fromHalf(hv) {
  const s = hv & 0x8000 ? -1 : 1, e = (hv >> 10) & 0x1f, m = hv & 0x3ff;
  if (e === 0) return s * 6.103515625e-5 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}
function toFloat32(data) {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) { const o = new Float32Array(data.length); for (let i = 0; i < data.length; i++) o[i] = fromHalf(data[i]); return o; }
  return Float32Array.from(data); // Float16Array u. a.
}

function pixels(img, size) {
  const cv = document.createElement('canvas');
  cv.width = size.width; cv.height = size.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; // transparente Bereiche → Weiß
  g.fillRect(0, 0, cv.width, cv.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, cv.width, cv.height); // bei quadratischen Modellen gestreckt
  return g.getImageData(0, 0, cv.width, cv.height).data;
}

function makeInput(ctx, model, img, size) {
  const { width: W, height: H } = size;
  const d = pixels(img, size);
  const n = W * H;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]; // ImageNet-Normalisierung
  const arr = ctx.inF16 ? new Uint16Array(3 * n) : new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (d[i * 4 + c] / 255 - mean[c]) / std[c];
      arr[c * n + i] = ctx.inF16 ? toHalf(v) : v;
    }
  }
  return new ctx.ort.Tensor(ctx.inF16 ? 'float16' : 'float32', arr, [1, 3, H, W]);
}

/* ------------------------------------------------------------------ */
/* Öffentliche Funktion */

/**
 * Schätzt die Tiefe eines Bildes.
 * key: Modell aus MODELS, img: HTMLImageElement, w/h: natürliche Größe, requested: gewünschte Arbeitsauflösung
 * Rückgabe: { w, h, data: Float32Array (0..1, 1 = nah/hoch), ms, device, res, note }
 */
export async function estimateDepth(key, img, w, h, requested, progress) {
  const model = MODELS[key];
  if (!model) throw new Error('Unbekanntes Modell');
  let ctx = await getSession(key, progress);
  let cur = planInput(model, w, h, requested, ctx.half, ctx.budget);
  const wanted = model.mode === 'square' ? (model.sizes.filter(x => x <= Math.max(requested, model.sizes[0])).pop()) : requested;
  let note = cur.res < wanted ? 'limit' : '';

  for (;;) {
    progress?.({ status: 'infer', res: cur.res, device: ctx.device });
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
    try {
      const failAbove = Number(globalThis.DEPTHMAPPER_AI_FAIL_ABOVE); // Testhilfe: Speicherfehler simulieren
      if (failAbove && cur.res > failAbove) throw new Error('Simulierter Speicherfehler');
      const feeds = {};
      const names = ctx.session.inputNames;
      feeds[names[0]] = makeInput(ctx, model, img, cur.size);
      const t0 = performance.now();
      const out = await ctx.session.run(feeds);
      const ms = performance.now() - t0;

      const t = out[ctx.session.outputNames[0]];
      const [dh, dw] = t.dims.slice(-2);
      const data = toFloat32(t.data);
      for (const k in out) out[k].dispose?.();

      // Normalisieren auf 0..1, 1 = nah
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < data.length; i++) { const v = data[i]; if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
      if (!(mx - mn > 1e-9)) throw new Error('Ungültiges Ergebnis (leere Tiefenkarte)');
      const res = new Float32Array(data.length);
      const span = mx - mn;
      for (let i = 0; i < data.length; i++) {
        let t = (data[i] - mn) / span;
        if (!Number.isFinite(t)) t = 0;
        res[i] = model.out === 'depth' ? 1 - t : t;
      }
      return { w: dw, h: dh, data: res, ms, device: ctx.device, res: cur.res, note };
    } catch (err) {
      console.warn(`KI-Tiefe (${key}) bei ${cur.res}px auf ${ctx.device} fehlgeschlagen:`, err);
      const next = smaller(model, w, h, cur);
      if (next) { cur = next; note = 'fallback'; continue; }
      if (ctx.device === 'webgpu') {
        ctx = await getSession(key, progress, true);
        cur = planInput(model, w, h, requested, ctx.half, ctx.budget);
        note = 'wasm';
        continue;
      }
      throw err;
    }
  }
}

/** Bilineares Abtasten der Tiefenkarte an Bildkoordinaten (u, v in Pixeln des Originalbildes). */
export function sampleDepth(d, u, v, imgW, imgH) {
  const x = u * d.w / imgW - 0.5, y = v * d.h / imgH - 0.5;
  const x0 = Math.max(0, Math.min(d.w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(d.h - 1, Math.floor(y)));
  const x1 = Math.min(d.w - 1, x0 + 1), y1 = Math.min(d.h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const a = d.data[y0 * d.w + x0], b = d.data[y0 * d.w + x1];
  const c = d.data[y1 * d.w + x0], e = d.data[y1 * d.w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}
