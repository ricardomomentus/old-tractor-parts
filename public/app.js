// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

async function api(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Sesión vencida');
  }
  return res;
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (!confirm('¿Cerrar sesión?')) return;
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storeSet(key, val) { try { localStorage.setItem(key, val); } catch { /* nada */ } }

const EMPTY_VALUES = new Set(['', 'unknown', 'n/a', 'na', 'none', 'desconocido']);
function hasValue(v) {
  return v != null && !EMPTY_VALUES.has(String(v).trim().toLowerCase());
}

function formatPrice(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

let appConfig = { whatsappCountryCode: '1' };
api('/api/config').then(r => r.json()).then(c => { appConfig = c; }).catch(() => {});

// State
let selectedPhotos = [];
let currentPart = null;

// IndexedDB for pending photos (survives iOS reloads)
function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('otp_pending', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePendingPhotos() {
  try {
    const db = await openPhotoDb();
    const tx = db.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    store.clear();
    selectedPhotos.forEach((f, i) => store.put(f, i));
  } catch { /* IndexedDB no disponible */ }
}

async function clearPendingPhotos() {
  try {
    const db = await openPhotoDb();
    db.transaction('photos', 'readwrite').objectStore('photos').clear();
  } catch { /* nada */ }
}

async function restorePendingPhotos() {
  try {
    const db = await openPhotoDb();
    const tx = db.transaction('photos', 'readonly');
    const store = tx.objectStore('photos');
    const keys = await new Promise(r => { const req = store.getAllKeys(); req.onsuccess = () => r(req.result); });
    for (const key of keys) {
      const file = await new Promise(r => { const req = store.get(key); req.onsuccess = () => r(req.result); });
      if (file) selectedPhotos.push(file);
    }
    if (selectedPhotos.length) {
      renderPreviews();
      switchView('camera');
    }
  } catch { /* nada */ }
}

// ---------- Navigation ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

function switchView(view) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  if (view === 'list') loadParts();
}

// ---------- Status ----------
const STATUS_INFO = {
  pending:  { label: 'Pendiente', badge: 'badge-pending' },
  approved: { label: 'Aprobada',  badge: 'badge-approved' },
  posted:   { label: 'Publicada', badge: 'badge-posted' },
  sold:     { label: 'Vendida',   badge: 'badge-sold' },
};

const FILTERS = {
  active:   ['pending', 'approved', 'posted'],
  pending:  ['pending'],
  approved: ['approved'],
  posted:   ['posted'],
  sold:     ['sold'],
  all:      ['pending', 'approved', 'posted', 'sold'],
};

// ---------- Search ----------
const SEARCH_SYNONYMS = {
  'metal de biela': 'rod bearing', 'biela': 'rod bearing',
  'metal de bancada': 'main bearing', 'bancada': 'main bearing',
  'camisa': 'cylinder sleeve', 'camisa de cilindro': 'cylinder sleeve',
  'anillos': 'piston ring', 'pistón': 'piston', 'piston': 'piston',
  'bujes': 'bushing', 'buje': 'bushing',
  'válvula': 'valve', 'guía': 'guide', 'sello': 'seal',
  'empaque': 'gasket', 'junta': 'gasket',
};

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matchesSearch(p, tokens) {
  if (!tokens.length) return true;
  // Search across all relevant fields, including part_number without dashes/spaces
  const partNumClean = String(p.part_number || '').replace(/[-\s]/g, '').toLowerCase();
  const oemClean = String(p.oem_number || '').replace(/[-\s]/g, '').toLowerCase();
  const hay = norm([
    p.part_brand, p.tractor_brand, p.tractor_model,
    p.part_type_es, p.part_type_en, p.part_number, p.oem_number,
    p.measurement, p.location, `#${p.id}`
  ].join(' '));
  return tokens.every(t => {
    if (hay.includes(t)) return true;
    // Flexible part number search (ignore dashes/spaces)
    const tClean = t.replace(/[-\s]/g, '');
    if (tClean.length >= 3 && (partNumClean.includes(tClean) || oemClean.includes(tClean))) return true;
    if (t.length >= 3) {
      for (const [es, en] of Object.entries(SEARCH_SYNONYMS)) {
        if (es.startsWith(t) && hay.includes(en)) return true;
      }
    }
    return false;
  });
}

let allParts = [];
let currentFilter = FILTERS[storeGet('filter')] ? storeGet('filter') : 'active';
let listScrollY = 0;

const searchInput = document.getElementById('search');
const searchClear = document.getElementById('search-clear');

async function loadParts() {
  const list = document.getElementById('parts-list');
  if (!allParts.length) list.innerHTML = '<div class="spinner"></div>';
  try {
    const res = await api('/api/parts');
    if (!res.ok) throw new Error(`Error ${res.status}`);
    allParts = await res.json();
    renderList();
    window.scrollTo(0, listScrollY);
  } catch (err) {
    if (err.message === 'Sesión vencida') return;
    list.innerHTML = `
      <div class="alert alert-error">
        No se pudo cargar el inventario. ${navigator.onLine ? '' : 'Parece que no hay internet.'}
      </div>
      <button class="btn btn-outline" onclick="loadParts()">🔄 Reintentar</button>`;
  }
}

function renderList() {
  const tokens = norm(searchInput.value).split(/\s+/).filter(Boolean);
  const searched = allParts.filter(p => matchesSearch(p, tokens));

  document.querySelectorAll('.chip').forEach(chip => {
    const statuses = FILTERS[chip.dataset.filter];
    const n = searched.filter(p => statuses.includes(p.status || 'pending')).length;
    chip.querySelector('.chip-count').textContent = n;
    chip.classList.toggle('active', chip.dataset.filter === currentFilter);
  });

  const statuses = FILTERS[currentFilter];
  const shown = searched.filter(p => statuses.includes(p.status || 'pending'));
  const list = document.getElementById('parts-list');
  const empty = document.getElementById('empty-state');

  if (!allParts.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  if (!shown.length) {
    list.innerHTML = tokens.length
      ? `<div class="empty"><p>No encontré nada con "${esc(searchInput.value.trim())}"</p>
           <button class="btn btn-outline" onclick="clearSearch()">✕ Borrar búsqueda</button></div>`
      : '<div class="empty"><p>No hay piezas en este filtro</p></div>';
    return;
  }

  list.innerHTML = shown.map(partCard).join('');
}

function partCard(p) {
  const title = [p.part_brand, p.part_number].filter(hasValue).join(' ') || 'Sin identificar';
  const subtitle = [p.part_type_es || p.part_type_en, p.tractor_brand].filter(hasValue).join(' — ');
  const st = STATUS_INFO[p.status] || STATUS_INFO.pending;
  const thumbSrc = p.photos?.[0]?.thumbnail || p.photos?.[0]?.filename;
  const thumb = thumbSrc
    ? `<img src="/uploads/${esc(thumbSrc)}" alt="" loading="lazy">`
    : '<span class="no-photo">📷</span>';
  const meta = [
    hasValue(p.measurement) ? p.measurement : '',
    hasValue(p.quantity) ? `×${p.quantity}` : '',
    hasValue(p.location) ? `📍${p.location}` : '',
  ].filter(Boolean).map(m => `<span>${esc(m)}</span>`).join('');

  let lowConf = '';
  const confLow = ['baja', 'low'].includes(String(p.confidence || '').toLowerCase());
  if (p.status === 'pending' && p.ai_error) lowConf = '<span class="card-badge badge-low">⚠️ Sin identificar</span>';
  else if (p.status === 'pending' && confLow) lowConf = '<span class="card-badge badge-low">⚠️ Revisar</span>';

  let verifyBadge = '';
  if (p.verification_match === 1) verifyBadge = '<span class="card-badge badge-approved">✅ 2 IA</span>';
  else if (p.verification_match === 0 && !p.ai_error) verifyBadge = '<span class="card-badge badge-low">⚠️ IA difieren</span>';

  return `
    <button class="part-card" data-id="${p.id}" type="button">
      <div class="card-thumb">${thumb}</div>
      <div class="card-info">
        <div class="card-title">${esc(title)}</div>
        ${subtitle ? `<div class="card-meta"><span>${esc(subtitle)}</span></div>` : ''}
        <div class="card-meta">${meta}</div>
        <div class="card-badges">
          <span class="card-badge ${st.badge}">${st.label}</span>
          ${verifyBadge}
          ${lowConf}
          ${p.price ? `<span class="card-price">$${formatPrice(p.price)}</span>` : ''}
        </div>
      </div>
    </button>`;
}

document.getElementById('parts-list').addEventListener('click', e => {
  const card = e.target.closest('.part-card');
  if (!card) return;
  listScrollY = window.scrollY;
  openDetail(card.dataset.id);
});

document.getElementById('filter-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  currentFilter = chip.dataset.filter;
  storeSet('filter', currentFilter);
  listScrollY = 0;
  renderList();
  chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
});

let searchTimer;
searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 120);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') searchInput.blur();
  if (e.key === 'Escape') clearSearch();
});

