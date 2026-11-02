// Login simple de un solo usuario.
// Sesión = cookie httpOnly firmada con HMAC-SHA256 (sin dependencias extra).
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

const COOKIE = 'otp_session';
const DAY_MS = 24 * 60 * 60 * 1000;

const APP_USER = process.env.APP_USER || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS) || 30);
const SESSION_MS = SESSION_DAYS * DAY_MS;

export const authConfigured = Boolean(APP_USER && APP_PASSWORD);

// Secreto para firmar la sesión. Si no viene SESSION_SECRET, se genera uno y se
// guarda en el volumen de datos, así sobrevive a redeploys sin configurar nada.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = join(config.DATA_DIR, '.session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// La llave incluye usuario+contraseña: si cambias la contraseña en Coolify,
// todas las sesiones abiertas se cierran solas.
let signingKey;
function key() {
  if (!signingKey) {
    signingKey = createHmac('sha256', loadSecret())
      .update(`${APP_USER}\n${APP_PASSWORD}`)
      .digest();
  }
  return signingKey;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = createHmac('sha256', key()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  let given;
  try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Comparación en tiempo constante (se hashea primero para igualar longitudes)
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignorar */ }
  }
  return out;
}

function setSessionCookie(req, res) {
  const now = Date.now();
  const token = sign({ u: APP_USER, iat: now, exp: now + SESSION_MS });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure, // true detrás de HTTPS (Coolify/Traefik)
    maxAge: SESSION_MS,
    path: '/',
  });
}

function getSession(req) {
  return verify(parseCookies(req.headers.cookie)[COOKIE]);
}

export function hasSession(req) {
  return Boolean(getSession(req));
}

// --- Freno contra fuerza bruta: 10 intentos fallidos por IP cada 15 min ---
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function tooManyAttempts(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}

function registerFailure(ip) {
  // Limpieza para que la tabla no crezca sin límite
  if (failures.size > 1000) {
    for (const [k, v] of failures) if (Date.now() - v.first > WINDOW_MS) failures.delete(k);
  }
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

// Rutas públicas: login, health check y lo mínimo para que la PWA sea instalable
// (Chrome descarga manifest e íconos sin cookies).
const PUBLIC_PATHS = new Set([
  '/login', '/login.html', '/login.js', '/style.css',
  '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
  '/favicon.ico',
  '/api/health', '/api/login', '/api/logout',
]);

export function authRoutes(app) {
  app.post('/api/login', (req, res) => {
    if (!authConfigured) {
      return res.status(503).json({
        error: 'Login no configurado: faltan las variables APP_USER y APP_PASSWORD en el servidor.',
      });
    }
    const ip = req.ip;
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    }
    const { user = '', password = '' } = req.body || {};
    const okUser = safeEqual(String(user).trim().toLowerCase(), APP_USER.toLowerCase());
    const okPass = safeEqual(String(password), APP_PASSWORD);
    if (!okUser || !okPass) {
      registerFailure(ip);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    failures.delete(ip);
    setSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
    res.json({ ok: true });
  });
}

// Middleware: todo lo que no sea público requiere sesión válida.
export function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const session = getSession(req);
  if (session) {
    // Sesión deslizante: si ya pasó la mitad de su vida, se renueva sola.
    if (session.exp - Date.now() < SESSION_MS / 2) setSessionCookie(req, res);
    return next();
  }

  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
    return res.redirect(302, '/login');
  }
  return res.status(401).send('No autorizado');
}

// Defensa CSRF extra: peticiones que modifican datos deben venir de este mismo sitio.
export function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* origin inválido */ }
  return res.status(403).json({ error: 'Origen no permitido' });
}
