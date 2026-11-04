// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

async function api(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Session expired');
  }
  return res;
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (!confirm('Log out?')) return;
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
  pending:  { label: 'Pending',  badge: 'badge-pending' },
  approved: { label: 'Approved', badge: 'badge-approved' },
  posted:   { label: 'Posted',   badge: 'badge-posted' },
  sold:     { label: 'Sold',     badge: 'badge-sold' },
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
  'sleeve': 'cylinder sleeve', 'liner': 'cylinder sleeve',
  'rod bearing': 'rod bearing', 'main bearing': 'main bearing',
  'ring': 'piston ring', 'rings': 'piston ring',
  'bushing': 'bushing', 'valve': 'valve',
  'guide': 'guide', 'seal': 'seal', 'gasket': 'gasket',
};

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matchesSearch(p, tokens) {
  if (!tokens.length) return true;
  // Search across all relevant fields, including part_number without dashes/spaces
  const numFields = [p.part_number, p.oem_number, p.clevite_old, p.clevite_new, p.sealed_power, p.trw, p.zollner];
  const numsCleaned = numFields.map(v => String(v || '').replace(/[-\s]/g, '').toLowerCase());
  const hay = norm([
    p.part_brand, p.tractor_brand, p.tractor_model,
    p.part_type_es, p.part_type_en, p.part_number, p.oem_number,
    p.measurement, p.location, `#${p.id}`,
    p.clevite_old, p.clevite_new, p.sealed_power, p.trw, p.zollner,
    p.oe_brand, p.application, p.custom_title, p.sku
  ].join(' '));
  return tokens.every(t => {
    if (hay.includes(t)) return true;
    const tClean = t.replace(/[-\s]/g, '');
    if (tClean.length >= 3 && numsCleaned.some(n => n.includes(tClean))) return true;
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
    if (err.message === 'Session expired') return;
    list.innerHTML = `
      <div class="alert alert-error">
        Could not load inventory. ${navigator.onLine ? '' : 'No internet connection.'}
      </div>
      <button class="btn btn-outline" onclick="loadParts()">🔄 Retry</button>`;
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
      ? `<div class="empty"><p>Nothing found for "${esc(searchInput.value.trim())}"</p>
           <button class="btn btn-outline" onclick="clearSearch()">✕ Clear search</button></div>`
      : '<div class="empty"><p>No parts in this filter</p></div>';
    return;
  }

  list.innerHTML = shown.map(partCard).join('');
}

function partCard(p) {
  const title = hasValue(p.custom_title) ? p.custom_title : ([p.part_brand, p.part_number].filter(hasValue).join(' ') || 'Unidentified');
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
  if (p.status === 'pending' && p.ai_error) lowConf = '<span class="card-badge badge-low">⚠️ Unidentified</span>';
  else if (p.status === 'pending' && confLow) lowConf = '<span class="card-badge badge-low">⚠️ Review</span>';

  let verifyBadge = '';
  if (p.verification_match === 1) verifyBadge = '<span class="card-badge badge-approved">✅ 2 AI</span>';
  else if (p.verification_match === 0 && !p.ai_error) verifyBadge = '<span class="card-badge badge-low">⚠️ AI differ</span>';

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
  if (files.length > room) toast(`Maximum ${MAX_PHOTOS} photos per part`, 'error');
  for (const file of files.slice(0, room)) {
    try {
      selectedPhotos.push(await compressImage(file));
    } catch {
      toast(`Could not read photo "${file.name}"`, 'error');
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
  count.textContent = n >= MAX_PHOTOS ? `${n} of ${MAX_PHOTOS} photos (max)` : `${n} of ${MAX_PHOTOS} photos`;
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
    uploadUI.title.textContent = `📤 Uploading photos… ${Math.round(pct * 100)}%`;
    uploadUI.progress.hidden = false;
    uploadUI.bar.style.width = `${Math.round(pct * 100)}%`;
    uploadUI.sub.textContent = 'Don\'t close the app.';
  } else if (phase === 'identify' && !uploadTimer) {
    uploadUI.title.textContent = '🤖 Identifying with 2 AI models…';
    uploadUI.progress.hidden = true;
    const started = Date.now();
    const tick = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      uploadUI.sub.textContent = secs < 30
        ? `⏱ ${secs} s — usually takes 10-30 seconds (2 models). Don't close the app.`
        : `⏱ ${secs} s — taking longer than usual, still working…`;
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
    return showUploadError('📶 No internet. Your photos are still here; try again when you have signal.');
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
    if (part.ai_error) toast('Part saved, but AI could not identify it', 'error');
    else toast('Part identified ✓ Review the data');
  } catch (err) {
    if (err.message === 'Session expired') return;
    const msg = {
      NETWORK: '📶 Could not send: connection lost. Your photos are still here; try again.',
      TIMEOUT: '⏱ Server took too long to respond. Try again.',
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
    if (err.message === 'Session expired') return;
    toast(err.message === 'Failed to fetch' ? 'No connection. Try again.' : err.message, 'error');
  }
}

const NEXT_STEP = {
  pending:  { status: 'approved', label: '✓ Approve', cls: 'btn-success', done: 'Approved ✓' },
  approved: { status: 'posted', label: '📢 Mark as Posted', cls: 'btn-posted', done: 'Marked as Posted 📢' },
  posted:   { status: 'sold', label: '💰 Mark as Sold', cls: 'btn-primary', done: 'Marked as Sold 💰' },
};
const PREV_STATUS = { approved: 'pending', posted: 'approved', sold: 'posted' };

const COND_OPTS = ['New Old Stock', 'New', 'Used - Good', 'Used - Fair'];

function selectField(id, value, opts) {
  let v = hasValue(value) ? String(value) : '';
  const list = v && !opts.includes(v) ? [...opts, v] : opts;
  return `<select class="field-input" id="${id}">
    <option value="" ${v ? '' : 'selected'}>— Not set —</option>
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
    `<div class="detail-photo-wrap">
      <img src="/uploads/${esc(ph.filename)}" alt="part photo" onclick="openLightbox(${i})">
      <button class="btn-icon photo-delete-btn" onclick="deletePhoto(${ph.id})" title="Remove photo">✕</button>
    </div>`
  ).join('');

  const photoCount = (p.photos || []).length;
  const canAddPhotos = photoCount < MAX_PHOTOS;
  const addPhotoHtml = canAddPhotos ? `
    <div class="detail-add-photos">
      <label class="btn btn-outline btn-sm">
        📷 Take Photo
        <input type="file" accept="image/*" capture="environment" class="detail-photo-input" hidden>
      </label>
      <label class="btn btn-outline btn-sm">
        🖼 Gallery
        <input type="file" accept="image/*" multiple class="detail-gallery-input" hidden>
      </label>
      <button class="btn btn-outline btn-sm" onclick="window.open('https://lens.google.com','_blank')">🔍 Google Lens</button>
      <span class="photo-count-hint">${photoCount} of ${MAX_PHOTOS} photos</span>
    </div>` : `<p class="photo-count-hint">${photoCount} of ${MAX_PHOTOS} photos (max)</p>`;

  // Verification badge
  let verifyHtml = '';
  if (p.verification_match === 1) {
    verifyHtml = '<div class="alert" style="background:#16a34a22;border-color:#22c55e">✅ Both AI models agree</div>';
  } else if (p.verification_match === 0 && p.verification_diffs) {
    verifyHtml = `<div class="alert alert-warn">⚠️ AI models differ: ${esc(p.verification_diffs)}</div>`;
  }

  // eBay preview
  const ebayPreview = status !== 'pending' && p.ebay_title ? `
    <div class="fb-preview">
      <h3>🏷️ For eBay</h3>
      <div class="fb-field">
        <span class="fb-label">Title (${p.ebay_title.length}/80):</span>
        <span class="fb-value" id="ebay-title-val">${esc(p.ebay_title)}</span>
        <button class="fb-copy-sm" onclick="copyField('ebay-title-val')">📋</button>
      </div>
      <div class="fb-field">
        <span class="fb-label">Description:</span>
        <span class="fb-value" id="ebay-desc-val">${esc(p.ebay_description || '')}</span>
        <button class="fb-copy-sm" onclick="copyField('ebay-desc-val')">📋</button>
      </div>
      <button class="btn btn-outline copy-btn" onclick="copyEbayPost()">📋 Copy all eBay</button>
    </div>` : '';

  // FB Marketplace preview
  const fbPhotos = (p.photos || []).map((ph, i) =>
    `<div class="fb-photo-wrap">
      <img src="/uploads/${esc(ph.filename)}" alt="photo ${i + 1}">
      <button class="fb-copy-sm fb-copy-img" onclick="copyImage('/uploads/${esc(ph.filename)}', this)">📋 Copy photo</button>
    </div>`
  ).join('');

  const fbPreview = status !== 'pending' && p.fb_title ? `
    <div class="fb-preview">
      <h3>📦 For FB Marketplace</h3>
      <div class="fb-photos-row">${fbPhotos}</div>
      <div class="fb-field">
        <span class="fb-label">Title:</span>
        <span class="fb-value" id="fb-title-val">${esc(p.fb_title)}</span>
        <button class="fb-copy-sm" onclick="copyField('fb-title-val')">📋</button>
      </div>
      ${p.price ? `<div class="fb-field">
        <span class="fb-label">Price:</span>
        <span class="fb-value" id="fb-price-val">$${formatPrice(p.price)}</span>
        <button class="fb-copy-sm" onclick="copyField('fb-price-val')">📋</button>
      </div>` : ''}
      <div class="fb-field">
        <span class="fb-label">Description:</span>
        <span class="fb-value" id="fb-desc-val">${esc(p.fb_description || '')}</span>
        <button class="fb-copy-sm" onclick="copyField('fb-desc-val')">📋</button>
      </div>
      <button class="btn btn-outline copy-btn" onclick="copyFbPost()">📋 Copy all FB</button>
    </div>` : '';

  // Shipping info
  const shipInfo = p.ship_weight_lbs ? `
    <div class="field-group">
      <label class="field-label">📦 For shipping (+20%)</label>
      <div class="ship-summary">
        ${p.ship_weight_lbs ? `${p.ship_weight_lbs} lbs` : ''}
        ${p.ship_length_in ? ` · ${p.ship_length_in}×${p.ship_width_in}×${p.ship_height_in}"` : ''}
      </div>
    </div>` : '';

  const partTitle = hasValue(p.custom_title) ? p.custom_title : ([p.part_brand, p.part_number].filter(hasValue).join(' ') || 'Unidentified');
  const partSubtitle = p.part_type_es || p.part_type_en || '';

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-top">
      <button class="back-btn" onclick="goBack()">← Back</button>
      <span class="card-badge ${st.badge}">${st.label}</span>
    </div>
    ${partSubtitle ? `<h2 class="detail-title">${esc(partSubtitle)}</h2>` : ''}
    <p class="detail-subtitle">${esc(partTitle)}</p>
    <div class="detail-photos">${photos}</div>
    ${addPhotoHtml}

    ${verifyHtml}

    ${prev ? `<button class="link-btn" onclick="savePart('${prev}')">↩ Back to "${STATUS_INFO[prev].label}"</button>` : ''}
    ${p.ai_error && status === 'pending' ? `
      <div class="alert alert-error ai-error">
        <strong>⚠️ AI could not identify this part.</strong>
        <p>${esc(aiErrorText(p.ai_error))}</p>
        <button class="btn btn-primary" id="retry-ai-btn" onclick="retryIdentify()">🔄 Retry identification</button>
        <p class="small">You can also fill in the data manually.</p>
        <details><summary>Technical detail</summary><code>${esc(p.ai_error)}</code></details>
      </div>` : ''}
    ${confLow && status === 'pending' && !p.ai_error ? '<div class="alert alert-warn">⚠️ AI is not confident. Review the data.</div>' : ''}

    <h3 class="section-title">Product</h3>
    ${textField('f-custom_title', 'Main Title', p.custom_title, 'e.g. G479 G-479 CLEVITE Sleeve Assembly')}
    ${textField('f-sku', 'SKU / Code', p.sku, 'e.g. 1234')}

    <h3 class="section-title">Identification</h3>
    ${textField('f-part_brand', 'Part Brand', p.part_brand, 'e.g. Hepolite, Glacier, Clevite')}
    ${textField('f-part_number', 'Part Number', p.part_number, 'e.g. B6495LC')}
    ${textField('f-oem_number', 'OEM Number', p.oem_number, 'e.g. C9NN6211C')}
    ${textField('f-handwritten', 'Handwritten Numbers', p.handwritten_numbers, 'e.g. C9NN6211C-D')}
    ${textField('f-part_type_es', 'Part Type (Spanish)', p.part_type_es, 'e.g. Metal de biela')}
    ${textField('f-part_type_en', 'Part Type (English)', p.part_type_en, 'e.g. Rod bearing')}
    ${textField('f-tractor_brand', 'Tractor Brand', p.tractor_brand, 'e.g. Ford')}
    ${textField('f-tractor_model', 'Model / Engine', p.tractor_model, 'e.g. 5000, 6600')}
    ${textField('f-measurement', 'Measurement', p.measurement, 'e.g. STD, .020')}

    <h3 class="section-title">Cross-reference</h3>
    ${textField('f-clevite_old', 'Clevite Old', p.clevite_old, 'e.g. G-479')}
    ${textField('f-clevite_new', 'Clevite New', p.clevite_new, 'e.g. 226-1361')}
    ${textField('f-sealed_power', 'Sealed Power', p.sealed_power, 'e.g. SL-2274')}
    ${textField('f-trw', 'TRW', p.trw, 'e.g. SA-296')}
    ${textField('f-zollner', 'Zollner', p.zollner, 'e.g. 19019B')}
    ${textField('f-oe_brand', 'OE Brand', p.oe_brand, 'e.g. Allis-Chalmers')}
    ${textField('f-application', 'Application', p.application, 'e.g. 4 Cyl DA175 Diesel')}

    <h3 class="section-title">Inventory</h3>
    ${textField('f-quantity', 'Quantity', p.quantity, 'e.g. 4', { type: 'number', inputmode: 'numeric' })}
    <div class="field-group">
      <label class="field-label" for="f-condition">Condition</label>
      ${selectField('f-condition', p.condition, COND_OPTS)}
    </div>
    ${textField('f-location', 'Location (shelf/box)', p.location, 'e.g. Shelf 3, Box A')}
    ${textField('f-price', 'Price ($)', p.price, 'e.g. 25', { type: 'number', inputmode: 'decimal', step: 'any' })}

    <h3 class="section-title">Weight & Box Dimensions</h3>
    <p class="hint" style="margin-bottom:8px">Weigh on scale, dimensions in inches. Shipping is auto-calculated +20%.</p>
    <button class="btn btn-outline btn-sm" onclick="copyDimensionsFrom()" style="margin-bottom:12px">📋 Copy weight & dimensions from another part</button>
    ${textField('f-weight', 'Weight (lbs)', p.weight_lbs, 'e.g. 2.5', { type: 'number', inputmode: 'decimal', step: 'any' })}
    <div class="dims-row">
      ${textField('f-box_l', 'Length"', p.box_length_in, 'L', { type: 'number', inputmode: 'decimal', step: 'any' })}
      ${textField('f-box_w', 'Width"', p.box_width_in, 'W', { type: 'number', inputmode: 'decimal', step: 'any' })}
      ${textField('f-box_h', 'Height"', p.box_height_in, 'H', { type: 'number', inputmode: 'decimal', step: 'any' })}
    </div>
    ${shipInfo}

    <h3 class="section-title">Notes</h3>
    <div class="field-group">
      <label class="field-label" for="f-notes">Notes</label>
      <textarea class="field-input" id="f-notes" rows="3">${esc(p.notes || '')}</textarea>
    </div>
    ${p.all_visible_text ? `
    <div class="field-group">
      <label class="field-label">All visible text (AI)</label>
      <div class="ai-text">${esc(p.all_visible_text)}</div>
    </div>` : ''}
    ${p.vision_refs ? `
    <div class="field-group">
      <label class="field-label">Google Vision</label>
      <div class="ai-text">${esc(p.vision_refs)}</div>
    </div>` : ''}
    <button class="btn btn-outline btn-sm" onclick="runVisionLookup()">🔎 Look up details (Google Vision)</button>

    ${ebayPreview}
    ${fbPreview}

    <div class="detail-actions">
      ${next ? `<button class="btn ${next.cls}" onclick="savePart('${next.status}')">${next.label}</button>` : ''}
      <button class="btn btn-outline" onclick="savePart()">💾 Save</button>
      <button class="btn btn-danger btn-square" onclick="deletePart()" aria-label="Delete part">🗑</button>
    </div>
  `;
}

function aiErrorText(msg = '') {
  if (/OPENROUTER_API_KEY/.test(msg)) return 'AI key not configured on the server.';
  if (/ 402/.test(msg)) return 'AI credit ran out (OpenRouter).';
  if (/ 401| 403/.test(msg)) return 'AI key is invalid.';
  if (/ 429/.test(msg)) return 'AI is overloaded. Wait a minute and try again.';
  if (/timeout|tard/i.test(msg)) return 'AI took too long to respond. Try again.';
  if (/conexi|fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(msg)) return 'Server could not connect to AI. Try again in a moment.';
  return 'AI error. Try again.';
}

window.retryIdentify = async function() {
  if (detailDirty && !confirm('AI will replace your edits. Continue?')) return;
  const btn = document.getElementById('retry-ai-btn');
  btn.disabled = true;
  let secs = 0;
  btn.textContent = '🤖 Identifying… 0 s';
  const timer = setInterval(() => { btn.textContent = `🤖 Identifying… ${++secs} s`; }, 1000);
  try {
    const res = await api(`/api/parts/${currentPart.id}/identify`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const part = data.part || (res.ok ? data : null);
    if (part) {
      currentPart = part;
      renderDetail(part);
      detailDirty = false;
    }
    if (res.ok) toast('Part identified ✓ Review the data');
    else toast(part ? 'AI failed again' : (data.error || `Error ${res.status}`), 'error');
    if (!part) { btn.disabled = false; btn.textContent = '🔄 Retry identification'; }
  } catch (err) {
    if (err.message === 'Session expired') return;
    toast(err.message === 'Failed to fetch' ? 'No connection. Try again.' : err.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔄 Retry identification';
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
    if (data.vision) toast(`Google Vision: ${data.vision.bestGuess || 'no results'}`);
    else toast(data.message || 'No results', 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.copyDimensionsFrom = async function() {
  const fromId = prompt('Part # to copy from (e.g. 1, 2, 3):');
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
    toast('Weight & dimensions copied ✓');
  } catch (err) {
    toast(err.message, 'error');
  }
};

document.getElementById('detail-content').addEventListener('input', () => { detailDirty = true; });

window.goBack = function() {
  if (detailDirty && !confirm('You have unsaved changes. Leave without saving?')) return;
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
    clevite_old: val('f-clevite_old'),
    clevite_new: val('f-clevite_new'),
    sealed_power: val('f-sealed_power'),
    trw: val('f-trw'),
    zollner: val('f-zollner'),
    oe_brand: val('f-oe_brand'),
    application: val('f-application'),
    custom_title: val('f-custom_title'),
    sku: val('f-sku'),
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

    let msg = 'Saved ✓';
    if (nextStatus) {
      msg = PREV_STATUS[currentPart.status] === nextStatus
        ? `Moved back to "${STATUS_INFO[nextStatus].label}"`
        : (NEXT_STEP[currentPart.status]?.done || `Status: ${STATUS_INFO[nextStatus].label}`);
    }
    toast(msg);
    currentPart = data;
    renderDetail(data);
    detailDirty = false;
  } catch (err) {
    if (err.message === 'Session expired') return;
    toast(err.message === 'Failed to fetch' ? 'No connection: not saved. Try again.' : err.message, 'error');
    buttons.forEach(b => { b.disabled = false; });
  }
};

window.deletePart = async function() {
  if (!confirm('Delete this part and its photos? This cannot be undone.')) return;
  try {
    const res = await api(`/api/parts/${currentPart.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    toast('Part deleted');
    detailDirty = false;
    switchView('list');
  } catch (err) {
    if (err.message !== 'Session expired') toast('Could not delete: ' + err.message, 'error');
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
  toast('Copied');
};

window.copyImage = async function(src, btn) {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    const pngBlob = await createPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    btn.textContent = '✓ Copied';
    toast('Photo copied');
    setTimeout(() => { btn.textContent = '📋 Copy photo'; }, 2000);
  } catch {
    toast('Could not copy photo. Download and upload manually.', 'error');
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

// ---------- Add photos to existing part ----------
document.getElementById('detail-content').addEventListener('change', async (e) => {
  const isPhoto = e.target.classList.contains('detail-photo-input') || e.target.classList.contains('detail-gallery-input');
  if (!isPhoto || !currentPart) return;
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;

  const currentCount = (currentPart.photos || []).length;
  const room = MAX_PHOTOS - currentCount;
  if (room <= 0) { toast(`Maximum ${MAX_PHOTOS} photos per part`, 'error'); return; }
  if (files.length > room) toast(`Only adding ${room} photo(s) — max ${MAX_PHOTOS}`, 'error');

  const toUpload = files.slice(0, room);
  const formData = new FormData();
  for (const file of toUpload) {
    try { formData.append('photos', await compressImage(file)); }
    catch { toast(`Could not read "${file.name}"`, 'error'); }
  }
  if (!formData.has('photos')) return;

  toast('Uploading…');
  try {
    const res = await api(`/api/parts/${currentPart.id}/photos`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    currentPart = data;
    renderDetail(data);
    detailDirty = false;
    toast('Photo(s) added ✓');
  } catch (err) {
    if (err.message !== 'Session expired') toast(err.message, 'error');
  }
});

window.deletePhoto = async function(photoId) {
  if (!confirm('Remove this photo?')) return;
  try {
    const res = await api(`/api/parts/${currentPart.id}/photos/${photoId}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Error ${res.status}`); }
    const data = await res.json();
    currentPart = data;
    renderDetail(data);
    toast('Photo removed');
  } catch (err) {
    if (err.message !== 'Session expired') toast(err.message, 'error');
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