window.clearSearch = function() {
  searchInput.value = '';
  searchClear.hidden = true;
  renderList();
};
searchClear.addEventListener('click', () => { clearSearch(); searchInput.focus(); });

// ---------- Camera / upload ----------
const MAX_PHOTOS = 4;
const submitBtn = document.getElementById('submit-btn');

async function addPhotos(fileList) {
  const files = Array.from(fileList || []);
  const room = MAX_PHOTOS - selectedPhotos.length;
  if (files.length > room) toast(`Máximo ${MAX_PHOTOS} fotos por pieza`, 'error');
  for (const file of files.slice(0, room)) {
    try {
      selectedPhotos.push(await compressImage(file));
    } catch {
      toast(`No se pudo leer la foto "${file.name}"`, 'error');
    }
    renderPreviews();
  }
  savePendingPhotos();
}

['photo-input', 'gallery-input'].forEach(id => {
  document.getElementById(id).addEventListener('change', e => {
    addPhotos(e.target.files);
    e.target.value = '';
  });
});

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(src);
      const canvas = document.createElement('canvas');
      const MAX = 1200;
      let w = img.width, h = img.height;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('compress'));
        resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('decode')); };
    img.src = src;
  });
}

let previewUrls = [];
function renderPreviews() {
  previewUrls.forEach(u => URL.revokeObjectURL(u));
  previewUrls = selectedPhotos.map(f => URL.createObjectURL(f));
  document.getElementById('photo-previews').innerHTML = previewUrls.map((url, i) => `
    <div class="preview-thumb">
      <img src="${url}" alt="foto ${i + 1}">
      <button class="remove" type="button" onclick="removePhoto(${i})" aria-label="Quitar foto ${i + 1}">✕</button>
    </div>
  `).join('');
  const n = selectedPhotos.length;
  const count = document.getElementById('photo-count');
  count.hidden = n === 0;
  count.textContent = n >= MAX_PHOTOS ? `${n} de ${MAX_PHOTOS} fotos (máximo)` : `${n} de ${MAX_PHOTOS} fotos`;
  submitBtn.disabled = n === 0;
  document.getElementById('capture-btn').hidden = n >= MAX_PHOTOS;
  document.getElementById('gallery-btn').hidden = n >= MAX_PHOTOS;
}

