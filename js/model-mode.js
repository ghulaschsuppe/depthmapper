// Bereich 1: 3D-Modell → Depthmap
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import { buildPanel, debounce, toast, setupDrop, loadSettings, saveSettings, fmtNum, h } from './ui.js';
import { processHeight, heightPercentiles, drawResult, drawHistogram, exportPNG, safeBase } from './heightmap.js';
import { COMMON_DEFAULTS, graySection, outputSection, applyPreset, laserInfoHTML, statsHTML } from './presets.js';
import { ReliefPreview } from './relief-preview.js';

const DEG = Math.PI / 180;
const WORLD_UP = new THREE.Vector3(0, 1, 0);       // Laser schaut von oben (+Y) nach unten
const WORLD_IMGTOP = new THREE.Vector3(0, 0, -1);  // Bild-Oberkante zeigt nach -Z

const MODEL_DEFAULTS = {
  ...COMMON_DEFAULTS,
  upAxis: 'z',          // Koordinatensystem des Modells: 'z' (STL/3MF) oder 'y' (OBJ/GLB)
  side: 'top',
  rx: 0, ry: 0, rz: 0,
  clipPct: 100,         // Tiefenbereich in % der Modelltiefe
  below: 'black',       // was hinter dem Tiefenbereich liegt: 'black' | 'transparent'
  padPct: 4,            // Rand (negativ = hineinzoomen)
  offX: 0, offY: 0,     // Versatz in % der Rahmengröße
  sizeMode: 'fixed',    // 'fixed' | 'model'
  smooth: true,
};

// Seiten → [Richtung zum Laser, Richtung Bild-Oberkante] im Modell-Koordinatensystem
const SIDES = {
  z: {
    top: [[0, 0, 1], [0, 1, 0]], bottom: [[0, 0, -1], [0, -1, 0]],
    front: [[0, -1, 0], [0, 0, 1]], back: [[0, 1, 0], [0, 0, 1]],
    left: [[-1, 0, 0], [0, 0, 1]], right: [[1, 0, 0], [0, 0, 1]],
  },
  y: {
    top: [[0, 1, 0], [0, 0, -1]], bottom: [[0, -1, 0], [0, 0, 1]],
    front: [[0, 0, 1], [0, 1, 0]], back: [[0, 0, -1], [0, 1, 0]],
    left: [[-1, 0, 0], [0, 1, 0]], right: [[1, 0, 0], [0, 1, 0]],
  },
};

function basisToWorld(a, b) {
  // Rotation, die a → WORLD_UP und b → WORLD_IMGTOP abbildet
  const A = a.clone().normalize();
  const B = b.clone().sub(A.clone().multiplyScalar(b.dot(A))).normalize();
  const C = new THREE.Vector3().crossVectors(A, B);
  const Ml = new THREE.Matrix4().makeBasis(A, B, C);
  const Wc = new THREE.Vector3().crossVectors(WORLD_UP, WORLD_IMGTOP);
  const Mw = new THREE.Matrix4().makeBasis(WORLD_UP, WORLD_IMGTOP, Wc);
  const R = Mw.multiply(Ml.transpose());
  return new THREE.Quaternion().setFromRotationMatrix(R);
}

