import { readFileSync } from 'fs';

const VISION_MODEL = process.env.VISION_MODEL || 'google/gemini-2.5-flash';
const VERIFY_MODEL = process.env.VERIFY_MODEL || 'anthropic/claude-haiku-5.5';
console.log(`[OTP] Modelo identificación: ${VISION_MODEL}`);
console.log(`[OTP] Modelo verificación: ${VERIFY_MODEL}`);
const TIMEOUT_MS = 90_000;

const IDENTIFY_PROMPT = `You are an expert in vintage tractor and heavy equipment parts (1940s-1990s). These parts are for sale in the USA market (eBay, Facebook Marketplace). You will mostly see the ORIGINAL BOX, not the loose part.

STEP 1 — READ EVERYTHING VISIBLE ON THE LABEL/BOX:
- Part manufacturer brand (Hepolite, Glacier, AE, Michigan, Clevite, Zollner, Mahle, Federal-Mogul, Perfect Circle, Sealed Power, etc.)
- Part number printed on the label
- Handwritten numbers (may be OEM or internal references)
- OEM number from the tractor/engine (e.g. Ford C9NN6211C)
- Size: STD, .010, .020, .030, etc.
- Text like "For Ford", "For John Deere", quantity in the box
- Text crossed out with marker or covered by sticker — say what you can and cannot read
- Country of origin, "Made in England", "Bradford", etc.

STEP 2 — IDENTIFY THE PART TYPE:
Based on the label text and box shape:
- Rod bearing (con shell) — flat box, sometimes with half-moon drawing
- Main bearing
- Cylinder sleeve/liner — long narrow box
- Piston rings
- Piston
- Bushings
- Valves
- Valve guides
- Seals, gaskets
- Other (specify)

STEP 3 — OEM NUMBER CLUES (reference only, unconfirmed):
Ford numbers follow a pattern: C9NN6211 → "6211" may indicate rod bearing; "C9" could be 1969; "NN" could be tractor line. This is from memory and NOT confirmed — note it, never state as fact.

RULES:
- DO NOT guess which tractor/engine it fits if the label doesn't clearly say.
- If text is illegible, crossed out, or covered, say so. Don't guess what you can't read.
- If the tractor/engine brand is not shown, leave the field empty.
- List ALL numbers and text you see, even if you don't know what they mean.
- ALL text output must be in English. Part type must be in English.
- The "custom_title" field is for eBay/Facebook USA listings: make it a clear, searchable product title in English (e.g. "Glacier B6495LC Rod Bearing Set Ford 5000 6600 STD"). Max 80 characters. Include brand, part number, part type, tractor brand/model, and size if available.

Respond ONLY with valid JSON (no markdown, no \`\`\`):
{
  "part_brand": "part manufacturer brand (Hepolite, Glacier, etc.)",
  "tractor_brand": "tractor/engine brand if shown (Ford, John Deere, etc.) or empty",
  "tractor_model": "model or engine if shown, or empty",
  "part_type_es": "part type in Spanish",
  "part_type_en": "part type in English",
  "part_number": "main part number from the label",
  "oem_number": "OEM number if visible (e.g. C9NN6211C), or empty",
  "handwritten_numbers": "handwritten numbers, or empty",
  "measurement": "size: STD, .020, etc., or empty",
  "quantity": "quantity shown on box, or empty",
  "condition": "New Old Stock, Used, or what you see",
  "confidence": "High, Medium, or Low",
  "all_visible_text": "ALL visible text and numbers on the label/box, including ones you don't recognize",
  "custom_title": "eBay/FB listing title in English, max 80 chars, brand + part# + type + tractor + size",
  "notes": "observations: crossed-out text, stickers, box condition, unconfirmed OEM clues"
}`;

const VERIFY_PROMPT = `You are a second expert verifying the identification of a vintage tractor/heavy equipment part. Another expert already identified it. Your job is to verify INDEPENDENTLY by looking at the same photos.

Read all visible text on the box/label and respond ONLY with valid JSON (no markdown):
{
  "part_brand": "manufacturer brand",
  "tractor_brand": "tractor/engine brand or empty",
  "part_type_en": "part type in English",
  "part_number": "main part number",
  "oem_number": "OEM number or empty",
  "measurement": "size or empty",
  "confidence": "High, Medium, or Low",
  "all_visible_text": "everything readable on the label"
}`;

async function callModel(model, prompt, imagePaths) {
  const API_KEY = process.env.OPENROUTER_API_KEY;
  if (!API_KEY) throw new Error('OPENROUTER_API_KEY no configurada');

  const content = [{ type: 'text', text: prompt }];
  for (const imgPath of imagePaths) {
    const b64 = readFileSync(imgPath).toString('base64');
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    });
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://momentuscrm.com',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: 2000,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(err => {
    if (err.name === 'TimeoutError') throw new Error(`La IA tardó demasiado (timeout de ${TIMEOUT_MS / 1000} s)`);
    throw new Error(`Sin conexión con OpenRouter: ${err.cause?.code || err.message}`);
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Sin respuesta del modelo ${model}`);

  let clean = text.trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  }
  // Some models include thinking before the JSON — extract the JSON object
  const jsonStart = clean.indexOf('{');
  if (jsonStart > 0) clean = clean.slice(jsonStart);
  const jsonEnd = clean.lastIndexOf('}');
  if (jsonEnd > 0 && jsonEnd < clean.length - 1) clean = clean.slice(0, jsonEnd + 1);

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Respuesta de ${model} no es JSON válido: ${clean.slice(0, 200)}`);
  }
}

