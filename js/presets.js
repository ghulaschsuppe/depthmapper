// Voreinstellungen (orientiert am xTool F2 Ultra) und gemeinsame Einstellungs-Sektionen.
import { GRAY_DEFAULTS } from './heightmap.js';
import { fmtNum } from './ui.js';

/**
 * Startwerte für typische Werkstücke. Leistung/Geschwindigkeit/Durchgänge werden in XCS eingestellt;
 * hier geht es um Bildgröße, Auflösung, Graustufen und die Tiefe für die 3D-Vorschau.
 * Standard: 256 Graustufen (8 Bit), wie beim F2 Ultra z. B. für Messing-Münzen.
 */
export const PRESETS = [
  { id: 'coin40', name: 'Messing-Münze Ø 40 mm (Faser)', sizeMm: 40, shape: 'circle', lpcm: 300, steps: 256, depthMm: 0.3, material: 'brass', bg: 'transparent' },
  { id: 'coin30', name: 'Messing-Münze Ø 30 mm (Faser)', sizeMm: 30, shape: 'circle', lpcm: 300, steps: 256, depthMm: 0.25, material: 'brass', bg: 'transparent' },
  { id: 'coin50', name: 'Messing-Münze Ø 50 mm (Faser)', sizeMm: 50, shape: 'circle', lpcm: 300, steps: 256, depthMm: 0.4, material: 'brass', bg: 'transparent' },
  { id: 'copper', name: 'Kupfer-Medaille Ø 40 mm (Faser)', sizeMm: 40, shape: 'circle', lpcm: 300, steps: 256, depthMm: 0.25, material: 'copper', bg: 'transparent' },
  { id: 'steel', name: 'Edelstahl-Plakette 50 × 50 mm (Faser)', sizeMm: 50, shape: 'rounded', lpcm: 300, steps: 256, depthMm: 0.2, material: 'steel', bg: 'transparent' },
  { id: 'alu', name: 'Aluminium-Schild 80 mm (Faser)', sizeMm: 80, shape: 'rounded', lpcm: 250, steps: 256, depthMm: 0.3, material: 'alu', bg: 'transparent' },
  { id: 'wood', name: 'Holz-Relief 100 mm (Diode)', sizeMm: 100, shape: 'none', lpcm: 100, steps: 256, depthMm: 2, material: 'wood', bg: 'transparent' },
  { id: 'slate', name: 'Schiefer 100 mm (Diode)', sizeMm: 100, shape: 'none', lpcm: 120, steps: 64, depthMm: 0.4, material: 'slate', bg: 'transparent' },
  { id: 'stepped', name: 'Stufenrelief Münze Ø 40 mm (16 Stufen)', sizeMm: 40, shape: 'circle', lpcm: 300, steps: 16, depthMm: 0.3, material: 'brass', bg: 'transparent' },
  { id: 'custom', name: 'Benutzerdefiniert' },
];

export const MATERIALS = {
  brass:  { name: 'Messing',   color: 0xd4ae5a, engraved: 0x8c6b2a, metalness: 0.95, roughness: 0.32 },
  copper: { name: 'Kupfer',    color: 0xd08a5c, engraved: 0x7a4026, metalness: 0.95, roughness: 0.35 },
  steel:  { name: 'Edelstahl', color: 0xc7cbd1, engraved: 0x6f747b, metalness: 0.9, roughness: 0.38 },
  alu:    { name: 'Aluminium', color: 0xdfe3e8, engraved: 0xa9aeb5, metalness: 0.85, roughness: 0.45 },
  wood:   { name: 'Holz',      color: 0xc99b69, engraved: 0x4a2c16, metalness: 0.0, roughness: 0.82 },
  slate:  { name: 'Schiefer',  color: 0x3d4148, engraved: 0xa7abb0, metalness: 0.0, roughness: 0.9 },
  acryl:  { name: 'Acryl schwarz', color: 0x18191c, engraved: 0xd9dadc, metalness: 0.1, roughness: 0.25 },
  plain:  { name: 'Neutral (Grau)', color: 0xbfc3c9, engraved: 0xbfc3c9, metalness: 0.0, roughness: 0.6 },
};

