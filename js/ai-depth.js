// KI-Tiefenschätzung aus einem einzelnen Foto (monokulare Depth Estimation).
// Modell: Depth Anything V2 Small (Apache-2.0), läuft komplett im Browser über
// Transformers.js / ONNX Runtime Web – per WebGPU (schnell) oder WebAssembly (Fallback).
// Das Foto verlässt den Rechner nicht; geladen werden nur Bibliothek und Modell (einmalig, danach Browser-Cache).
//
// Speicherbedarf: Das Modell ist ein Vision-Transformer (Patch 14 px, 6 Attention-Heads). Die größten
// Zwischenpuffer wachsen mit dem QUADRAT der Patch-Anzahl. Deshalb wird die Arbeitsauflösung an die
// Grenzen des Geräts angepasst und bei Fehlern automatisch stufenweise reduziert.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
export const MODEL_ID = 'onnx-community/depth-anything-v2-small';
export const MODEL_NAME = 'Depth Anything V2 Small';

const PATCH = 14;
const HEADS = 6;
const MIN_RES = 266;

let loader = null;      // Promise<{ pipe, T, device, dtype, budget }>
let progressFn = null;  // aktueller Fortschritts-Empfänger

export const isMobile = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);

/** Größter Einzelpuffer (Bytes), den wir dem Gerät zumuten. */
function wasmBudget() {
  const mem = navigator.deviceMemory || (isMobile() ? 3 : 8); // GB (Schätzung, wenn unbekannt)
  if (isMobile()) return mem <= 3 ? 100e6 : mem <= 4 ? 150e6 : 220e6;
  return mem <= 4 ? 400e6 : 900e6;
}

async function pickDevice(forceWasm) {
  if (!forceWasm && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const lim = Math.min(adapter.limits.maxBufferSize || 256e6, adapter.limits.maxStorageBufferBindingSize || 128e6);
        return {
          device: 'webgpu',
          dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32',
          budget: Math.min(lim * 0.85, isMobile() ? 220e6 : 2e9),
        };
      }
    } catch { /* kein WebGPU */ }
  }
  return { device: 'wasm', dtype: 'q8', budget: wasmBudget() };
}

function onProgress(p) {
  if (progressFn) progressFn(p);
}

/** Lädt Bibliothek und Modell (nur beim ersten Aufruf bzw. nach Wechsel auf WebAssembly). */
export function loadDepthModel(progress, forceWasm = false) {
  progressFn = progress;
  if (forceWasm && loader) {
    // laufende WebGPU-Pipeline verwerfen
    loader.then(l => l.device !== 'wasm' && l.pipe.dispose?.()).catch(() => {});
    loader = null;
  }
  if (!loader) {
    loader = (async () => {
      progress?.({ status: 'lib' });
      const T = await import(TRANSFORMERS_URL);
      T.env.allowLocalModels = false;
      let { device, dtype, budget } = await pickDevice(forceWasm);
      let pipe;
      try {
        pipe = await T.pipeline('depth-estimation', MODEL_ID, { device, dtype, progress_callback: onProgress });
      } catch (err) {
        if (device !== 'webgpu') throw err;
        console.warn('WebGPU nicht nutzbar, weiche auf WebAssembly aus:', err);
        ({ device, dtype, budget } = await pickDevice(true));
        pipe = await T.pipeline('depth-estimation', MODEL_ID, { device, dtype, progress_callback: onProgress });
      }
      return { pipe, T, device, dtype, budget };
    })().catch(err => { loader = null; throw err; });
  }
  return loader;
}

/** Eingabegröße (Vielfache von 14) mit langer Seite = res, Seitenverhältnis wie das Foto. */
function sizeFor(w, h, res) {
  const k = res / Math.max(w, h);
  return {
    width: Math.max(PATCH, Math.round(w * k / PATCH) * PATCH),
    height: Math.max(PATCH, Math.round(h * k / PATCH) * PATCH),
  };
}

/** Geschätzter größter Zwischenpuffer (Attention-Matrix) in Bytes. */
function attnBytes(size, dtype) {
  const n = (size.width / PATCH) * (size.height / PATCH) + 1;
  return n * n * HEADS * (dtype === 'fp16' ? 2 : 4);
}

/** Größte Auflösung ≤ res, die ins Budget passt. */
function fitRes(w, h, res, dtype, budget) {
  const limit = Number(globalThis.DEPTHMAPPER_AI_BUDGET) || budget; // für Tests überschreibbar
  let r = res;
  while (r > MIN_RES && attnBytes(sizeFor(w, h, r), dtype) > limit) r -= PATCH;
  return Math.max(MIN_RES, r);
}

function drawInput(T, img, w, h, size) {
  const cv = document.createElement('canvas');
  cv.width = size.width; cv.height = size.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; // transparente Bereiche → Weiß
  g.fillRect(0, 0, cv.width, cv.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, cv.width, cv.height);
  return T.RawImage.fromCanvas(cv);
}

/**
 * Schätzt die Tiefe eines Bildes.
 * img: HTMLImageElement, w/h: natürliche Größe, res: gewünschte Arbeitsauflösung (lange Seite)
 * Rückgabe: { w, h, data: Float32Array (0..1, 1 = nah/hoch), ms, device, dtype, res, requested, note }
 */
export async function estimateDepth(img, w, h, requested, progress) {
  let ctx = await loadDepthModel(progress);
  let res = fitRes(w, h, requested, ctx.dtype, ctx.budget);
  let note = res < requested ? 'limit' : '';

  for (;;) {
    progress?.({ status: 'infer', res });
    // Ein Frame Zeit lassen, damit die Fortschrittsanzeige gezeichnet wird
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
    const size = sizeFor(w, h, res);
    try {
      const failAbove = Number(globalThis.DEPTHMAPPER_AI_FAIL_ABOVE); // Testhilfe: Speicherfehler simulieren
      if (failAbove && res > failAbove) throw new Error('Simulierter Speicherfehler');
      const raw = drawInput(ctx.T, img, w, h, size);
      // Exakte Eingabegröße setzen → der Prozessor skaliert nicht weiter hoch
      const ip = ctx.pipe.processor?.image_processor ?? ctx.pipe.processor;
      if (ip) {
        ip.size = { ...size };
        if (ip.config) ip.config.size = { ...size };
      }
      const t0 = performance.now();
      const out = await ctx.pipe(raw);
      const ms = performance.now() - t0;
      const pd = out.predicted_depth;
      const [dh, dw] = pd.dims.slice(-2);
      const src = pd.data;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < src.length; i++) { const v = src[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx - mn < 1e-9) throw new Error('Ungültiges Ergebnis (leere Tiefenkarte)');
      const span = mx - mn;
      const data = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) data[i] = (src[i] - mn) / span;
      return { w: dw, h: dh, data, ms, device: ctx.device, dtype: ctx.dtype, res, requested, note };
    } catch (err) {
      console.warn(`KI-Tiefe bei ${res}px (${ctx.device}) fehlgeschlagen:`, err);
      if (res > MIN_RES + PATCH) {
        // Speicher reicht nicht → Budget senken und kleinere Auflösung versuchen
        ctx.budget = attnBytes(size, ctx.dtype) * 0.5;
        res = fitRes(w, h, Math.round(res * 0.75 / PATCH) * PATCH, ctx.dtype, ctx.budget);
        note = 'fallback';
        continue;
      }
      if (ctx.device === 'webgpu') {
        // Grafikkarte scheitert auch klein → auf Prozessor (WebAssembly) wechseln
        ctx = await loadDepthModel(progress, true);
        res = fitRes(w, h, requested, ctx.dtype, ctx.budget);
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
