// Bereich 2: Bild → Relief
import { buildPanel, debounce, toast, setupDrop, loadSettings, saveSettings, fmtNum, h } from './ui.js';
import { processHeight, heightPercentiles, drawResult, drawHistogram, exportPNG, safeBase, gaussBlur, maskedBlur, distanceToEdge, shapeMask } from './heightmap.js';
import { COMMON_DEFAULTS, graySection, outputSection, applyPreset, laserInfoHTML, statsHTML } from './presets.js';
import { ReliefPreview } from './relief-preview.js';

const IMAGE_DEFAULTS = {
  ...COMMON_DEFAULTS,
  fit: 'contain',
  zoom: 100,
  offX: 0,
  offY: 0,
  rot: 0,
  heightFrom: 'light',   // 'light' = hell ist hoch, 'dark' = dunkel ist hoch
  bgRemove: 'auto',      // 'none' | 'auto' | 'white' | 'black' | 'corner'
  tol: 12,
  detail: 0,
  detailMm: 1,
  dome: 0,
  domeMm: 4,
  preBlurMm: 0,
};

export class ImageMode {
  constructor() {
    this.state = loadSettings('image', IMAGE_DEFAULTS);
    this.img = null;
    this.fileName = '';
    this.view = document.getElementById('image-view');
    this.mapEl = document.getElementById('image-map');
    this.origEl = document.getElementById('image-orig');
    this.histEl = document.getElementById('image-hist');
    this.statsEl = document.getElementById('image-stats');
    this.exportBtn = document.getElementById('image-export');
    this.raw = null;
    this.result = null;

    this.initPanel();
    this.relief = new ReliefPreview(this.view, { quality: 420 });
    this.view.prepend(this.relief.renderer.domElement);

    this.rebuild = debounce(() => this.buildSource(), 120);
    this.reprocess = debounce(() => this.process(), 60);
    this.repreview = debounce(() => this.updatePreview(), 80);
    this.save = debounce(() => saveSettings('image', this.state), 400);

    const input = document.getElementById('file-image');
    input.addEventListener('change', () => { if (input.files[0]) this.loadFile(input.files[0]); input.value = ''; });
    this.openFile = () => input.click();
    document.querySelectorAll('[data-action="open-image"]').forEach(b => b.addEventListener('click', this.openFile));
    document.querySelectorAll('[data-action="demo-image"]').forEach(b => b.addEventListener('click', () => this.loadDemo()));
    setupDrop(this.view, f => this.loadFile(f));
    setupDrop(this.origEl, f => this.loadFile(f));
    this.exportBtn.addEventListener('click', () => this.export());
    document.getElementById('image-bgtoggle').addEventListener('click', () => this.mapEl.classList.toggle('dark-bg'));
  }

