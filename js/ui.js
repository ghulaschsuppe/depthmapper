// Kleine UI-Hilfsfunktionen: Einstellungs-Panels aus einem Schema bauen, Toast, Drag & Drop.

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function fmtNum(v, digits = 1) {
  return Number(v).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

let toastTimer = 0;
export function toast(msg, isError = false, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}
export { h };

function decimals(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/**
 * Baut Einstellungs-Sektionen.
 * schema: [{ title, step, open, items: [ control, ... ] }]
 * control-Typen: range, select, seg, check, buttons, info, custom
 * onChange(key, value, control) wird bei jeder Änderung aufgerufen.
 */
export function buildPanel(root, schema, state, onChange) {
  const refreshers = [];
  const visibility = [];
  const els = {};

  for (const sec of schema) {
    const body = h('div', { class: 'sec-body' });
    const det = h('details', { class: 'sec' },
      h('summary', {}, sec.step ? h('span', { class: 'step-no' }, String(sec.step)) : null, sec.title),
      body);
    if (sec.open !== false) det.open = true;
    if (sec.id) els[sec.id] = det;
    root.append(det);

    for (const c of sec.items) {
      const el = makeControl(c, state, onChange, refreshers, els);
      if (!el) continue;
      body.append(el);
      if (c.show) visibility.push([el, c.show]);
    }
  }

  const refresh = () => {
    for (const r of refreshers) r();
    for (const [el, fn] of visibility) el.classList.toggle('hidden', !fn(state));
  };
  refresh();
  return { refresh, els };
}

function headFor(c, extraEl) {
  return h('div', { class: 'ctl-head' },
    h('span', { class: 'lbl' }, c.label,
      c.hint ? h('span', { class: 'hint-i', title: c.hint }, 'i') : null),
    extraEl || null);
}

function makeControl(c, state, onChange, refreshers, els) {
  switch (c.type) {
    case 'range': {
      const dec = c.decimals ?? decimals(c.step ?? 1);
      const range = h('input', { type: 'range', min: c.min, max: c.max, step: c.step ?? 1 });
      const num = h('input', { type: 'number', class: 'num', min: c.numMin ?? c.min, max: c.numMax ?? c.max, step: c.step ?? 1 });
      const extra = c.extra ? h('span', { class: 'extra' }) : null;
      const unit = h('span', { class: 'unit' }, c.unit || '');
      const set = (v, fromNum) => {
        v = Number(v);
        if (!Number.isFinite(v)) return;
        const lo = c.numMin ?? c.min, hi = c.numMax ?? c.max;
        v = Math.min(hi, Math.max(lo, v));
        state[c.key] = v;
        if (!fromNum) num.value = v.toFixed(dec);
        range.value = v;
        if (extra) extra.textContent = c.extra(v, state);
        onChange(c.key, v, c);
      };
      range.addEventListener('input', () => set(range.value));
      num.addEventListener('change', () => { set(num.value, true); num.value = Number(state[c.key]).toFixed(dec); });
      num.addEventListener('keydown', e => { if (e.key === 'Enter') num.blur(); });
      // Doppelklick setzt auf Standardwert zurück
      if (c.reset !== undefined) range.addEventListener('dblclick', () => set(c.reset));
      refreshers.push(() => {
        const v = state[c.key];
        range.value = v;
        num.value = Number(v).toFixed(dec);
        if (c.dynMax) range.max = c.dynMax(state);
        if (extra) extra.textContent = c.extra(v, state);
      });
      const el = h('div', { class: 'ctl' }, headFor(c, extra), h('div', { class: 'range-row' }, range, num, unit));
      if (c.id) els[c.id] = el;
      return el;
    }
    case 'select': {
      const sel = h('select');
      const fill = () => {
        const opts = typeof c.options === 'function' ? c.options(state) : c.options;
        sel.innerHTML = '';
        for (const [v, l] of opts) sel.append(h('option', { value: v }, l));
      };
      fill();
      sel.addEventListener('change', () => {
        const v = c.numeric ? Number(sel.value) : sel.value;
        state[c.key] = v;
        onChange(c.key, v, c);
      });
      refreshers.push(() => { if (typeof c.options === 'function') fill(); sel.value = String(state[c.key]); });
      return h('label', { class: 'ctl' }, headFor(c), sel);
    }
    case 'seg': {
      const wrap = h('div', { class: 'seg' });
      const btns = c.options.map(([v, l]) => {
        const b = h('button', { type: 'button', title: l }, l);
        b.addEventListener('click', () => {
          state[c.key] = v;
          refreshers.forEach(r => r());
          onChange(c.key, v, c);
        });
        b._v = v;
        wrap.append(b);
        return b;
      });
      refreshers.push(() => btns.forEach(b => b.classList.toggle('on', b._v === state[c.key])));
      return h('div', { class: 'ctl' }, headFor(c), wrap);
    }
    case 'check': {
      const inp = h('input', { type: 'checkbox' });
      inp.addEventListener('change', () => { state[c.key] = inp.checked; onChange(c.key, inp.checked, c); });
      refreshers.push(() => { inp.checked = !!state[c.key]; });
      return h('label', { class: 'check' }, inp, h('span', { class: 'sw' }),
        h('span', {}, c.label, c.hint ? h('span', { class: 'hint-i', title: c.hint }, 'i') : null));
    }
    case 'buttons': {
      const grid = h('div', { class: 'btn-grid' + (c.cols ? ' cols-' + c.cols : '') });
      for (const b of c.items) {
        const btn = h('button', { type: 'button', class: 'btn' + (b.primary ? ' primary' : ''), title: b.title || '' }, b.label);
        btn.addEventListener('click', () => b.onClick(btn));
        if (b.id) els[b.id] = btn;
        grid.append(btn);
      }
      const wrap = h('div', { class: 'ctl' }, c.label ? h('div', { class: 'sub-label' }, c.label) : null, grid);
      return wrap;
    }
    case 'info': {
      const el = h('div', { class: 'info-box' });
      els[c.id] = el;
      return el;
    }
    case 'custom': {
      const el = c.build(els);
      return el;
    }
  }
  return null;
}

/** Drag & Drop auf ein Element */
export function setupDrop(el, onFile) {
  let depth = 0;
  el.addEventListener('dragenter', e => { e.preventDefault(); depth++; el.classList.add('drag-over'); });
  el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drag-over'); } });
  el.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; el.classList.remove('drag-over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

/** Einstellungen lokal merken (fehlertolerant) */
export function loadSettings(key, defaults) {
  try {
    const raw = localStorage.getItem('depthmapper.' + key);
    if (raw) {
      const obj = JSON.parse(raw);
      const out = { ...defaults };
      for (const k of Object.keys(defaults)) if (k in obj && typeof obj[k] === typeof defaults[k]) out[k] = obj[k];
      return out;
    }
  } catch { /* ignorieren */ }
  return { ...defaults };
}
export function saveSettings(key, state) {
  try { localStorage.setItem('depthmapper.' + key, JSON.stringify(state)); } catch { /* ignorieren */ }
}
