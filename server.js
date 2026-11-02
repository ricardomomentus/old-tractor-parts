import 'dotenv/config';
import express from 'express';
import { mkdirSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { config } from './src/config.js';
import { initDb } from './src/db.js';
import { apiRouter } from './src/routes/api.js';
import { authConfigured, authRoutes, hasSession, requireAuth, sameOriginOnly } from './src/auth.js';

const { PORT, DATA_DIR, DB_PATH, UPLOADS_DIR, PUBLIC_DIR } = config;

// La carpeta de datos debe existir y poder escribirse (en Docker es un volumen)
try {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  accessSync(DATA_DIR, constants.W_OK);
} catch (err) {
  console.error(`ERROR: no se puede escribir en DATA_DIR=${DATA_DIR} (${err.code || err.message}).`);
  console.error('Revisa que el volumen esté montado y que el usuario del contenedor tenga permisos.');
  process.exit(1);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.warn('AVISO: OPENROUTER_API_KEY no está configurada — la identificación con IA va a fallar.');
}

if (!authConfigured) {
  console.warn('AVISO: APP_USER / APP_PASSWORD no están configuradas — nadie podrá entrar a la app.');
}

const db = await initDb(DB_PATH);
const app = express();

app.disable('x-powered-by');
// Detrás del proxy de Coolify (Traefik): confiar en X-Forwarded-* de redes privadas
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

// Cabeceras de seguridad básicas
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// Health check para Coolify (sin login, no expone datos)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use(express.json({ limit: '10mb' }));
app.use(sameOriginOnly);

// Login (público) — todo lo demás requiere sesión
authRoutes(app);
app.get('/login', (req, res) => {
  if (hasSession(req)) return res.redirect(302, '/');
  res.sendFile(join(PUBLIC_DIR, 'login.html'));
});
app.use(requireAuth);

app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

app.use('/api', apiRouter(db));
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.get('*', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Old Tractor Parts corriendo en http://localhost:${PORT} (datos en ${DATA_DIR})`);
});

// Apagado limpio: Coolify/Docker manda SIGTERM al redeployar
function shutdown(signal) {
  console.log(`${signal} recibido, cerrando servidor...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
