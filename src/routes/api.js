import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { unlinkSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { identifyPart, googleVisionLookup } from '../vision.js';
import { config } from '../config.js';

const { UPLOADS_DIR } = config;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imágenes'));
  },
});

const STATUSES = ['pending', 'approved', 'posted', 'sold'];

const isSet = v => v != null && !['', 'unknown', 'n/a', 'na', 'none', 'desconocido'].includes(String(v).trim().toLowerCase());

function generateEbayPost(part) {
  const pieces = [
    part.part_brand,
    part.part_number,
    part.part_type_en,
    part.tractor_brand,
    part.measurement,
  ].filter(isSet);
  const title = pieces.join(' ').slice(0, 80);

  const lines = [];
  if (isSet(part.part_type_en)) lines.push(part.part_type_en);
  if (isSet(part.part_brand)) lines.push(`Brand: ${part.part_brand}`);
  if (isSet(part.part_number)) lines.push(`Part Number: ${part.part_number}`);
  if (isSet(part.oem_number)) lines.push(`OEM Number: ${part.oem_number}`);
  const xrefs = [
    ['Clevite', part.clevite_old || part.clevite_new],
    ['Sealed Power', part.sealed_power],
    ['TRW', part.trw],
  ].filter(([, v]) => isSet(v));
  if (xrefs.length) lines.push(`Cross-ref: ${xrefs.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (isSet(part.tractor_brand)) {
    const vehicle = [part.tractor_brand, part.tractor_model].filter(isSet).join(' ');
    lines.push(`For: ${vehicle}`);
  }
  if (isSet(part.application)) lines.push(`Application: ${part.application}`);
  if (isSet(part.measurement)) lines.push(`Size: ${part.measurement}`);
  if (isSet(part.quantity)) lines.push(`Quantity: ${part.quantity}`);
  const isNos = String(part.condition || '').toLowerCase().includes('new');
  lines.push(`Condition: ${isNos ? 'New Old Stock (NOS) — new part in original box' : (part.condition || 'See photos')}`);
  if (isSet(part.weight_lbs)) lines.push(`Weight: ${part.weight_lbs} lbs`);
  if (isSet(part.notes)) lines.push(`\nNotes: ${part.notes}`);

  return { title, description: lines.join('\n') };
}

function generateFbPost(part) {
  const titleParts = [
    part.part_brand,
    part.part_number,
    part.part_type_es || part.part_type_en,
    part.tractor_brand,
  ].filter(isSet);
  const title = titleParts.join(' ');

  const lines = [];
  if (isSet(part.part_type_es)) lines.push(part.part_type_es);
  if (isSet(part.part_brand)) lines.push(`Marca: ${part.part_brand}`);
  if (isSet(part.part_number)) lines.push(`Nº parte: ${part.part_number}`);
  if (isSet(part.oem_number)) lines.push(`OEM: ${part.oem_number}`);
  if (isSet(part.tractor_brand)) {
    const vehicle = [part.tractor_brand, part.tractor_model].filter(isSet).join(' ');
    lines.push(`Para: ${vehicle}`);
  }
  if (isSet(part.measurement)) lines.push(`Medida: ${part.measurement}`);
  if (isSet(part.quantity)) lines.push(`Cantidad: ${part.quantity}`);
  if (isSet(part.condition)) lines.push(`Condición: ${part.condition}`);
  if (isSet(part.notes)) lines.push(`\nNotas: ${part.notes}`);
  lines.push('\nManda mensaje para precio y detalles.');

  return { title, description: lines.join('\n') };
}

const SHIP_FACTOR = 1.20;

function calcShipping(val) {
  return val != null && val > 0 ? Math.round(val * SHIP_FACTOR * 100) / 100 : null;
}

export function apiRouter(db) {
  const router = Router();

  const getPart = (id) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
    if (part) {
      part.photos = db.prepare('SELECT * FROM photos WHERE part_id = ? ORDER BY sort_order').all(part.id);
      for (const ph of part.photos) {
        ph.thumbnail = `thumb_${ph.filename}`;
      }
    }
    return part;
  };

  const runIdentify = async (partId, paths) => {
    try {
      const r = await identifyPart(paths);
      db.prepare(`
        UPDATE parts SET
          part_brand = ?, tractor_brand = ?, tractor_model = ?,
          part_type_es = ?, part_type_en = ?, part_number = ?,
          oem_number = ?, handwritten_numbers = ?, measurement = ?,
          quantity = ?, condition = ?, confidence = ?,
          all_visible_text = ?, notes = ?,
          verification_match = ?, verification_diffs = ?, vision_refs = ?,
          ai_error = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        r.part_brand ?? null, r.tractor_brand ?? null, r.tractor_model ?? null,
        r.part_type_es ?? null, r.part_type_en ?? null, r.part_number ?? null,
        r.oem_number ?? null, r.handwritten_numbers ?? null, r.measurement ?? null,
        r.quantity ? parseInt(r.quantity, 10) || null : null,
        r.condition ?? null, r.confidence ?? null,
        r.all_visible_text ?? null, r.notes ?? null,
        r.verification_match ? 1 : 0,
        r.verification_diffs?.length ? r.verification_diffs.join(' | ') : null,
        r.vision_refs ?? null,
        partId
      );
      return null;
    } catch (aiErr) {
      console.error(`IA falló para pieza ${partId}:`, aiErr.message);
      db.prepare("UPDATE parts SET ai_error = ?, updated_at = datetime('now') WHERE id = ?")
        .run(aiErr.message, partId);
      return aiErr.message;
    }
  };

  const setStatus = (part, status) => {
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const vals = [status];
    if (status !== 'pending') {
      const fb = generateFbPost(part);
      const eb = generateEbayPost(part);
      sets.push('fb_title = ?', 'fb_description = ?', 'ebay_title = ?', 'ebay_description = ?');
      vals.push(fb.title, fb.description, eb.title, eb.description);
    }
    if (status === 'posted' && !part.posted_at) sets.push("posted_at = datetime('now')");
    if (status === 'pending' || status === 'approved') sets.push('posted_at = NULL');
    sets.push(status === 'sold' ? (part.status === 'sold' ? 'sold_at = sold_at' : "sold_at = datetime('now')") : 'sold_at = NULL');

    // Al vender, restar 1 de la cantidad
    if (status === 'sold' && part.status !== 'sold' && part.quantity > 1) {
      sets.push('quantity = ?');
      vals.push(part.quantity - 1);
    }

    vals.push(part.id);
    db.prepare(`UPDATE parts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  };

  router.get('/config', (req, res) => {
    res.json({
      whatsappCountryCode: String(process.env.WHATSAPP_COUNTRY_CODE || '1').replace(/\D/g, '') || '1',
    });
  });

  router.get('/parts', (req, res) => {
    const statuses = String(req.query.status || '').split(',').map(x => x.trim()).filter(Boolean);
    let parts;
    if (statuses.length) {
      const marks = statuses.map(() => '?').join(',');
      parts = db.prepare(`SELECT * FROM parts WHERE status IN (${marks}) ORDER BY created_at DESC, id DESC`).all(...statuses);
    } else {
      parts = db.prepare('SELECT * FROM parts ORDER BY created_at DESC, id DESC').all();
    }
    const byPart = new Map();
    for (const ph of db.prepare('SELECT * FROM photos ORDER BY part_id, sort_order').all()) {
      if (!byPart.has(ph.part_id)) byPart.set(ph.part_id, []);
      byPart.get(ph.part_id).push(ph);
    }
    for (const p of parts) p.photos = byPart.get(p.id) || [];
    res.json(parts);
  });

  router.get('/parts/:id', (req, res) => {
    const part = getPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });
    res.json(part);
  });

  router.post('/parts', upload.array('photos', 4), async (req, res) => {
    try {
      if (!req.files?.length) return res.status(400).json({ error: 'Sube al menos 1 foto' });

      const images = [];
      for (const file of req.files) {
        try {
          images.push(await sharp(file.buffer)
            .rotate()
            .resize(1200, null, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer());
        } catch {
          return res.status(400).json({ error: `No se pudo leer la foto "${file.originalname}". Intenta con otra.` });
        }
      }

      const { lastInsertRowid: partId } = db.prepare('INSERT INTO parts DEFAULT VALUES').run();
      const photoInsert = db.prepare(
        'INSERT INTO photos (part_id, filename, original_name, sort_order) VALUES (?, ?, ?, ?)'
      );
      const savedPaths = [];
      for (let i = 0; i < images.length; i++) {
        const ts = Date.now();
        const filename = `${partId}_${i}_${ts}.jpg`;
        const thumbName = `thumb_${partId}_${i}_${ts}.jpg`;
        const filepath = join(UPLOADS_DIR, filename);
        writeFileSync(filepath, images[i]);
        const thumbBuf = await sharp(images[i])
          .resize(400, null, { withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
        writeFileSync(join(UPLOADS_DIR, thumbName), thumbBuf);
        photoInsert.run(partId, filename, req.files[i].originalname, i);
        savedPaths.push(filepath);
      }

      await runIdentify(partId, savedPaths);

      res.status(201).json(getPart(partId));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/parts/:id', (req, res) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });

    if (req.body._expected_updated_at && part.updated_at !== req.body._expected_updated_at) {
      const fresh = getPart(req.params.id);
      return res.status(409).json({
        error: 'Alguien más editó esta pieza. Se recargaron los datos actuales.',
        part: fresh,
      });
    }

    if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `Estado inválido: ${req.body.status}` });
    }

    const fields = [
      'part_brand', 'tractor_brand', 'tractor_model',
      'part_type_es', 'part_type_en', 'part_number',
      'oem_number', 'handwritten_numbers', 'measurement',
      'quantity', 'condition', 'notes', 'price',
      'weight_lbs', 'box_length_in', 'box_width_in', 'box_height_in',
      'location',
      'clevite_old', 'clevite_new', 'sealed_power', 'trw', 'zollner',
      'oe_brand', 'application',
    ];
    const updates = [];
    const values = [];

    for (const f of fields) {
      if (req.body[f] === undefined) continue;
      let v = req.body[f];
      if (['price', 'weight_lbs', 'box_length_in', 'box_width_in', 'box_height_in'].includes(f)) {
        v = v === '' || v === null ? null : Number(v);
        if (v !== null && (!Number.isFinite(v) || v < 0)) {
          return res.status(400).json({ error: `Valor inválido para ${f}` });
        }
      }
      if (f === 'quantity') {
        v = v === '' || v === null ? null : parseInt(v, 10);
        if (v !== null && (!Number.isFinite(v) || v < 0)) {
          return res.status(400).json({ error: 'Cantidad inválida' });
        }
      }
      updates.push(`${f} = ?`);
      values.push(v);
    }

    // Auto-calculate shipping dimensions (+20%)
    const w = req.body.weight_lbs !== undefined ? (Number(req.body.weight_lbs) || null) : part.weight_lbs;
    const bL = req.body.box_length_in !== undefined ? (Number(req.body.box_length_in) || null) : part.box_length_in;
    const bW = req.body.box_width_in !== undefined ? (Number(req.body.box_width_in) || null) : part.box_width_in;
    const bH = req.body.box_height_in !== undefined ? (Number(req.body.box_height_in) || null) : part.box_height_in;
    updates.push('ship_weight_lbs = ?', 'ship_length_in = ?', 'ship_width_in = ?', 'ship_height_in = ?');
    values.push(calcShipping(w), calcShipping(bL), calcShipping(bW), calcShipping(bH));

    // Si se llenó marca/modelo a mano, el aviso de "la IA falló" ya no aplica
    const filled = v => v != null && !['', 'unknown'].includes(String(v).trim().toLowerCase());
    if (filled(req.body.part_brand) || filled(req.body.part_number)) updates.push('ai_error = NULL');

    if (updates.length) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id);
      db.prepare(`UPDATE parts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const fresh = getPart(req.params.id);
    const current = fresh.status || 'pending';
    const status = req.body.status ?? current;
    if (status !== current || status !== 'pending') setStatus(fresh, status);

    res.json(getPart(req.params.id));
  });

  router.post('/parts/:id/status', (req, res) => {
    const part = getPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Estado inválido: ${status}` });
    setStatus(part, status);
    res.json(getPart(part.id));
  });

  router.post('/parts/batch/approve', (req, res) => {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Falta ids' });
    const results = [];
    for (const id of ids) {
      const part = getPart(id);
      if (!part) continue;
      setStatus(part, 'approved');
      results.push(part.id);
    }
    res.json({ approved: results });
  });

  router.post('/parts/:id/approve', (req, res) => {
    const part = getPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });
    setStatus(part, 'approved');
    res.json(getPart(part.id));
  });

  router.post('/parts/:id/identify', async (req, res) => {
    const part = getPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });
    const paths = part.photos.map(ph => join(UPLOADS_DIR, ph.filename)).filter(existsSync);
    if (!paths.length) return res.status(400).json({ error: 'La pieza no tiene fotos' });
    const error = await runIdentify(part.id, paths);
    if (error) return res.status(502).json({ error, part: getPart(part.id) });
    res.json(getPart(part.id));
  });

  // Google Vision lookup — botón manual
  router.post('/parts/:id/vision', async (req, res) => {
    const part = getPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });
    const paths = part.photos.map(ph => join(UPLOADS_DIR, ph.filename)).filter(existsSync);
    if (!paths.length) return res.status(400).json({ error: 'La pieza no tiene fotos' });
    const data = await googleVisionLookup(paths[0]);
    if (!data) return res.status(200).json({ message: 'Google Vision no configurada o sin resultados', part: getPart(part.id) });
    db.prepare("UPDATE parts SET vision_refs = ?, updated_at = datetime('now') WHERE id = ?")
      .run(data.entities.slice(0, 5).join(', '), part.id);
    res.json({ vision: data, part: getPart(part.id) });
  });

  // Copy weight/dimensions from another part
  router.post('/parts/:id/copy-dimensions', (req, res) => {
    const part = getPart(req.params.id);
    if (!part) return res.status(404).json({ error: 'No encontrada' });
    const { from_id } = req.body;
    if (!from_id) return res.status(400).json({ error: 'Falta from_id' });
    const source = db.prepare('SELECT weight_lbs, box_length_in, box_width_in, box_height_in FROM parts WHERE id = ?').get(from_id);
    if (!source) return res.status(404).json({ error: 'Pieza origen no encontrada' });
    db.prepare(`UPDATE parts SET
      weight_lbs = ?, box_length_in = ?, box_width_in = ?, box_height_in = ?,
      ship_weight_lbs = ?, ship_length_in = ?, ship_width_in = ?, ship_height_in = ?,
      updated_at = datetime('now')
      WHERE id = ?`
    ).run(
      source.weight_lbs, source.box_length_in, source.box_width_in, source.box_height_in,
      calcShipping(source.weight_lbs), calcShipping(source.box_length_in),
      calcShipping(source.box_width_in), calcShipping(source.box_height_in),
      part.id
    );
    res.json(getPart(part.id));
  });

  router.delete('/parts/:id', (req, res) => {
    const photos = db.prepare('SELECT filename FROM photos WHERE part_id = ?').all(req.params.id);
    for (const p of photos) {
      const fp = join(UPLOADS_DIR, p.filename);
      if (existsSync(fp)) unlinkSync(fp);
    }
    db.prepare('DELETE FROM photos WHERE part_id = ?').run(req.params.id);
    db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  router.post('/parts/import', (req, res) => {
    const { parts: items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Falta array de parts' });

    const fields = [
      'part_brand', 'tractor_brand', 'tractor_model',
      'part_type_es', 'part_type_en', 'part_number',
      'oem_number', 'measurement', 'quantity', 'condition', 'notes',
      'location', 'clevite_old', 'clevite_new', 'sealed_power',
      'trw', 'zollner', 'oe_brand', 'application',
    ];
    const imported = [];
    for (const item of items) {
      const cols = ['status'];
      const vals = ['pending'];
      for (const f of fields) {
        if (item[f] != null && item[f] !== '') {
          cols.push(f);
          vals.push(f === 'quantity' ? parseInt(item[f], 10) || null : String(item[f]));
        }
      }
      const placeholders = cols.map(() => '?').join(',');
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO parts (${cols.join(',')}) VALUES (${placeholders})`
      ).run(...vals);
      imported.push(lastInsertRowid);
    }
    res.status(201).json({ imported: imported.length, ids: imported });
  });

  router.get('/stats', (req, res) => {
    const counts = { pending: 0, approved: 0, posted: 0, sold: 0 };
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM parts GROUP BY status').all()) {
      counts[row.status || 'pending'] = (counts[row.status || 'pending'] || 0) + row.n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    res.json({ total, ...counts, active: total - counts.sold });
  });

  router.use((err, req, res, next) => {
    const messages = {
      LIMIT_FILE_SIZE: 'Una foto es demasiado grande (máximo 15 MB)',
      LIMIT_FILE_COUNT: 'Máximo 4 fotos por pieza',
      LIMIT_UNEXPECTED_FILE: 'Máximo 4 fotos por pieza',
    };
    const status = err.code in messages || err.message === 'Solo imágenes' ? 400 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: messages[err.code] || err.message || 'Error del servidor' });
  });

  return router;
}