const DEPTH_VERT = /* glsl */`
  varying float vDist;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const DEPTH_FRAG = /* glsl */`
  uniform float uNear;
  uniform float uFar;
  varying float vDist;
  void main() {
    float hgt = 1.0 - (vDist - uNear) / (uFar - uNear);
    if (hgt < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.5); return; }
    float x = clamp(hgt, 0.0, 1.0) * 255.0;
    float r = floor(x); x = (x - r) * 255.0;
    float g = floor(x); x = (x - g) * 255.0;
    float b = floor(x);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
  }`;

export class ModelMode {
  constructor() {
    this.state = loadSettings('model', MODEL_DEFAULTS);
    this.fileName = '';
    this.view = document.getElementById('model-view');
    this.mapEl = document.getElementById('model-map');
    this.histEl = document.getElementById('model-hist');
    this.statsEl = document.getElementById('model-stats');
    this.exportBtn = document.getElementById('model-export');
    this.raw = null;
    this.result = null;
    this.frame = null;

    this.initScene();
    this.initPanel();
    this.relief = new ReliefPreview(document.getElementById('model-relief'), { quality: 260 });

    this.recapture = debounce(() => this.capture(), 120);
    this.reprocess = debounce(() => this.process(), 60);
    this.repreview = debounce(() => this.updatePreview(), 80);
    this.save = debounce(() => saveSettings('model', this.state), 400);

    // Dateien
    const input = document.getElementById('file-model');
    input.addEventListener('change', () => { if (input.files[0]) this.loadFile(input.files[0]); input.value = ''; });
    this.openFile = () => input.click();
    document.querySelectorAll('[data-action="open-model"]').forEach(b => b.addEventListener('click', this.openFile));
    document.querySelectorAll('[data-action="demo-model"]').forEach(b => b.addEventListener('click', () => this.loadDemo()));
    setupDrop(this.view, f => this.loadFile(f));
    this.exportBtn.addEventListener('click', () => this.export());
    document.getElementById('model-bgtoggle').addEventListener('click', () => this.mapEl.classList.toggle('dark-bg'));
  }

  /* ------------------------------------------------------------ Szene */
  initScene() {
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.view.prepend(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.position.set(80, 90, 120);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.addEventListener('change', () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.4));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.8); d1.position.set(1, 2, 1.5);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.6); d2.position.set(-1.5, 0.5, -1);
    this.scene.add(d1, d2);

    this.grid = new THREE.GridHelper(200, 20, 0x4a5260, 0x2c323b);
    this.scene.add(this.grid);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);

    this.gizmo = new TransformControls(this.camera, r.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('world');
    this.gizmo.addEventListener('dragging-changed', e => { this.controls.enabled = !e.value; });
    this.gizmo.addEventListener('change', () => this.render());
    this.gizmo.addEventListener('objectChange', () => this.onOrientationChanged(true));
    this.gizmoHelper = this.gizmo.getHelper();

    // Tiefen-Rendering
    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG,
      uniforms: { uNear: { value: 1 }, uFar: { value: 2 } },
      side: THREE.DoubleSide, blending: THREE.NoBlending, toneMapped: false,
    });
    this.depthScene = new THREE.Scene();
    this.depthCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

    new ResizeObserver(() => this.resize()).observe(this.view);
    this.resize();
  }

  resize() {
    const w = this.view.clientWidth, h = this.view.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  /* ------------------------------------------------------------ Panel */
  initPanel() {
    const s = this.state;
    const side = key => () => { s.side = key; this.applySide(); };
    const rot = (axis, deg) => () => {
      const q = new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG);
      this.pivot.quaternion.premultiply(q);
      s.side = 'custom';
      this.onOrientationChanged(true);
    };
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

    const fileBox = h('div', { class: 'ctl' },
      h('div', { class: 'file-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.openFile() }, '📂 Modell öffnen'),
        h('button', { class: 'btn', type: 'button', onclick: () => this.loadDemo() }, 'Beispiel')),
      this.fileInfo = h('div', { class: 'file-name' }, 'STL, OBJ, PLY, 3MF, GLB/GLTF – oder per Drag & Drop.'));

    const schema = [
      { title: 'Modell laden', step: 1, items: [
        { type: 'custom', build: () => fileBox },
        { key: 'upAxis', type: 'seg', label: 'Koordinatensystem', stage: 'side',
          options: [['z', 'Z oben (STL/3MF)'], ['y', 'Y oben (OBJ/GLB)']],
          hint: 'Bestimmt, was „Oben“, „Vorne“ usw. bedeuten. Wird beim Laden automatisch gesetzt.' },
        { key: 'smooth', type: 'check', label: 'Glatt schattieren (nur Ansicht)', stage: 'shading' },
      ] },
      { title: 'Ausrichten – welche Seite wird graviert?', step: 2, items: [
        { type: 'buttons', label: 'Laser schaut auf die Seite …', cols: 3, items: [
          { label: 'Oben', onClick: side('top'), id: 'side-top' },
          { label: 'Vorne', onClick: side('front'), id: 'side-front' },
          { label: 'Rechts', onClick: side('right'), id: 'side-right' },
          { label: 'Unten', onClick: side('bottom'), id: 'side-bottom' },
          { label: 'Hinten', onClick: side('back'), id: 'side-back' },
          { label: 'Links', onClick: side('left'), id: 'side-left' },
        ] },
        { type: 'buttons', cols: 2, items: [
          { label: '📷 Aktuelle Ansicht übernehmen', primary: true, onClick: () => this.takeView(),
            title: 'Dreh die Kamera auf die gewünschte Seite und klicke hier: Diese Seite zeigt dann zum Laser.' },
          { label: '🔄 Gizmo', id: 'gizmo-btn', onClick: () => this.toggleGizmo(), title: 'Freies Drehen mit der Maus' },
        ] },
        { type: 'buttons', label: 'Drehen in 90°-Schritten', cols: 4, items: [
          { label: 'X −90°', onClick: rot(X, -90) }, { label: 'X +90°', onClick: rot(X, 90) },
          { label: 'Kippen ↶', onClick: rot(Z, 90), title: 'Um die Tiefe-Achse (Z) drehen' },
          { label: 'Kippen ↷', onClick: rot(Z, -90) },
          { label: 'Bild ↶ 90°', onClick: rot(Y, 90), title: 'Um die Laserachse drehen (dreht die Depthmap)' },
          { label: 'Bild ↷ 90°', onClick: rot(Y, -90) },
          { label: 'Bild 180°', onClick: rot(Y, 180) },
          { label: '↺ Reset', onClick: () => { this.state.side = this.state.upAxis === 'z' ? 'top' : 'front'; this.applySide(); }, title: 'Ausrichtung zurücksetzen' },
        ] },
        { key: 'rx', type: 'range', label: 'Drehung X', min: -180, max: 180, step: 0.5, unit: '°', stage: 'euler', reset: 0 },
        { key: 'ry', type: 'range', label: 'Drehung Y (Laserachse)', min: -180, max: 180, step: 0.5, unit: '°', stage: 'euler', reset: 0 },
        { key: 'rz', type: 'range', label: 'Drehung Z', min: -180, max: 180, step: 0.5, unit: '°', stage: 'euler', reset: 0 },
      ] },
      { title: 'Tiefe & Ausschnitt', step: 3, items: [
        { key: 'clipPct', type: 'range', label: 'Tiefenbereich', min: 1, max: 100, step: 0.5, unit: '%', stage: 'capture', reset: 100,
          extra: v => this.modelDepth ? `= ${fmtNum(this.modelDepth * v / 100, 2)} mm` : '',
          hint: 'Wie tief ins Modell „hineingeschaut“ wird (blaue Ebene). Bei Gesichtern genügen oft 30–50 %, dann nutzt das Gesicht den vollen Graustufenbereich.' },
        { key: 'below', type: 'seg', label: 'Alles dahinter', stage: 'capture',
          options: [['black', 'Schwarz (tiefste Stelle)'], ['transparent', 'Transparent']] },
        { key: 'padPct', type: 'range', label: 'Rand / Zoom', min: -40, max: 60, step: 0.5, unit: '%', stage: 'capture', reset: 4,
          hint: 'Rand um das Motiv. Negative Werte zoomen hinein (Motiv wird beschnitten).' },
        { key: 'offX', type: 'range', label: 'Versatz horizontal', min: -50, max: 50, step: 0.5, unit: '%', stage: 'capture', reset: 0 },
        { key: 'offY', type: 'range', label: 'Versatz vertikal', min: -50, max: 50, step: 0.5, unit: '%', stage: 'capture', reset: 0 },
      ] },
      graySection(4, [
        { type: 'buttons', cols: 2, items: [
          { label: '✨ Auto-Pegel', onClick: () => this.autoLevels(), title: 'Schwarz- und Weißpunkt an das Motiv anpassen' },
          { label: 'Graustufen zurücksetzen', onClick: () => this.resetGray() },
        ] },
      ]),
      outputSection(5, {
        before: [{ key: 'sizeMode', type: 'seg', label: 'Größe', stage: 'capture',
          options: [['fixed', 'Fest (mm)'], ['model', 'Modellmaß 1:1']],
          hint: 'Modellmaß: 1 Einheit im Modell = 1 mm.' }],
        sizeShow: s => s.sizeMode === 'fixed',
      }),
    ];

    this.panel = buildPanel(document.getElementById('model-panel'), schema, s, (key, v, c) => this.onChange(key, v, c));
    this.updateSideButtons();

    // Toolbar im 3D-Fenster
    const tb = document.getElementById('model-toolbar');
    const chipBtn = (label, fn, title) => { const b = h('button', { class: 'chip', type: 'button', title }, label); b.addEventListener('click', fn); tb.append(b); return b; };
    chipBtn('⌂ Ansicht zentrieren', () => this.fitCamera());
    chipBtn('⬇ Laser-Sicht', () => this.laserView(), 'Von oben schauen – so sieht der Laser das Modell');
    this.gizmoChip = chipBtn('🔄 Gizmo', () => this.toggleGizmo());
  }

  onChange(key, v, c) {
    const s = this.state;
    if (key === 'preset') {
      if (applyPreset(s, v)) { this.panel.refresh(); this.capture(); }
      this.save();
      return;
    }
    if (c.stage !== 'preset' && ['sizeMm', 'lpcm', 'shape', 'steps', 'depthMm', 'material', 'bg'].includes(key)) {
      s.preset = 'custom';
    }
    this.save();
    switch (c.stage) {
      case 'side': this.applySide(); break;
      case 'shading': this.rebuildDisplayMesh(); break;
      case 'euler':
        this.pivot.rotation.set(s.rx * DEG, s.ry * DEG, s.rz * DEG);
        s.side = 'custom';
        this.onOrientationChanged(false);
        break;
      case 'capture': this.updateHelpers(); this.recapture(); break;
      case 'process': this.reprocess(); break;
      case 'preview': this.repreview(); break;
    }
    this.panel.refresh();
  }

  updateSideButtons() {
    for (const k of ['top', 'front', 'right', 'bottom', 'back', 'left']) {
      const b = this.panel.els['side-' + k];
      if (b) b.classList.toggle('on', this.state.side === k);
    }
    const on = !!this.gizmo.object;
    this.panel.els['gizmo-btn']?.classList.toggle('on', on);
    this.gizmoChip?.classList.toggle('on', on);
  }

  /* ------------------------------------------------------------ Laden */
  async loadFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    toast(`Lade ${file.name} …`);
    try {
      const buf = await file.arrayBuffer();
      let obj, geo, upAxis = 'z';
      switch (ext) {
        case 'stl': geo = new STLLoader().parse(buf); break;
        case 'ply': geo = new PLYLoader().parse(buf); break;
        case 'obj': obj = new OBJLoader().parse(new TextDecoder().decode(buf)); upAxis = 'y'; break;
        case '3mf': obj = new ThreeMFLoader().parse(buf); break;
        case 'glb': case 'gltf': {
          const gltf = await new GLTFLoader().parseAsync(buf, '');
          obj = gltf.scene; upAxis = 'y'; break;
        }
        default: throw new Error('Dateiformat nicht unterstützt: .' + ext);
      }
      if (!geo) geo = this.collectGeometry(obj);
      if (!geo || !geo.attributes.position || geo.attributes.position.count < 3) throw new Error('Keine Dreiecke im Modell gefunden.');
      this.fileName = file.name;
      this.setGeometry(geo, upAxis);
      toast(`${file.name} geladen – ${fmtNum(this.triCount, 0)} Dreiecke`);
    } catch (err) {
      console.error(err);
      toast('Fehler beim Laden: ' + (err.message || err), true, 6000);
    }
  }

  collectGeometry(obj) {
    obj.updateMatrixWorld(true);
    const list = [];
    obj.traverse(o => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', g.attributes.position.clone());
      pg.applyMatrix4(o.matrixWorld);
      list.push(pg);
    });
    if (!list.length) return null;
    return list.length === 1 ? list[0] : mergeGeometries(list, false);
  }

  loadDemo() {
    // Beispiel: Torusknoten auf einer runden Platte (Z oben, wie eine STL)
    const knot = new THREE.TorusKnotGeometry(12, 3.6, 220, 32, 2, 3);
    knot.scale(1, 1, 0.55);
    knot.translate(0, 0, 4);
    const plate = new THREE.CylinderGeometry(20, 20, 2, 96);
    plate.rotateX(Math.PI / 2);
    plate.translate(0, 0, -1);
    const parts = [knot, plate].map(g => {
      const n = g.toNonIndexed();
      const p = new THREE.BufferGeometry();
      p.setAttribute('position', n.attributes.position);
      return p;
    });
    this.fileName = 'beispiel.stl';
    this.setGeometry(mergeGeometries(parts, false), 'z');
    toast('Beispielmodell geladen');
  }

  setGeometry(geo, upAxis) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', geo.attributes.position);
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    g.computeBoundingBox();
    this.baseGeometry = g;
    this.triCount = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    const size = g.boundingBox.getSize(new THREE.Vector3());
    this.fileInfo.innerHTML = `<b>${this.fileName}</b><br>${fmtNum(size.x, 1)} × ${fmtNum(size.y, 1)} × ${fmtNum(size.z, 1)} mm · ${fmtNum(this.triCount, 0)} Dreiecke`;

    this.state.upAxis = upAxis;
    this.state.side = upAxis === 'z' ? 'top' : 'front';
    this.rebuildDisplayMesh();
    document.getElementById('model-empty').classList.add('hidden');
    document.getElementById('model-legend').classList.remove('hidden');
    this.exportBtn.disabled = false;
    this.applySide(true);
  }

  rebuildDisplayMesh() {
    if (!this.baseGeometry) return;
    if (this.mesh) {
      this.pivot.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    let g;
    if (this.state.smooth) {
      const size = this.baseGeometry.boundingBox.getSize(new THREE.Vector3()).length();
      g = mergeVertices(this.baseGeometry.clone(), size * 1e-5);
    } else {
      g = this.baseGeometry.clone();
    }
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (!this.modelMat) {
      this.modelMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b4, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });
    }
    this.mesh = new THREE.Mesh(g, this.modelMat);
    this.pivot.add(this.mesh);

    if (this.depthMesh) this.depthScene.remove(this.depthMesh);
    this.depthMesh = new THREE.Mesh(g, this.depthMat);
    this.depthMesh.matrixAutoUpdate = false;
    this.depthScene.add(this.depthMesh);
    this.render();
  }

  /* ------------------------------------------------------------ Ausrichtung */
  applySide(fit = false) {
    const s = this.state;
    const def = SIDES[s.upAxis]?.[s.side];
    if (def) {
      const q = basisToWorld(new THREE.Vector3(...def[0]), new THREE.Vector3(...def[1]));
      this.pivot.quaternion.copy(q);
    }
    this.onOrientationChanged(true);
    if (fit) this.fitCamera();
  }

  takeView() {
    if (!this.mesh) return;
    const cb = this.camera.position.clone().sub(this.controls.target).normalize(); // zur Kamera
    const cu = this.camera.up.clone().applyQuaternion(this.camera.quaternion).normalize();
    // Weltrichtungen (cb, cu) → (oben, Bild-Oberkante)
    const A = cb, B = cu.sub(A.clone().multiplyScalar(cu.dot(A))).normalize();
    const C = new THREE.Vector3().crossVectors(A, B);
    const Mc = new THREE.Matrix4().makeBasis(A, B, C);
    const Wc = new THREE.Vector3().crossVectors(WORLD_UP, WORLD_IMGTOP);
    const Mw = new THREE.Matrix4().makeBasis(WORLD_UP, WORLD_IMGTOP, Wc);
    const r = new THREE.Quaternion().setFromRotationMatrix(Mw.multiply(Mc.transpose()));
    this.pivot.quaternion.premultiply(r);
    this.state.side = 'custom';
    this.onOrientationChanged(true);
    this.fitCamera();
    toast('Ansicht übernommen – diese Seite zeigt jetzt zum Laser');
  }

  toggleGizmo() {
    if (!this.mesh) return;
    if (this.gizmo.object) {
      this.gizmo.detach();
      this.scene.remove(this.gizmoHelper);
    } else {
      this.gizmo.attach(this.pivot);
      this.scene.add(this.gizmoHelper);
    }
    this.updateSideButtons();
    this.render();
  }

  onOrientationChanged(syncEuler) {
    const s = this.state;
    if (syncEuler) {
      const e = this.pivot.rotation;
      const r = v => Math.round(v / DEG * 2) / 2 + 0; // +0 vermeidet -0
      s.rx = r(e.x); s.ry = r(e.y); s.rz = r(e.z);
    }
    this.updateSideButtons();
    this.panel.refresh();
    this.updateHelpers();
    this.recapture();
    this.save();
  }

  /* ------------------------------------------------------------ Rahmen / Hilfsobjekte */
  computeFrame() {
    if (!this.mesh) return null;
    const s = this.state;
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.mesh, true);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.modelDepth = size.y;

    let fw = Math.max(size.x, 1e-6), fh = Math.max(size.z, 1e-6);
    const square = s.shape === 'circle' || s.aspect === 'square';
    if (square) fw = fh = Math.max(fw, fh);
    const pad = Math.max(fw, fh) * s.padPct / 100;
    fw = Math.max(fw + 2 * pad, 1e-3); fh = Math.max(fh + 2 * pad, 1e-3);

    const cx = center.x - s.offX / 100 * fw;
    const cz = center.z - s.offY / 100 * fh;

    // Ausgabegröße
    let mmW, mmH;
    if (s.sizeMode === 'model') { mmW = fw; mmH = fh; }
    else { const k = s.sizeMm / Math.max(fw, fh); mmW = fw * k; mmH = fh * k; }

    const clip = Math.max(size.y * s.clipPct / 100, 1e-6);
    return { box, size, fw, fh, cx, cz, top: box.max.y, bottom: box.min.y, clip, mmW, mmH };
  }

  updateHelpers() {
    for (const c of [...this.helpers.children]) { c.geometry?.dispose(); c.material?.dispose(); this.helpers.remove(c); }
    const f = this.frame = this.computeFrame();
    if (!f) { this.render(); return; }
    const s = this.state;
    const yTop = f.top + f.size.y * 0.002;

    // Erfassungsrahmen (oben)
    const pts = [];
    if (s.shape === 'circle') {
      const r = f.fw / 2;
      for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2; pts.push(new THREE.Vector3(f.cx + Math.cos(a) * r, yTop, f.cz + Math.sin(a) * r)); }
    }
    const rect = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new THREE.Vector3(f.cx + a * f.fw / 2, yTop, f.cz + b * f.fh / 2));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xd9a441 });
    this.helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rect), lineMat));
    if (pts.length) this.helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf0c062 })));

    // Markierung der Bild-Oberkante
    const tick = [new THREE.Vector3(f.cx - f.fw * 0.08, yTop, f.cz - f.fh / 2), new THREE.Vector3(f.cx, yTop, f.cz - f.fh / 2 - f.fh * 0.06), new THREE.Vector3(f.cx + f.fw * 0.08, yTop, f.cz - f.fh / 2)];
    this.helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tick), new THREE.LineBasicMaterial({ color: 0xd9a441 })));

    // Tiefen-Grenze
    const planeGeo = new THREE.PlaneGeometry(f.fw, f.fh);
    planeGeo.rotateX(-Math.PI / 2);
    const clipPlane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    clipPlane.position.set(f.cx, f.top - f.clip, f.cz);
    this.helpers.add(clipPlane);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), new THREE.LineBasicMaterial({ color: 0x3d8bfd }));
    edge.position.copy(clipPlane.position);
    this.helpers.add(edge);

    // Laser-Pfeil
    const L = Math.max(f.fw, f.fh);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(f.cx, f.top + L * 0.55, f.cz), L * 0.42, 0xd9a441, L * 0.1, L * 0.06);
    this.helpers.add(arrow);

    // Raster unter das Modell
    const gs = Math.max(L * 2, 10);
    const step = Math.pow(10, Math.floor(Math.log10(gs / 4)));
    const div = Math.max(4, Math.round(gs / step));
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(div * step, div, 0x4a5260, 0x2c323b);
    this.grid.position.set(f.cx, f.bottom - f.size.y * 0.01, f.cz);
    this.scene.add(this.grid);
    this.render();
  }

  fitCamera() {
    const f = this.frame || this.computeFrame();
    if (!f) return;
    const r = Math.max(f.size.length() / 2, Math.max(f.fw, f.fh) * 0.75);
    const dist = r / Math.sin(this.camera.fov * DEG / 2) * 1.3;
    const dir = new THREE.Vector3(0.55, 0.75, 0.95).normalize();
    const target = new THREE.Vector3(f.cx, (f.top + f.bottom) / 2, f.cz);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.near = dist / 100; this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.render();
  }

  laserView() {
    const f = this.frame || this.computeFrame();
    if (!f) return;
    const r = Math.max(f.fw, f.fh) * 0.62;
    const dist = r / Math.sin(this.camera.fov * DEG / 2);
    const target = new THREE.Vector3(f.cx, f.top - f.clip / 2, f.cz);
    this.camera.position.set(f.cx, target.y + dist, f.cz + dist * 0.001);
    this.controls.target.copy(target);
    this.controls.update();
    this.render();
  }

  /* ------------------------------------------------------------ Tiefenbild rendern */
  capture() {
    if (!this.mesh) return;
    const s = this.state;
    this.updateHelpers();
    const f = this.frame;
    const pxPerMm = s.lpcm / 10;
    let W = Math.max(8, Math.round(f.mmW * pxPerMm));
    let H = Math.max(8, Math.round(f.mmH * pxPerMm));
    const maxTex = Math.min(this.renderer.capabilities.maxTextureSize, 16384);
    const maxOut = Math.min(8192, maxTex);
    if (Math.max(W, H) > maxOut) {
      const k = maxOut / Math.max(W, H);
      W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
      toast(`Auflösung auf ${W} × ${H} px begrenzt`, true);
    }
    // Supersampling für saubere Kanten und genauere Höhen
    let ss = W * H <= 1.5e6 ? 3 : W * H <= 6e6 ? 2 : 1;
    while (ss > 1 && Math.max(W, H) * ss > maxTex) ss--;
    const Ws = W * ss, Hs = H * ss;

    // Ortho-Kamera von oben
    const margin = Math.max(f.size.y, f.fw, f.fh) * 0.05 + 1;
    const cam = this.depthCam;
    cam.left = -f.fw / 2; cam.right = f.fw / 2; cam.top = f.fh / 2; cam.bottom = -f.fh / 2;
    cam.near = margin * 0.5; cam.far = margin + f.size.y + margin;
    cam.position.set(f.cx, f.top + margin, f.cz);
    cam.up.set(0, 0, -1);
    cam.lookAt(f.cx, f.bottom - 1, f.cz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.depthMat.uniforms.uNear.value = margin;
    this.depthMat.uniforms.uFar.value = margin + f.clip;

    this.mesh.updateMatrixWorld(true);
    this.depthMesh.matrix.copy(this.mesh.matrixWorld);
    this.depthMesh.matrixWorld.copy(this.mesh.matrixWorld);

    const rt = new THREE.WebGLRenderTarget(Ws, Hs, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true, samples: 0 });
    const r = this.renderer;
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.depthScene, cam);
    const buf = new Uint8Array(Ws * Hs * 4);
    r.readRenderTargetPixels(rt, 0, 0, Ws, Hs, buf);
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    rt.dispose();

    // Dekodieren + Herunterrechnen (Zeilen von unten nach oben)
    const height = new Float32Array(W * H), alpha = new Float32Array(W * H);
    const belowTransparent = s.below === 'transparent';
    const inv = 1 / (ss * ss);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, cnt = 0;
        for (let sy = 0; sy < ss; sy++) {
          const ry = Hs - 1 - (y * ss + sy);
          let idx = (ry * Ws + x * ss) * 4;
          for (let sx = 0; sx < ss; sx++, idx += 4) {
            const a = buf[idx + 3];
            if (a === 0) continue;
            if (a < 200) { if (!belowTransparent) cnt++; continue; }
            sum += (buf[idx] + buf[idx + 1] / 255 + buf[idx + 2] / 65025) / 255;
            cnt++;
          }
        }
        const i = y * W + x;
        alpha[i] = cnt * inv;
        height[i] = cnt ? sum / cnt : 0;
      }
    }
    this.raw = { w: W, h: H, height, alpha, mmW: f.mmW, mmH: f.mmH };
    this.panel.refresh();
    this.process();
  }

  process() {
    if (!this.raw) return;
    const s = this.state;
    this.result = processHeight(this.raw, s, s.lpcm / 10);
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
    if (this.panel.els.laserInfo) this.panel.els.laserInfo.innerHTML = laserInfoHTML(s, this.result, this.raw.mmW, this.raw.mmH);
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
    const base = safeBase(this.fileName);
    const name = `${base}_depthmap_${fmtNum(this.raw.mmW, 1).replace(',', '.')}x${fmtNum(this.raw.mmH, 1).replace(',', '.')}mm${s.invert ? '_negativ' : ''}.png`;
    exportPNG(this.result, name, this.result.w / this.raw.mmW * 25.4);
    toast('PNG exportiert: ' + name);
  }

  activate() {
    this.resize();
    this.relief.resize();
  }
}