export const OUTPUT_DEFAULTS = {
  preset: 'coin40',
  sizeMm: 40,
  lpcm: 300,
  aspect: 'auto',
  shape: 'circle',
  corner: 15,
  bg: 'transparent',
  depthMm: 0.3,
  material: 'brass',
  exag: 4,
};

export const COMMON_DEFAULTS = { ...GRAY_DEFAULTS, ...OUTPUT_DEFAULTS };

export function applyPreset(state, id) {
  const p = PRESETS.find(x => x.id === id);
  if (!p || id === 'custom') return false;
  for (const k of ['sizeMm', 'shape', 'lpcm', 'steps', 'depthMm', 'material', 'bg']) if (k in p) state[k] = p[k];
  // Vorschau-Überhöhung passend zur Tiefe
  state.exag = p.depthMm < 0.6 ? 4 : p.depthMm < 1.5 ? 2 : 1;
  return true;
}

export const dpiOf = lpcm => lpcm * 2.54;

/** Sektion „Graustufen & Tiefe“ */
export function graySection(step, extraItems = []) {
  return {
    title: 'Graustufen', step, items: [
      { key: 'invert', type: 'check', label: 'Invertieren – Negativ / eingeprägt', stage: 'process',
        hint: 'Höchster Punkt wird schwarz (= am tiefsten graviert). Z. B. für ein Gesicht, das vertieft eingeprägt wird: Stempel, Siegel, Gussformen.' },
      ...extraItems,
      { key: 'black', type: 'range', label: 'Schwarzpunkt', min: 0, max: 99, step: 0.5, unit: '%', stage: 'process', reset: 0,
        hint: 'Rohhöhen unterhalb dieses Wertes werden schwarz (tiefste Stelle).' },
      { key: 'white', type: 'range', label: 'Weißpunkt', min: 1, max: 100, step: 0.5, unit: '%', stage: 'process', reset: 100,
        hint: 'Rohhöhen oberhalb dieses Wertes werden weiß (Oberfläche).' },
      { key: 'gamma', type: 'range', label: 'Gamma (Mitteltöne)', min: 0.2, max: 4, step: 0.01, unit: '', stage: 'process', reset: 1,
        hint: '> 1 hebt die Mitteltöne an (flacher graviert), < 1 senkt sie ab (tiefer graviert).' },
      { key: 'blurMm', type: 'range', label: 'Glättung', min: 0, max: 2, step: 0.01, unit: 'mm', stage: 'process', reset: 0,
        hint: 'Weichzeichnen innerhalb des Motivs – entfernt Stufen und Rauschen.' },
      { key: 'steps', type: 'select', label: 'Graustufen / Schichten', numeric: true, stage: 'process',
        options: [[256, '256 Stufen (Standard F2 Ultra)'], [128, '128 Stufen'], [64, '64 Stufen'], [32, '32 Stufen'], [16, '16 Stufen (Stufenrelief)'], [8, '8 Stufen'], [4, '4 Stufen']],
        hint: '256 = volle 8-Bit-Auflösung. Weniger Stufen erzeugen ein sichtbares Stufen-/Terrassenrelief.' },
      { key: 'outMax', type: 'range', label: 'Hellster Grauwert (Oberfläche)', min: 1, max: 255, step: 1, unit: '', stage: 'process', reset: 255,
        hint: 'Unter 255 wird auch der höchste Punkt leicht angraviert.' },
      { key: 'outMin', type: 'range', label: 'Dunkelster Grauwert (Tiefe)', min: 0, max: 254, step: 1, unit: '', stage: 'process', reset: 0,
        hint: 'Über 0 begrenzt die maximale Gravurtiefe.' },
      { key: 'mirrorX', type: 'check', label: 'Horizontal spiegeln', stage: 'process', hint: 'Für Stempel und Prägewerkzeuge, deren Abdruck seitenrichtig sein soll.' },
      { key: 'mirrorY', type: 'check', label: 'Vertikal spiegeln', stage: 'process' },
      { key: 'softEdges', type: 'check', label: 'Weiche Kanten (Kantenglättung)', stage: 'process',
        hint: 'Halbtransparente Randpixel. Aus = harte, saubere Kante (für Laser meist besser).' },
    ],
  };
}

