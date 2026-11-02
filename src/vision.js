import { readFileSync } from 'fs';

const VISION_MODEL = process.env.VISION_MODEL || 'google/gemini-2.5-flash';
const VERIFY_MODEL = process.env.VERIFY_MODEL || 'anthropic/claude-haiku-5.5';
console.log(`[OTP] Modelo identificación: ${VISION_MODEL}`);
console.log(`[OTP] Modelo verificación: ${VERIFY_MODEL}`);
const TIMEOUT_MS = 90_000;

const IDENTIFY_PROMPT = `Eres un experto en partes de tractor y equipo pesado antiguo (años 1940-1990). Tu trabajo es identificar piezas viejas — casi siempre verás la CAJA original, no la pieza suelta.

PASO 1 — LEE TODO LO VISIBLE EN LA ETIQUETA/CAJA:
- Marca del fabricante de la pieza (Hepolite, Glacier, AE, Michigan, Clevite, Zollner, Mahle, Federal-Mogul, Perfect Circle, Sealed Power, etc.)
- Número de parte impreso en la etiqueta
- Números escritos a mano (pueden ser OEM o referencias internas)
- Número OEM del tractor/motor (ej. Ford C9NN6211C)
- Medida: STD, .010, .020, .030, etc.
- Texto como "For Ford", "For John Deere", cantidad en la caja
- Texto tachado con plumón o tapado con calcomanía — di qué se alcanza a leer y qué no
- País de origen, "Made in England", "Bradford", etc.

PASO 2 — IDENTIFICA EL TIPO DE PIEZA:
Basándote en lo que dice la etiqueta y la forma de la caja:
- Metal de biela (rod bearing / con shell) — caja plana, a veces con dibujo de media luna
- Metal de bancada (main bearing)
- Camisa de cilindro (cylinder sleeve/liner) — caja larga y estrecha
- Anillos de pistón (piston rings)
- Pistón
- Bujes (bushings)
- Válvulas
- Guías de válvula
- Sellos, empaques, juntas
- Otro (especificar)

PASO 3 — PISTAS DEL NÚMERO OEM (solo como referencia, sin confirmar):
Los números Ford tienen un patrón: C9NN6211 → "6211" puede indicar metal de biela; "C9" podría ser 1969; "NN" podría ser línea de tractor. Esto es de memoria y NO está confirmado — ponlo como nota, nunca como dato seguro.

REGLAS:
- NO inventes a qué tractor o motor le queda si la etiqueta no lo dice claramente.
- Si hay texto ilegible, tachado o tapado, dilo. No adivines lo que no se lee.
- Si la marca del tractor/motor no aparece, deja el campo vacío.
- Pon TODOS los números y textos que veas, aunque no sepas qué significan.

Responde SOLO con JSON válido (sin markdown, sin \`\`\`):
{
  "part_brand": "marca del fabricante de la pieza (Hepolite, Glacier, etc.)",
  "tractor_brand": "marca del tractor/motor si se indica (Ford, John Deere, etc.) o vacío",
  "tractor_model": "modelo o motor si se indica, o vacío",
  "part_type_es": "tipo de pieza en español",
  "part_type_en": "tipo de pieza en inglés",
  "part_number": "número de parte principal de la etiqueta",
  "oem_number": "número OEM si se ve (ej. C9NN6211C), o vacío",
  "handwritten_numbers": "números escritos a mano, o vacío",
  "measurement": "medida: STD, .020, etc., o vacío",
  "quantity": "cantidad indicada en la caja, o vacío",
  "condition": "New Old Stock, Used, o lo que se vea",
  "confidence": "Alta, Media, o Baja",
  "all_visible_text": "TODOS los textos y números visibles en la etiqueta/caja, incluyendo los que no sabes qué son",
  "notes": "observaciones: texto tachado, calcomanías, estado de la caja, pistas del OEM sin confirmar"
}`;

const VERIFY_PROMPT = `Eres un segundo experto verificando la identificación de una pieza de tractor/equipo pesado antiguo. Otro experto ya la identificó. Tu trabajo es verificar de forma INDEPENDIENTE mirando las mismas fotos.

Lee todo el texto visible en la caja/etiqueta y responde SOLO con JSON válido (sin markdown):
{
  "part_brand": "marca del fabricante",
  "tractor_brand": "marca del tractor/motor o vacío",
  "part_type_en": "tipo de pieza en inglés",
  "part_number": "número de parte principal",
  "oem_number": "número OEM o vacío",
  "measurement": "medida o vacío",
  "confidence": "Alta, Media, o Baja",
  "all_visible_text": "todo lo que se lee en la etiqueta"
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
  const confLow = ['baja', 'low'].includes(String(primary.confidence).toLowerCase());
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