window.removePhoto = function(i) {
  selectedPhotos.splice(i, 1);
  renderPreviews();
  savePendingPhotos();
};

const uploadUI = {
  actions: document.getElementById('camera-actions'),
  status: document.getElementById('upload-status'),
  error: document.getElementById('upload-error'),
  title: document.getElementById('status-title'),
  sub: document.getElementById('status-sub'),
  progress: document.getElementById('progress'),
  bar: document.getElementById('progress-bar'),
};
let uploadTimer = null;
let uploading = false;

function showUploadPhase(phase, pct = 0) {
  uploadUI.actions.hidden = true;
  uploadUI.error.hidden = true;
  uploadUI.status.hidden = false;
  if (phase === 'upload') {
    uploadUI.title.textContent = `📤 Subiendo fotos… ${Math.round(pct * 100)}%`;
    uploadUI.progress.hidden = false;
    uploadUI.bar.style.width = `${Math.round(pct * 100)}%`;
    uploadUI.sub.textContent = 'No cierres la app.';
  } else if (phase === 'identify' && !uploadTimer) {
    uploadUI.title.textContent = '🤖 Identificando con 2 IA…';
    uploadUI.progress.hidden = true;
    const started = Date.now();
    const tick = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      uploadUI.sub.textContent = secs < 30
        ? `⏱ ${secs} s — normalmente tarda de 10 a 30 segundos (2 modelos). No cierres la app.`
        : `⏱ ${secs} s — está tardando más de lo normal, pero sigue trabajando…`;
    };
    tick();
    uploadTimer = setInterval(tick, 1000);
  }
}

function hideUploadPhase() {
  clearInterval(uploadTimer);
  uploadTimer = null;
  uploadUI.status.hidden = true;
}

function showUploadError(message) {
  hideUploadPhase();
  uploadUI.actions.hidden = true;
  uploadUI.error.hidden = false;
  document.getElementById('upload-error-msg').textContent = message;
}

