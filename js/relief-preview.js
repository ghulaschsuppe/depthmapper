// 3D-Vorschau einer Depthmap als graviertes Werkstück (z. B. Messing-Münze).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MATERIALS } from './presets.js';

export class ReliefPreview {
  constructor(container, { quality = 320 } = {}) {
    this.container = container;
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    this.camera.position.set(0, 60, 50);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());
    this.renderer.domElement.addEventListener('dblclick', () => this.fit());
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    // Streiflicht von links oben – macht das Relief gut sichtbar
    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.scene.add(this.key);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303030, 0.35));

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.lastDims = '';

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.fit();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    for (const c of [...this.group.children]) {
      c.geometry.dispose();
      c.material.dispose();
      this.group.remove(c);
    }
  }

  /**
   * result: Ausgabe von processHeight; opt: { mmW, mmH, depthMm, exag, material, shape, corner }
   */
  update(result, opt) {
    this.clear();
    if (!result) { this.render(); return; }
    const { w: W, h: H, rgba, shape } = result;
    const mat = MATERIALS[opt.material] || MATERIALS.brass;
    const D = Math.max(0.001, opt.depthMm * opt.exag);
    const mmW = opt.mmW, mmH = opt.mmH;

    // Gitter (heruntergerechnet)
    const q = this.quality;
    let gw, gh;
    if (W >= H) { gw = Math.min(W, q); gh = Math.max(2, Math.round(gw * H / W)); }
    else { gh = Math.min(H, q); gw = Math.max(2, Math.round(gh * W / H)); }
    gw = Math.max(2, gw); gh = Math.max(2, gh);

    // Tiefe je Pixel: Mittelwert über die Zelle (Flächen-Sampling)
    const nV = gw * gh;
    const pos = new Float32Array(nV * 3);
    const col = new Float32Array(nV * 3);
    const inside = new Uint8Array(nV);
    const cS = new THREE.Color(mat.color), cE = new THREE.Color(mat.engraved);
    const tmp = new THREE.Color();
    const sx = W / gw, sy = H / gh;

    for (let j = 0; j < gh; j++) {
      const py0 = Math.floor(j * sy), py1 = Math.max(py0 + 1, Math.floor((j + 1) * sy));
      const pyc = Math.min(H - 1, Math.floor((j + 0.5) * sy));
      for (let i = 0; i < gw; i++) {
        const px0 = Math.floor(i * sx), px1 = Math.max(px0 + 1, Math.floor((i + 1) * sx));
        const pxc = Math.min(W - 1, Math.floor((i + 0.5) * sx));
        const vi = j * gw + i;
        const ins = shape[pyc * W + pxc];
        inside[vi] = ins;
        let depth = 0;
        if (ins) {
          let sum = 0, cnt = 0;
          for (let y = py0; y < py1 && y < H; y++) {
            for (let x = px0; x < px1 && x < W; x++) {
              const p = (y * W + x) * 4;
              const a = rgba[p + 3] / 255;
              sum += (1 - rgba[p] / 255) * a; // graviert nur, wo deckend
              cnt++;
            }
          }
          depth = cnt ? sum / cnt : 0;
        }
        pos[vi * 3] = ((i + 0.5) / gw - 0.5) * mmW;
        pos[vi * 3 + 1] = -depth * D;
        pos[vi * 3 + 2] = ((j + 0.5) / gh - 0.5) * mmH;
        tmp.copy(cS).lerp(cE, Math.min(1, depth > 0.001 ? 0.35 + depth * 0.65 : 0));
        col[vi * 3] = tmp.r; col[vi * 3 + 1] = tmp.g; col[vi * 3 + 2] = tmp.b;
      }
    }

    const idx = [];
    for (let j = 0; j < gh - 1; j++) {
      for (let i = 0; i < gw - 1; i++) {
        const a = j * gw + i, b = a + gw, c = a + 1, d = b + 1;
        if (inside[a] && inside[b] && inside[c]) idx.push(a, b, c);
        if (inside[c] && inside[b] && inside[d]) idx.push(c, b, d);
      }
    }

    // Randkanten bestimmen (Kanten, die nur zu einem Dreieck gehören)
    const boundary = this.boundaryEdges(idx);
    if (opt.shape === 'circle') {
      // Randpunkte exakt auf den Kreis schieben → glatter Münzrand
      const r = Math.min(mmW, mmH) / 2;
      for (const [a, b] of boundary) {
        for (const v of [a, b]) {
          const x = pos[v * 3], z = pos[v * 3 + 2];
          const d = Math.hypot(x, z);
          if (d > r * 0.85) { pos[v * 3] = x / d * r; pos[v * 3 + 2] = z / d * r; }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(nV > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const surfMat = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: mat.metalness, roughness: mat.roughness,
    });
    this.group.add(new THREE.Mesh(geo, surfMat));

    // Seitliche Schürze entlang des Randes bis unter die tiefste Stelle
    const skirt = this.buildSkirt(boundary, pos, D);
    if (skirt) {
      this.group.add(new THREE.Mesh(skirt, new THREE.MeshStandardMaterial({
        color: mat.color, metalness: mat.metalness, roughness: mat.roughness + 0.1, side: THREE.DoubleSide,
      })));
    }

    // Werkstück-Körper
    const thick = Math.max(1, Math.min(mmW, mmH) * 0.06);
    const body = this.buildBody(opt, mmW, mmH, thick);
    body.translate(0, -D - thick / 2 - 0.0005, 0);
    this.group.add(new THREE.Mesh(body, new THREE.MeshStandardMaterial({
      color: mat.color, metalness: mat.metalness, roughness: mat.roughness + 0.1,
    })));

    // Licht & Kamera
    const L = Math.max(mmW, mmH);
    this.key.position.set(-L * 0.9, L * 0.9, -L * 0.45);
    const dims = `${mmW.toFixed(2)}x${mmH.toFixed(2)}`;
    this.fitInfo = { L, D };
    if (dims !== this.lastDims) {
      this.lastDims = dims;
      this.fit();
    }
    this.render();
  }

  boundaryEdges(idx) {
    const edges = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = idx[t + e], b = idx[t + (e + 1) % 3];
        const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        if (edges.has(k)) edges.set(k, null); else edges.set(k, [a, b]);
      }
    }
    const out = [];
    for (const v of edges.values()) if (v) out.push(v);
    return out;
  }

  buildSkirt(boundary, pos, D) {
    const verts = [];
    const bottom = -D - 0.001;
    for (const [a, b] of boundary) {
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      verts.push(ax, ay, az, bx, by, bz, bx, bottom, bz);
      verts.push(ax, ay, az, bx, bottom, bz, ax, bottom, az);
    }
    if (!verts.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    return g;
  }

  /** Kamera so setzen, dass das ganze Werkstück sichtbar ist */
  fit() {
    if (!this.fitInfo) return;
    const { L, D } = this.fitInfo;
    const R = L * 0.62;
    const vf = this.camera.fov * Math.PI / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    const dist = R / Math.sin(Math.min(vf, hf) / 2);
    const dir = new THREE.Vector3(0, 1.25, 0.95).normalize();
    this.camera.near = dist / 100; this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(dir.multiplyScalar(dist));
    this.controls.target.set(0, -D / 2, 0);
    this.controls.update();
    this.userMoved = false;
    this.render();
  }

  buildBody(opt, mmW, mmH, thick) {
    if (opt.shape === 'circle') {
      const r = Math.min(mmW, mmH) / 2;
      return new THREE.CylinderGeometry(r, r, thick, 128);
    }
    if (opt.shape === 'rounded') {
      const r = Math.min(mmW, mmH) * Math.min(50, opt.corner) / 100;
      const s = new THREE.Shape();
      const x0 = -mmW / 2, y0 = -mmH / 2;
      s.moveTo(x0 + r, y0);
      s.lineTo(x0 + mmW - r, y0);
      s.quadraticCurveTo(x0 + mmW, y0, x0 + mmW, y0 + r);
      s.lineTo(x0 + mmW, y0 + mmH - r);
      s.quadraticCurveTo(x0 + mmW, y0 + mmH, x0 + mmW - r, y0 + mmH);
      s.lineTo(x0 + r, y0 + mmH);
      s.quadraticCurveTo(x0, y0 + mmH, x0, y0 + mmH - r);
      s.lineTo(x0, y0 + r);
      s.quadraticCurveTo(x0, y0, x0 + r, y0);
      const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 16 });
      g.rotateX(-Math.PI / 2);
      g.translate(0, -thick / 2, 0);
      return g;
    }
    return new THREE.BoxGeometry(mmW, thick, mmH);
  }

  snapshot() {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}