/** Sektion „Ausgabe & Laser“ */
export function outputSection(step, opts = {}) {
  return {
    title: 'Ausgabe & Laser', step, items: [
      { key: 'preset', type: 'select', label: 'Voreinstellung (xTool F2 Ultra)', stage: 'preset',
        options: PRESETS.map(p => [p.id, p.name]) },
      ...(opts.before || []),
      { key: 'sizeMm', type: 'range', label: opts.sizeLabel || 'Größe (längste Seite)', min: 5, max: 400, step: 0.5, unit: 'mm', stage: 'capture',
        show: opts.sizeShow },
      { key: 'lpcm', type: 'range', label: 'Auflösung', min: 20, max: 800, step: 10, unit: 'L/cm', stage: 'capture',
        extra: v => `≈ ${Math.round(dpiOf(v))} DPI`,
        hint: 'Linien pro Zentimeter (wie in XCS). Bestimmt die Pixelzahl der Depthmap. Die DPI werden ins PNG geschrieben.' },
      { key: 'aspect', type: 'seg', label: 'Format', stage: 'capture',
        options: [['auto', 'Wie Motiv'], ['square', 'Quadratisch']], show: s => s.shape !== 'circle' },
      { key: 'shape', type: 'seg', label: 'Form / Zuschnitt', stage: 'capture',
        options: [['none', 'Rechteck'], ['circle', 'Kreis (Münze)'], ['rounded', 'Abgerundet']] },
      { key: 'corner', type: 'range', label: 'Eckenradius', min: 0, max: 50, step: 1, unit: '%', stage: 'process', show: s => s.shape === 'rounded' },
      { key: 'bg', type: 'seg', label: 'Hintergrund', stage: 'process',
        options: [['transparent', 'Transparent'], ['white', 'Weiß'], ['black', 'Schwarz']],
        hint: 'Transparent = wird nicht graviert. Weiß = Oberfläche. Schwarz = Hintergrund wird voll abgetragen.' },
      { key: 'depthMm', type: 'range', label: 'Gravurtiefe (max.)', min: 0.01, max: 10, step: 0.01, unit: 'mm', stage: 'preview',
        hint: 'Tiefe bei Schwarz. Wird für die 3D-Vorschau und die Tiefe pro Stufe verwendet; die echte Tiefe ergibt sich aus Leistung & Durchgängen in XCS.' },
      { key: 'material', type: 'select', label: 'Material (Vorschau)', stage: 'preview',
        options: Object.entries(MATERIALS).map(([k, m]) => [k, m.name]) },
      { key: 'exag', type: 'range', label: 'Überhöhung Vorschau', min: 1, max: 30, step: 0.5, unit: '×', stage: 'preview', reset: 1,
        hint: 'Nur für die 3D-Vorschau: macht flache Gravuren besser sichtbar.' },
      { type: 'info', id: 'laserInfo' },
    ],
  };
}

export function laserInfoHTML(state, result, mmW, mmH) {
  if (!result) return 'Noch keine Depthmap.';
  const dpi = dpiOf(state.lpcm);
  const perStep = state.depthMm / Math.max(1, state.steps - 1) * 1000;
  const warn = result.w * result.h > 36e6 ? '<br><span class="warn">Sehr große Datei – Auflösung ggf. reduzieren.</span>' : '';
  return `<b>${result.w} × ${result.h} px</b> · <b>${fmtNum(mmW, 1)} × ${fmtNum(mmH, 1)} mm</b><br>` +
    `${state.lpcm} Linien/cm ≈ ${Math.round(dpi)} DPI · ${state.steps} Stufen<br>` +
    `≈ <b>${fmtNum(perStep, 2)} µm</b> Tiefe pro Graustufe bei ${fmtNum(state.depthMm, 2)} mm` + warn;
}

export function statsHTML(result) {
  if (!result) return '';
  const cover = result.objCount / (result.w * result.h) * 100;
  return `<span>Grauwerte <b>${result.gMin}–${result.gMax}</b></span><span>Motivfläche <b>${fmtNum(cover, 0)} %</b></span>`;
}