function uploadPart(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/parts');
    xhr.timeout = 180000;
    xhr.upload.onprogress = e => { if (e.lengthComputable) showUploadPhase('upload', e.loaded / e.total); };
    xhr.upload.onload = () => showUploadPhase('identify');
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* respuesta no JSON */ }
      if (xhr.status === 401) { location.href = '/login'; return reject(new Error('Sesión vencida')); }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      reject(new Error(data.error || `El servidor respondió con error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('NETWORK'));
    xhr.ontimeout = () => reject(new Error('TIMEOUT'));
    xhr.send(formData);
  });
}

async function submitPhotos() {
  if (!selectedPhotos.length || uploading) return;
  if (!navigator.onLine) {
    return showUploadError('📶 No hay internet. Tus fotos siguen aquí; intenta de nuevo cuando tengas señal.');
  }
  uploading = true;
  showUploadPhase('upload', 0);
  const formData = new FormData();
  selectedPhotos.forEach(f => formData.append('photos', f));
  try {
    const part = await uploadPart(formData);
    hideUploadPhase();
    uploadUI.actions.hidden = false;
    selectedPhotos = [];
    renderPreviews();
    clearPendingPhotos();
    await openDetail(part.id);
    if (part.ai_error) toast('La pieza se guardó, pero la IA no pudo identificarla', 'error');
    else toast('Pieza identificada ✓ Revisa los datos');
  } catch (err) {
    if (err.message === 'Sesión vencida') return;
    const msg = {
      NETWORK: '📶 No se pudo enviar: se cortó la conexión. Tus fotos siguen aquí; intenta de nuevo.',
      TIMEOUT: '⏱ El servidor tardó demasiado en responder. Intenta de nuevo.',
    }[err.message] || `❌ ${err.message}`;
    showUploadError(msg);
  } finally {
    uploading = false;
  }
}

submitBtn.addEventListener('click', submitPhotos);
document.getElementById('retry-upload-btn').addEventListener('click', submitPhotos);
document.getElementById('cancel-upload-btn').addEventListener('click', () => {
  uploadUI.error.hidden = true;
  uploadUI.actions.hidden = false;
});
window.addEventListener('beforeunload', e => { if (uploading) e.preventDefault(); });

// ---------- Detail ----------
let detailDirty = false;

async function openDetail(id) {
  try {
    const res = await api(`/api/parts/${id}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'Esa pieza ya no existe' : `Error ${res.status}`);
    const part = await res.json();
    currentPart = part;
    renderDetail(part);
    detailDirty = false;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-detail').classList.add('active');
  } catch (err) {
    if (err.message === 'Sesión vencida') return;
    toast(err.message === 'Failed to fetch' ? 'Sin conexión. Intenta de nuevo.' : err.message, 'error');
  }
}

const NEXT_STEP = {
  pending:  { status: 'approved', label: '✓ Aprobar', cls: 'btn-success', done: 'Aprobada ✓' },
  approved: { status: 'posted', label: '📢 Marcar publicada', cls: 'btn-posted', done: 'Marcada como publicada 📢' },
  posted:   { status: 'sold', label: '💰 Marcar vendida', cls: 'btn-primary', done: 'Marcada como vendida 💰' },
};
const PREV_STATUS = { approved: 'pending', posted: 'approved', sold: 'posted' };

const COND_OPTS = ['New Old Stock', 'New', 'Used - Good', 'Used - Fair'];

function selectField(id, value, opts) {
  let v = hasValue(value) ? String(value) : '';
  const list = v && !opts.includes(v) ? [...opts, v] : opts;
  return `<select class="field-input" id="${id}">
    <option value="" ${v ? '' : 'selected'}>— Sin definir —</option>
    ${list.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}
  </select>`;
}

