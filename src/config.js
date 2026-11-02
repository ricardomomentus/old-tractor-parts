// Configuración central — todo sale de variables de entorno (Coolify / .env)
import 'dotenv/config';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Carpeta de datos persistentes (DB SQLite + fotos). En Docker se monta como volumen.
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  ROOT,
  PORT: Number(process.env.PORT) || 3333,
  DATA_DIR,
  DB_PATH: join(DATA_DIR, 'tractor-parts.db'),
  UPLOADS_DIR: join(DATA_DIR, 'uploads'),
  PUBLIC_DIR: join(ROOT, 'public'),
};