function compareResults(primary, verification) {
  const diffs = [];
  const norm = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const contains = (a, b) => {
    const na = norm(a), nb = norm(b);
    return na.includes(nb) || nb.includes(na);
  };

  if (norm(primary.part_brand) && norm(verification.part_brand) &&
      !contains(primary.part_brand, verification.part_brand)) {
    diffs.push(`Marca pieza: "${primary.part_brand}" vs "${verification.part_brand}"`);
  }
  if (norm(primary.part_number) && norm(verification.part_number) &&
      !contains(primary.part_number, verification.part_number)) {
    diffs.push(`Nº parte: "${primary.part_number}" vs "${verification.part_number}"`);
  }
  // Part type: check if key words overlap (bearing/sleeve/ring/etc.)
  const typeWords = ['bearing', 'sleeve', 'liner', 'ring', 'piston', 'bushing', 'valve', 'seal', 'gasket'];
  const getTypeWord = v => typeWords.find(w => norm(v).includes(w)) || norm(v);
  if (norm(primary.part_type_en) && norm(verification.part_type_en) &&
      getTypeWord(primary.part_type_en) !== getTypeWord(verification.part_type_en)) {
    diffs.push(`Tipo pieza: "${primary.part_type_en}" vs "${verification.part_type_en}"`);
  }

  return {
    match: diffs.length === 0,
    diffs,
  };
}

async function visionWebDetect(imagePath) {
  const GKEY = process.env.GOOGLE_VISION_API_KEY;
  if (!GKEY) return null;

  const b64 = readFileSync(imagePath).toString('base64');
  const body = {
    requests: [{
      image: { content: b64 },
      features: [{ type: 'WEB_DETECTION', maxResults: 10 }],
    }],
  };

  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${GKEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      console.error(`[Vision API] Error ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    const web = data.responses?.[0]?.webDetection;
    if (!web) return null;

    const bestGuess = web.bestGuessLabels?.map(l => l.label).join(', ') || '';
    const entities = (web.webEntities || [])
      .filter(e => e.description && e.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(e => e.description);

    console.log(`[Vision API] Best guess: ${bestGuess}`);
    console.log(`[Vision API] Entities: ${entities.join(', ')}`);
    return { bestGuess, entities };
  } catch (err) {
    console.error(`[Vision API] ${err.message}`);
    return null;
  }
}

export async function identifyPart(imagePaths) {
  // Paso 1: IA principal identifica
  console.log(`[OTP] Paso 1: identificando con ${VISION_MODEL}...`);
  const primary = await callModel(VISION_MODEL, IDENTIFY_PROMPT, imagePaths);
  console.log(`[OTP] Paso 1 OK: ${primary.part_brand} ${primary.part_number} (${primary.part_type_en})`);

  // Paso 2: segunda IA verifica
  let verification = null;
  let comparison = { match: false, diffs: ['Verificación no ejecutada'] };
  try {
    console.log(`[OTP] Paso 2: verificando con ${VERIFY_MODEL}...`);
    verification = await callModel(VERIFY_MODEL, VERIFY_PROMPT, imagePaths);
    console.log(`[OTP] Paso 2 OK: ${verification.part_brand} ${verification.part_number} (${verification.part_type_en})`);
    comparison = compareResults(primary, verification);
    console.log(`[OTP] Coinciden: ${comparison.match}${comparison.diffs.length ? ' — ' + comparison.diffs.join('; ') : ''}`);
  } catch (err) {
    console.error(`[OTP] Verificación falló: ${err.message}`);
    comparison = { match: false, diffs: [`Error en verificación: ${err.message}`] };
  }

  // Paso 3: Google Vision — solo si no coinciden, confianza baja, o no se identificó
  const confLow = ['baja', 'low'].includes(String(primary.confidence).toLowerCase().trim());
  const noId = !primary.part_brand && !primary.part_number;
  let visionData = null;
  if (!comparison.match || confLow || noId) {
    console.log(`[OTP] Paso 3: Google Vision (motivo: ${!comparison.match ? 'no coinciden' : confLow ? 'confianza baja' : 'sin identificar'})...`);
    visionData = await visionWebDetect(imagePaths[0]);
  }

  return {
    ...primary,
    verification_match: comparison.match,
    verification_diffs: comparison.diffs,
    verification_data: verification,
    vision_refs: visionData ? visionData.entities.slice(0, 5).join(', ') : null,
    vision_best_guess: visionData?.bestGuess || null,
  };
}

export async function googleVisionLookup(imagePath) {
  return visionWebDetect(imagePath);
}