function textField(id, label, value, placeholder, opts = {}) {
  const type = opts.type || 'text';
  const inputmode = opts.inputmode || '';
  const step = opts.step || '';
  const warn = opts.warn;
  const attrs = [
    `class="field-input"`,
    `id="${id}"`,
    `value="${esc(hasValue(value) ? value : '')}"`,
    `placeholder="${esc(placeholder)}"`,
    type !== 'text' ? `type="${type}"` : '',
    inputmode ? `inputmode="${inputmode}"` : '',
    step ? `step="${step}"` : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="field-group">
      <label class="field-label" for="${id}">${warn ? '<span class="verify">⚠️</span>' : ''}${label}</label>
      <input ${attrs}>
    </div>`;
}

function renderDetail(p) {
  const status = STATUS_INFO[p.status] ? p.status : 'pending';
  const st = STATUS_INFO[status];
  const confLow = ['baja', 'low'].includes(String(p.confidence || '').toLowerCase());
  const next = NEXT_STEP[status];
  const prev = PREV_STATUS[status];

  const photos = (p.photos || []).map((ph, i) =>
    `<img src="/uploads/${esc(ph.filename)}" alt="foto de la pieza" onclick="openLightbox(${i})">`
  ).join('');

  // Verification badge
  let verifyHtml = '';
  if (p.verification_match === 1) {
    verifyHtml = '<div class="alert" style="background:#16a34a22;border-color:#22c55e">✅ Las 2 IA coinciden</div>';
  } else if (p.verification_match === 0 && p.verification_diffs) {
    verifyHtml = `<div class="alert alert-warn">⚠️ Las IA difieren: ${esc(p.verification_diffs)}</div>`;
  }

  // eBay preview
  const ebayPreview = status !== 'pending' && p.ebay_title ? `
    <div class="fb-preview">
      <h3>🏷️ Para eBay</h3>
      <div class="fb-field">
        <span class="fb-label">Título (${p.ebay_title.length}/80):</span>
        <span class="fb-value" id="ebay-title-val">${esc(p.ebay_title)}</span>
        <button class="fb-copy-sm" onclick="copyField('ebay-title-val')">📋</button>
      </div>
      <div class="fb-field">
        <span class="fb-label">Descripción:</span>
        <span class="fb-value" id="ebay-desc-val">${esc(p.ebay_description || '')}</span>
        <button class="fb-copy-sm" onclick="copyField('ebay-desc-val')">📋</button>
      </div>
      <button class="btn btn-outline copy-btn" onclick="copyEbayPost()">📋 Copiar todo eBay</button>
    </div>` : '';

  // FB Marketplace preview
  const fbPhotos = (p.photos || []).map((ph, i) =>
    `<div class="fb-photo-wrap">
      <img src="/uploads/${esc(ph.filename)}" alt="foto ${i + 1}">
      <button class="fb-copy-sm fb-copy-img" onclick="copyImage('/uploads/${esc(ph.filename)}', this)">📋 Copiar foto</button>
    </div>`
  ).join('');

  const fbPreview = status !== 'pending' && p.fb_title ? `
    <div class="fb-preview">
      <h3>📦 Para FB Marketplace</h3>
      <div class="fb-photos-row">${fbPhotos}</div>
      <div class="fb-field">
        <span class="fb-label">Título:</span>
        <span class="fb-value" id="fb-title-val">${esc(p.fb_title)}</span>
        <button class="fb-copy-sm" onclick="copyField('fb-title-val')">📋</button>
      </div>
      ${p.price ? `<div class="fb-field">
        <span class="fb-label">Precio:</span>
        <span class="fb-value" id="fb-price-val">$${formatPrice(p.price)}</span>
        <button class="fb-copy-sm" onclick="copyField('fb-price-val')">📋</button>
      </div>` : ''}
      <div class="fb-field">
        <span class="fb-label">Descripción:</span>
        <span class="fb-value" id="fb-desc-val">${esc(p.fb_description || '')}</span>
        <button class="fb-copy-sm" onclick="copyField('fb-desc-val')">📋</button>
      </div>
      <button class="btn btn-outline copy-btn" onclick="copyFbPost()">📋 Copiar todo FB</button>
    </div>` : '';

  // Shipping info
  const shipInfo = p.ship_weight_lbs ? `
    <div class="field-group">
      <label class="field-label">📦 Para envío (+20%)</label>
      <div class="ship-summary">
        ${p.ship_weight_lbs ? `${p.ship_weight_lbs} lbs` : ''}
        ${p.ship_length_in ? ` · ${p.ship_length_in}×${p.ship_width_in}×${p.ship_height_in}"` : ''}
      </div>
    </div>` : '';

  const partTitle = [p.part_brand, p.part_number].filter(hasValue).join(' ') || 'Sin identificar';
  const partSubtitle = p.part_type_es || p.part_type_en || '';

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-top">
      <button class="back-btn" onclick="goBack()">← Inicio</button>
      <span class="card-badge ${st.badge}">${st.label}</span>
    </div>
    ${partSubtitle ? `<h2 class="detail-title">${esc(partSubtitle)}</h2>` : ''}
    <p class="detail-subtitle">${esc(partTitle)}</p>
    <div class="detail-photos">${photos}</div>

    ${verifyHtml}

    ${prev ? `<button class="link-btn" onclick="savePart('${prev}')">↩ Regresar a "${STATUS_INFO[prev].label}"</button>` : ''}
    ${p.ai_error && status === 'pending' ? `
      <div class="alert alert-error ai-error">
        <strong>⚠️ La IA no pudo identificar esta pieza.</strong>
        <p>${esc(aiErrorText(p.ai_error))}</p>
        <button class="btn btn-primary" id="retry-ai-btn" onclick="retryIdentify()">🔄 Reintentar identificación</button>
        <p class="small">También puedes llenar los datos a mano.</p>
        <details><summary>Detalle técnico</summary><code>${esc(p.ai_error)}</code></details>
      </div>` : ''}
    ${confLow && status === 'pending' && !p.ai_error ? '<div class="alert alert-warn">⚠️ La IA no está segura. Revisa los datos.</div>' : ''}

    <h3 class="section-title">Identificación</h3>
    ${textField('f-part_brand', 'Marca de la pieza', p.part_brand, 'ej. Hepolite, Glacier, Clevite')}
    ${textField('f-part_number', 'Nº de parte', p.part_number, 'ej. B6495LC')}
    ${textField('f-oem_number', 'Nº OEM', p.oem_number, 'ej. C9NN6211C')}
    ${textField('f-handwritten', 'Números a mano', p.handwritten_numbers, 'ej. C9NN6211C-D')}
    ${textField('f-part_type_es', 'Tipo de pieza (español)', p.part_type_es, 'ej. Metal de biela')}
    ${textField('f-part_type_en', 'Tipo de pieza (inglés)', p.part_type_en, 'ej. Rod bearing')}
    ${textField('f-tractor_brand', 'Para marca de tractor', p.tractor_brand, 'ej. Ford')}
    ${textField('f-tractor_model', 'Modelo / motor', p.tractor_model, 'ej. 5000, 6600')}
    ${textField('f-measurement', 'Medida', p.measurement, 'ej. STD, .020')}

    <h3 class="section-title">Inventario</h3>
    ${textField('f-quantity', 'Cantidad', p.quantity, 'ej. 4', { type: 'number', inputmode: 'numeric' })}
    <div class="field-group">
      <label class="field-label" for="f-condition">Condición</label>
      ${selectField('f-condition', p.condition, COND_OPTS)}
    </div>
    ${textField('f-location', 'Ubicación (estante/caja)', p.location, 'ej. Estante 3, Caja A')}
    ${textField('f-price', 'Precio ($)', p.price, 'ej. 25', { type: 'number', inputmode: 'decimal', step: 'any' })}

    <h3 class="section-title">Peso y medidas de caja</h3>
    <p class="hint" style="margin-bottom:8px">Peso con báscula, medidas en pulgadas. El envío se calcula +20% automático.</p>
    <button class="btn btn-outline btn-sm" onclick="copyDimensionsFrom()" style="margin-bottom:12px">📋 Copiar peso y medidas de otra igual</button>
    ${textField('f-weight', 'Peso (lbs)', p.weight_lbs, 'ej. 2.5', { type: 'number', inputmode: 'decimal', step: 'any' })}
    <div class="dims-row">
      ${textField('f-box_l', 'Largo"', p.box_length_in, 'L', { type: 'number', inputmode: 'decimal', step: 'any' })}
      ${textField('f-box_w', 'Ancho"', p.box_width_in, 'W', { type: 'number', inputmode: 'decimal', step: 'any' })}
      ${textField('f-box_h', 'Alto"', p.box_height_in, 'H', { type: 'number', inputmode: 'decimal', step: 'any' })}
    </div>
    ${shipInfo}

    <h3 class="section-title">Notas</h3>
    <div class="field-group">
      <label class="field-label" for="f-notes">Notas</label>
      <textarea class="field-input" id="f-notes" rows="3">${esc(p.notes || '')}</textarea>
    </div>
    ${p.all_visible_text ? `
    <div class="field-group">
      <label class="field-label">Todo el texto visible (IA)</label>
      <div class="ai-text">${esc(p.all_visible_text)}</div>
    </div>` : ''}
    ${p.vision_refs ? `
    <div class="field-group">
      <label class="field-label">Google Vision</label>
      <div class="ai-text">${esc(p.vision_refs)}</div>
    </div>` : ''}
    <button class="btn btn-outline btn-sm" onclick="runVisionLookup()">🔎 Buscar más detalles (Google Vision)</button>

    ${ebayPreview}
    ${fbPreview}

    <div class="detail-actions">
      ${next ? `<button class="btn ${next.cls}" onclick="savePart('${next.status}')">${next.label}</button>` : ''}
      <button class="btn btn-outline" onclick="savePart()">💾 Guardar</button>
      <button class="btn btn-danger btn-square" onclick="deletePart()" aria-label="Borrar pieza">🗑</button>
    </div>
  `;
}

function aiErrorText(msg = '') {
  if (/OPENROUTER_API_KEY/.test(msg)) return 'Falta configurar la llave de la IA en el servidor.';
  if (/ 402/.test(msg)) return 'Se acabó el saldo de la IA (OpenRouter).';
  if (/ 401| 403/.test(msg)) return 'La llave de la IA no es válida.';
  if (/ 429/.test(msg)) return 'La IA está saturada. Espera un minuto y vuelve a intentar.';
  if (/timeout|tard/i.test(msg)) return 'La IA tardó demasiado en responder. Vuelve a intentar.';
  if (/conexi|fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(msg)) return 'El servidor no pudo conectarse con la IA. Vuelve a intentar en un momento.';
  return 'Hubo un error con la IA. Vuelve a intentar.';
}

window.retryIdentify = async function() {
  if (detailDirty && !confirm('La IA va a reemplazar lo que escribiste. ¿Continuar?')) return;
  const btn = document.getElementById('retry-ai-btn');
  btn.disabled = true;
  let secs = 0;
  btn.textContent = '🤖 Identificando… 0 s';
  const timer = setInterval(() => { btn.textContent = `🤖 Identificando… ${++secs} s`; }, 1000);
  try {
    const res = await api(`/api/parts/${currentPart.id}/identify`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const part = data.part || (res.ok ? data : null);
    if (part) {
      currentPart = part;
      renderDetail(part);
      detailDirty = false;
    }
    if (res.ok) toast('Pieza identificada ✓ Revisa los datos');
    else toast(part ? 'La IA volvió a fallar' : (data.error || `Error ${res.status}`), 'error');
    if (!part) { btn.disabled = false; btn.textContent = '🔄 Reintentar identificación'; }
  } catch (err) {
    if (err.message === 'Sesión vencida') return;
    toast(err.message === 'Failed to fetch' ? 'Sin conexión. Intenta de nuevo.' : err.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔄 Reintentar identificación';
  } finally {
    clearInterval(timer);
  }
};

window.runVisionLookup = async function() {
  const btn = document.querySelector('[onclick="runVisionLookup()"]');
  btn.disabled = true;
  btn.textContent = '🔎 Buscando…';
  try {
    const res = await api(`/api/parts/${currentPart.id}/vision`, { method: 'POST' });
    const data = await res.json();
    if (data.part) {
      currentPart = data.part;
      renderDetail(data.part);
    }
    if (data.vision) toast(`Google Vision: ${data.vision.bestGuess || 'sin resultados'}`);
    else toast(data.message || 'Sin resultados', 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.copyDimensionsFrom = async function() {
  const fromId = prompt('Nº de pieza de donde copiar (ej. 1, 2, 3):');
  if (!fromId) return;
  try {
    const res = await api(`/api/parts/${currentPart.id}/copy-dimensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id: parseInt(fromId, 10) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    currentPart = data;
    renderDetail(data);
    toast('Peso y medidas copiados ✓');
  } catch (err) {
    toast(err.message, 'error');
  }
};

document.getElementById('detail-content').addEventListener('input', () => { detailDirty = true; });

window.goBack = function() {
  if (detailDirty && !confirm('Tienes cambios sin guardar. ¿Salir sin guardar?')) return;
  detailDirty = false;
  switchView('list');
};

function readForm() {
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    part_brand: val('f-part_brand'),
    part_number: val('f-part_number'),
    oem_number: val('f-oem_number'),
    handwritten_numbers: val('f-handwritten'),
    part_type_es: val('f-part_type_es'),
    part_type_en: val('f-part_type_en'),
    tractor_brand: val('f-tractor_brand'),
    tractor_model: val('f-tractor_model'),
    measurement: val('f-measurement'),
    quantity: parseInt(val('f-quantity'), 10) || null,
    condition: val('f-condition'),
    location: val('f-location'),
    price: parseFloat(val('f-price')) || null,
    weight_lbs: parseFloat(val('f-weight')) || null,
    box_length_in: parseFloat(val('f-box_l')) || null,
    box_width_in: parseFloat(val('f-box_w')) || null,
    box_height_in: parseFloat(val('f-box_h')) || null,
    notes: val('f-notes'),
  };
}

window.savePart = async function(nextStatus) {
  const buttons = document.querySelectorAll('.detail-actions .btn, .link-btn');
  buttons.forEach(b => { b.disabled = true; });
  try {
    let res = await api(`/api/parts/${currentPart.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...readForm(), _expected_updated_at: currentPart.updated_at }),
    });
    if (res.ok && nextStatus) {
      res = await api(`/api/parts/${currentPart.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.part) {
      currentPart = data.part;
      renderDetail(data.part);
      toast(data.error || 'Alguien más editó esta pieza. Datos recargados.', 'error');
      buttons.forEach(b => { b.disabled = false; });
      return;
    }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    let msg = 'Guardado ✓';
    if (nextStatus) {
      msg = PREV_STATUS[currentPart.status] === nextStatus
        ? `Regresada a "${STATUS_INFO[nextStatus].label}"`
        : (NEXT_STEP[currentPart.status]?.done || `Estado: ${STATUS_INFO[nextStatus].label}`);
    }
    toast(msg);
    currentPart = data;
    renderDetail(data);
    detailDirty = false;
  } catch (err) {
    if (err.message === 'Sesión vencida') return;
    toast(err.message === 'Failed to fetch' ? 'Sin conexión: no se guardó. Intenta de nuevo.' : err.message, 'error');
    buttons.forEach(b => { b.disabled = false; });
  }
};

window.deletePart = async function() {
  if (!confirm('¿Eliminar esta pieza y sus fotos? No se puede deshacer.')) return;
  try {
    const res = await api(`/api/parts/${currentPart.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    toast('Pieza eliminada');
    detailDirty = false;
    switchView('list');
  } catch (err) {
    if (err.message !== 'Sesión vencida') toast('No se pudo eliminar: ' + err.message, 'error');
  }
};

async function clipCopy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

window.copyField = async function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  await clipCopy(el.textContent.trim());
  const btn = el.nextElementSibling;
  if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '📋'; }, 1500); }
  toast('Copiado');
};

window.copyImage = async function(src, btn) {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    const pngBlob = await createPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    btn.textContent = '✓ Copiada';
    toast('Foto copiada');
    setTimeout(() => { btn.textContent = '📋 Copiar foto'; }, 2000);
  } catch {
    toast('No se pudo copiar la foto. Descárgala y súbela manualmente.', 'error');
  }
};

function createPngBlob(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(b => resolve(b), 'image/png');
    };
    img.src = URL.createObjectURL(blob);
  });
}

