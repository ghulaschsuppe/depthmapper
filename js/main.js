// Einstieg: Bereiche umschalten, Hilfe, WebGL-Prüfung
import { ModelMode } from './model-mode.js';
import { ImageMode } from './image-mode.js';
import { toast } from './ui.js';

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch { return false; }
}

const modes = {};

function show(mode) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('mode-model').classList.toggle('hidden', mode !== 'model');
  document.getElementById('mode-image').classList.toggle('hidden', mode !== 'image');
  requestAnimationFrame(() => modes[mode]?.activate());
  try { localStorage.setItem('depthmapper.mode', mode); } catch { /* ignorieren */ }
  if (location.hash !== '#' + mode) history.replaceState(null, '', '#' + mode);
}

function init() {
  if (!webglOK()) {
    toast('Dein Browser unterstützt kein WebGL 2 – die 3D-Funktionen sind nicht verfügbar.', true, 10000);
    return;
  }
  modes.model = new ModelMode();
  modes.image = new ImageMode();
  window.depthmapper = modes; // für Tests/Fehlersuche

  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.mode)));
  const help = document.getElementById('help');
  document.getElementById('helpBtn').addEventListener('click', () => help.showModal());
  help.querySelector('[data-close]').addEventListener('click', () => help.close());
  help.addEventListener('click', e => { if (e.target === help) help.close(); });

  let start = location.hash.replace('#', '');
  if (!['model', 'image'].includes(start)) {
    try { start = localStorage.getItem('depthmapper.mode') || 'model'; } catch { start = 'model'; }
  }
  show(['model', 'image'].includes(start) ? start : 'model');
}

init();