  initPanel() {
    const s = this.state;
    const fileBox = h('div', { class: 'ctl' },
      h('div', { class: 'file-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.openFile() }, '🖼 Bild öffnen'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.loadDemo() }, 'Beispiel')),
      this.fileInfo = h('div', { class: 'file-name' }, 'PNG, JPG, WebP, SVG … – oder per Drag & Drop.'));

    const schema = [
      { title: 'Bild laden', step: 1, items: [{ type: 'custom', build: () => fileBox }] },
      { title: 'Ausschnitt', step: 2, items: [
        { key: 'fit', type: 'seg', label: 'Einpassen', stage: 'source', options: [['contain', 'Ganz zeigen'], ['cover', 'Füllen']] },
        { key: 'zoom', type: 'range', label: 'Zoom', min: 10, max: 400, step: 1, unit: '%', stage: 'source', reset: 100 },
        { key: 'offX', type: 'range', label: 'Versatz horizontal', min: -100, max: 100, step: 0.5, unit: '%', stage: 'source', reset: 0 },
        { key: 'offY', type: 'range', label: 'Versatz vertikal', min: -100, max: 100, step: 0.5, unit: '%', stage: 'source', reset: 0 },
        { key: 'rot', type: 'seg', label: 'Drehen', stage: 'source', options: [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']] },
      ] },
      { title: 'Relief', step: 3, items: [
        { key: 'heightFrom', type: 'seg', label: 'Höhe aus Helligkeit', stage: 'source',
          options: [['light', 'Hell = hoch'], ['dark', 'Dunkel = hoch']],
          hint: 'Bei Fotos meist „Hell = hoch“. Bei dunklen Strichzeichnungen auf weißem Grund „Dunkel = hoch“.' },
        { key: 'bgRemove', type: 'select', label: 'Hintergrund entfernen', stage: 'source',
          options: [['auto', 'Automatisch (Transparenz, sonst Eckfarbe)'], ['none', 'Nicht entfernen'], ['alpha', 'Nur Bild-Transparenz'], ['white', 'Weiß entfernen'], ['black', 'Schwarz entfernen'], ['corner', 'Eckfarbe entfernen']] },
        { key: 'tol', type: 'range', label: 'Toleranz Hintergrund', min: 0, max: 60, step: 1, unit: '%', stage: 'source', reset: 12,
          show: st => !['none', 'alpha'].includes(st.bgRemove) },
        { key: 'preBlurMm', type: 'range', label: 'Rauschen entfernen', min: 0, max: 1.5, step: 0.01, unit: 'mm', stage: 'source', reset: 0,
          hint: 'Glättet das Bild vor dem Detail- und Wölbungs-Schritt.' },
        { key: 'detail', type: 'range', label: 'Details betonen', min: 0, max: 300, step: 1, unit: '%', stage: 'source', reset: 0,
          hint: 'Hebt feine Strukturen hervor (lokaler Kontrast). Gut für Fotos und Gesichter.' },
        { key: 'detailMm', type: 'range', label: 'Detail-Radius', min: 0.1, max: 10, step: 0.1, unit: 'mm', stage: 'source', reset: 1, show: st => st.detail > 0 },
        { key: 'dome', type: 'range', label: 'Wölbung (Kissen-Effekt)', min: 0, max: 100, step: 1, unit: '%', stage: 'source', reset: 0,
          hint: 'Rundet das Motiv zu den Rändern hin ab – ideal für Logos, Schriften und Silhouetten.' },
        { key: 'domeMm', type: 'range', label: 'Wölbungs-Breite', min: 0.2, max: 40, step: 0.1, unit: 'mm', stage: 'source', reset: 4, show: st => st.dome > 0 },
      ] },
      graySection(4, [
        { type: 'buttons', cols: 2, items: [
          { label: '✨ Auto-Pegel', onClick: () => this.autoLevels() },
          { label: 'Graustufen zurücksetzen', onClick: () => this.resetGray() },
        ] },
      ]),
      outputSection(5),
    ];
    this.panel = buildPanel(document.getElementById('image-panel'), schema, s, (k, v, c) => this.onChange(k, v, c));
  }

  onChange(key, v, c) {
    const s = this.state;
    if (key === 'preset') {
      if (applyPreset(s, v)) { this.panel.refresh(); this.buildSource(); }
      this.save();
      return;
    }
    if (['sizeMm', 'lpcm', 'shape', 'steps', 'depthMm', 'material', 'bg'].includes(key)) s.preset = 'custom';
    this.save();
    switch (c.stage) {
      case 'source': case 'capture': this.rebuild(); break;
      case 'process': this.reprocess(); break;
      case 'preview': this.repreview(); break;
    }
    this.panel.refresh();
  }

  async loadFile(file) {
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(file.name)) {
      toast('Bitte eine Bilddatei wählen.', true);
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      let w = img.naturalWidth, hh = img.naturalHeight;
      if (!w || !hh) { w = 1000; hh = 1000; } // SVG ohne Größe
      this.setImage(img, w, hh, file.name);
    } catch (e) {
      console.error(e);
      toast('Bild konnte nicht gelesen werden.', true);
    }
  }

  loadDemo() {
    // Beispielmotiv: Stern mit Schriftzug, transparenter Hintergrund
    const c = document.createElement('canvas');
    c.width = c.height = 800;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(400, 360, 20, 400, 400, 360);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#7a7a7a');
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const r = i % 2 ? 150 : 330;
      g.lineTo(400 + Math.cos(a) * r, 400 + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    g.fillStyle = '#2a2a2a';
    g.font = 'bold 120px Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('DM', 400, 420);
    const img = new Image();
    img.onload = () => this.setImage(img, 800, 800, 'beispiel.png');
    img.src = c.toDataURL('image/png');
    this.state.heightFrom = 'light';
    this.state.dome = 35;
    this.state.domeMm = 3;
    this.panel.refresh();
  }

  setImage(img, w, hh, name) {
    this.img = img; this.imgW = w; this.imgH = hh; this.fileName = name;
    // Analysebild (klein) für Transparenz & Eckfarbe
    const a = document.createElement('canvas');
    const k = Math.min(1, 256 / Math.max(w, hh));
    a.width = Math.max(1, Math.round(w * k)); a.height = Math.max(1, Math.round(hh * k));
    const ag = a.getContext('2d', { willReadFrequently: true });
    ag.drawImage(img, 0, 0, a.width, a.height);
    const d = ag.getImageData(0, 0, a.width, a.height).data;
    let transparent = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) transparent++;
    this.hasAlpha = transparent > (d.length / 4) * 0.01;
    const corners = [0, a.width - 1, (a.height - 1) * a.width, a.height * a.width - 1];
    const cc = [0, 0, 0];
    for (const p of corners) { cc[0] += d[p * 4]; cc[1] += d[p * 4 + 1]; cc[2] += d[p * 4 + 2]; }
    this.cornerColor = cc.map(v => v / 4);

    this.fileInfo.innerHTML = `<b>${name}</b><br>${w} × ${hh} px${this.hasAlpha ? ' · mit Transparenz' : ''}`;
    this.origEl.innerHTML = '';
    const pv = img.cloneNode();
    this.origEl.append(pv);
    this.origEl.style.aspectRatio = `${w} / ${hh}`;
    document.getElementById('image-empty').classList.add('hidden');
    this.exportBtn.disabled = false;
    this.relief.lastDims = '';
    this.buildSource();
  }

  /** Bild in Ausgabegröße zeichnen und Rohhöhen berechnen */
  buildSource() {
    if (!this.img) return;
    const s = this.state;
    const rot = Number(s.rot) || 0;
    const swap = rot === 90 || rot === 270;
    const iw = swap ? this.imgH : this.imgW, ih = swap ? this.imgW : this.imgH;

    const square = s.shape === 'circle' || s.aspect === 'square';
    const aspect = square ? 1 : iw / ih;
    const mmW = aspect >= 1 ? s.sizeMm : s.sizeMm * aspect;
    const mmH = aspect >= 1 ? s.sizeMm / aspect : s.sizeMm;
    const pxPerMm = s.lpcm / 10;
    let W = Math.max(8, Math.round(mmW * pxPerMm)), H = Math.max(8, Math.round(mmH * pxPerMm));
    const MAX = 6000;
    if (Math.max(W, H) > MAX) {
      const k = MAX / Math.max(W, H);
      W = Math.round(W * k); H = Math.round(H * k);
      toast(`Auflösung auf ${W} × ${H} px begrenzt`, true);
    }
    const effPxPerMm = W / mmW;

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const fitScale = s.fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
    const sc = fitScale * s.zoom / 100;
    g.translate(W / 2 + s.offX / 100 * W / 2, H / 2 + s.offY / 100 * H / 2);
    g.rotate(rot * Math.PI / 180);
    g.scale(sc, sc);
    g.drawImage(this.img, -this.imgW / 2, -this.imgH / 2, this.imgW, this.imgH);
    const data = g.getImageData(0, 0, W, H).data;

    const n = W * H;
    let lum = new Float32Array(n);
    const alpha = new Float32Array(n);
    let mode = s.bgRemove;
    if (mode === 'auto') mode = this.hasAlpha ? 'alpha' : 'corner';
    const tol = s.tol / 100 * 441.7; // max. RGB-Abstand
    const key = mode === 'white' ? [255, 255, 255] : mode === 'black' ? [0, 0, 0] : mode === 'corner' ? this.cornerColor : null;
    const darkHigh = s.heightFrom === 'dark';

    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const r = data[p], gg = data[p + 1], b = data[p + 2];
      let a = data[p + 3] / 255;
      if (mode === 'none') a = a > 0 ? 1 : 0;
      if (key) {
        const dr = r - key[0], dg = gg - key[1], db = b - key[2];
        if (Math.sqrt(dr * dr + dg * dg + db * db) <= tol) a = 0;
      }
      alpha[i] = a;
      let L = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
      if (darkHigh) L = 1 - L;
      lum[i] = L;
    }

    if (s.preBlurMm > 0) lum = maskedBlur(lum, alpha, W, H, s.preBlurMm * effPxPerMm);

    if (s.detail > 0) {
      const base = maskedBlur(lum, alpha, W, H, s.detailMm * effPxPerMm);
      const k = s.detail / 100;
      for (let i = 0; i < n; i++) lum[i] = lum[i] + k * (lum[i] - base[i]);
    }

    if (s.dome > 0) {
      const shp = shapeMask(W, H, s.shape, s.corner);
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = alpha[i] >= 0.5 && shp[i] ? 1 : 0;
      let dist = distanceToEdge(mask, W, H);
      const R = Math.max(0.5, s.domeMm * effPxPerMm);
      dist = gaussBlur(dist, W, H, Math.min(R * 0.15, 6));
      const m = s.dome / 100;
      for (let i = 0; i < n; i++) {
        const x = Math.min(1, dist[i] / R);
        const dome = Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
        lum[i] = lum[i] * (1 - m) + dome * m;
      }
    }

    // In 0..1 begrenzen (Details können überschießen)
    for (let i = 0; i < n; i++) lum[i] = lum[i] < 0 ? 0 : lum[i] > 1 ? 1 : lum[i];

    this.raw = { w: W, h: H, height: lum, alpha, mmW, mmH, pxPerMm: effPxPerMm };
    this.process();
  }

  process() {
    if (!this.raw) return;
    const s = this.state;
    this.result = processHeight(this.raw, s, this.raw.pxPerMm);
    drawResult(this.mapEl, this.result);
    drawHistogram(this.histEl, this.result);
    this.statsEl.innerHTML = statsHTML(this.result);
    this.panel.els.laserInfo.innerHTML = laserInfoHTML(s, this.result, this.raw.mmW, this.raw.mmH);
    this.repreview();
  }

  updatePreview() {
    if (!this.result) return;
    const s = this.state;
    this.relief.update(this.result, { mmW: this.raw.mmW, mmH: this.raw.mmH, depthMm: s.depthMm, exag: s.exag, material: s.material, shape: s.shape, corner: s.corner });
  }

  autoLevels() {
    if (!this.raw) return;
    const [lo, hi] = heightPercentiles(this.raw);
    this.state.black = Math.max(0, Math.floor(lo * 2) / 2);
    this.state.white = Math.min(100, Math.max(this.state.black + 1, Math.ceil(hi * 2) / 2));
    this.panel.refresh();
    this.process();
    this.save();
  }

  resetGray() {
    Object.assign(this.state, { black: 0, white: 100, gamma: 1, blurMm: 0, outMin: 0, outMax: 255 });
    this.panel.refresh();
    this.process();
    this.save();
  }

  export() {
    if (!this.result) return;
    const s = this.state;
    const name = `${safeBase(this.fileName)}_relief_${fmtNum(this.raw.mmW, 1).replace(',', '.')}x${fmtNum(this.raw.mmH, 1).replace(',', '.')}mm${s.invert ? '_negativ' : ''}.png`;
    exportPNG(this.result, name, this.result.w / this.raw.mmW * 25.4);
    toast('PNG exportiert: ' + name);
  }

  activate() {
    this.relief.resize();
  }
}