window.copyEbayPost = async function() {
  const lines = [currentPart.ebay_title, '', currentPart.ebay_description];
  await clipCopy(lines.join('\n'));
  toast('Post de eBay copiado ✓');
};

window.copyFbPost = async function() {
  const lines = [currentPart.fb_title];
  if (currentPart.price) lines.push(`$${formatPrice(currentPart.price)}`);
  lines.push('', currentPart.fb_description);
  await clipCopy(lines.join('\n'));
  toast('Post de FB copiado ✓');
};

// Toast
let toastTimer;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, type === 'error' ? 4500 : 2500);
}

// ---------- Photo file names ----------
function slugPart(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―−\/\\|,;]+/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/_+/g, '_').replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');
}

function photoBaseName(p) {
  const pieces = [p.part_brand, p.part_number, p.part_type_en].filter(hasValue).map(slugPart).filter(Boolean);
  return pieces.join('_') || `Part_${p.id}`;
}

function photoFileNames(p) {
  const base = photoBaseName(p);
  return (p.photos || []).map((ph, i) => `${base}_${i + 1}.jpg`);
}

async function fetchPhotoBlob(ph) {
  const res = await api(`/uploads/${encodeURIComponent(ph.filename)}`);
  if (!res.ok) throw new Error(`No se pudo bajar la foto (${res.status})`);
  return res.blob();
}

