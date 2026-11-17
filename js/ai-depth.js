// KI-Tiefenschätzung aus einem einzelnen Foto (monokulare Depth Estimation).
// Modell: Depth Anything V2 Small (Apache-2.0), läuft komplett im Browser über
// Transformers.js / ONNX Runtime Web – per WebGPU (schnell) oder WebAssembly (Fallback).
// Das Foto verlässt den Rechner nicht; geladen werden nur Bibliothek und Modell (einmalig, danach Browser-Cache).

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
export const MODEL_ID = 'onnx-community/depth-anything-v2-small';
export const MODEL_NAME = 'Depth Anything V2 Small';

let loader = null;      // Promise<{ pipe, T, device, dtype }>
let progressFn = null;  // aktueller Fortschritts-Empfänger

async function pickDevice() {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
    } catch { /* kein WebGPU */ }
  }
  return { device: 'wasm', dtype: 'q8' };
}

function onProgress(p) {
  if (progressFn) progressFn(p);
}

/** Lädt Bibliothek und Modell (nur beim ersten Aufruf). */
export function loadDepthModel(progress) {
  progressFn = progress;
  if (!loader) {
    loader = (async () => {
      progress?.({ status: 'lib' });
      const T = await import(TRANSFORMERS_URL);
      T.env.allowLocalModels = false;
      let { device, dtype } = await pickDevice();
      let pipe;
      try {
        pipe = await T.pipeline('depth-estimation', MODEL_ID, { device, dtype, progress_callback: onProgress });
      } catch (err) {
        if (device !== 'webgpu') throw err;
        console.warn('WebGPU nicht nutzbar, weiche auf WebAssembly aus:', err);
        device = 'wasm'; dtype = 'q8';
        pipe = await T.pipeline('depth-estimation', MODEL_ID, { device, dtype, progress_callback: onProgress });
      }
      return { pipe, T, device, dtype };
    })().catch(err => { loader = null; throw err; });
  }
  return loader;
}

/**
 * Schätzt die Tiefe eines Bildes.
 * img: HTMLImageElement, w/h: natürliche Größe, res: Arbeitsauflösung des Modells (Vielfaches von 14)
 * Rückgabe: { w, h, data: Float32Array (0..1, 1 = nah/hoch), ms, device, dtype }
 */
export async function estimateDepth(img, w, h, res, progress) {
  const { pipe, T, device, dtype } = await loadDepthModel(progress);
  progress?.({ status: 'infer' });
  // Ein Frame Zeit lassen, damit die Fortschrittsanzeige gezeichnet wird
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));

  // Eingabebild: max. 2048 px, transparente Bereiche auf Weiß
  const k = Math.min(1, 2048 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cw, ch);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, cw, ch);
  const raw = T.RawImage.fromCanvas(cv);

  // Arbeitsauflösung setzen (Seitenverhältnis bleibt erhalten, Vielfaches von 14)
  const ip = pipe.processor?.image_processor ?? pipe.processor;
  if (ip) {
    const r = Math.round(res / 14) * 14;
    ip.size = { width: r, height: r };
    if (ip.config) ip.config.size = { width: r, height: r };
  }

  const t0 = performance.now();
  const out = await pipe(raw);
  const ms = performance.now() - t0;
  const pd = out.predicted_depth;
  const [dh, dw] = pd.dims.slice(-2);
  const src = pd.data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < src.length; i++) { const v = src[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = mx - mn || 1;
  const data = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) data[i] = (src[i] - mn) / span;
  return { w: dw, h: dh, data, ms, device, dtype };
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