const canShareFiles = (() => {
  try {
    return Boolean(navigator.canShare &&
      navigator.canShare({ files: [new File(['x'], 'x.jpg', { type: 'image/jpeg' })] }));
  } catch { return false; }
})();

window.downloadPhotos = async function() {
  const p = { ...currentPart, ...readForm() };
  const names = photoFileNames(p);
  const btn = document.getElementById('download-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⬇️ Descargando…'; }
  try {
    for (let i = 0; i < p.photos.length; i++) {
      const url = URL.createObjectURL(await fetchPhotoBlob(p.photos[i]));
      const a = document.createElement('a');
      a.href = url;
      a.download = names[i];
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (i < p.photos.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    toast(names.length === 1 ? `Descargada: ${names[0]}` : `${names.length} fotos descargadas ✓`);
  } catch (err) {
    if (err.message !== 'Sesión vencida') toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇️ Fotos'; }
  }
};

// Init
const startView = new URLSearchParams(location.search).get('view') === 'camera' ? 'camera' : 'list';
if (location.search) history.replaceState(null, '', '/');
switchView(startView);
restorePendingPhotos();

// --- Lightbox ---
let lbPhotos = [];
let lbIndex = 0;

function openLightbox(index) {
  const part = currentPart;
  if (!part?.photos?.length) return;
  lbPhotos = part.photos.map(ph => `/uploads/${ph.filename}`);
  lbIndex = index;
  renderLightbox();
}

function renderLightbox() {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.innerHTML = `
      <div class="lb-overlay" onclick="closeLightbox()"></div>
      <button class="lb-arrow lb-prev" onclick="lbNav(-1)">‹</button>
      <img class="lb-img" onclick="event.stopPropagation()">
      <button class="lb-arrow lb-next" onclick="lbNav(1)">›</button>
      <button class="lb-close" onclick="closeLightbox()">✕</button>
      <span class="lb-counter"></span>
    `;
    document.body.appendChild(lb);
  }
  lb.querySelector('.lb-img').src = lbPhotos[lbIndex];
  lb.querySelector('.lb-counter').textContent = `${lbIndex + 1} / ${lbPhotos.length}`;
  lb.querySelector('.lb-prev').style.display = lbPhotos.length > 1 ? '' : 'none';
  lb.querySelector('.lb-next').style.display = lbPhotos.length > 1 ? '' : 'none';
  lb.classList.add('lb-open');
}

function lbNav(dir) {
  lbIndex = (lbIndex + dir + lbPhotos.length) % lbPhotos.length;
  const img = document.querySelector('#lightbox .lb-img');
  img.src = lbPhotos[lbIndex];
  document.querySelector('#lightbox .lb-counter').textContent = `${lbIndex + 1} / ${lbPhotos.length}`;
}

function closeLightbox() {
  document.getElementById('lightbox')?.classList.remove('lb-open');
}

document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox')?.classList.contains('lb-open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lbNav(-1);
  if (e.key === 'ArrowRight') lbNav(1);
});
