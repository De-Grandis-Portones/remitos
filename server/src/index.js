import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './routes.js';
import labelRoutes from './labelRoutes.js';

// Load .env and OVERRIDE any existing OS env vars.
// This prevents surprises if Windows has e.g. SQL_SERVER=localhost set globally.
dotenv.config();

const app = express();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';

// 25mb: deja lugar a los adjuntos de un ticket (hasta 5, ~15MB cada uno en
// base64) ademas del resto del payload. Ver POST /tickets en routes.js.
app.use(express.json({ limit: '25mb' }));

// CORS: acepta lista separada por comas en CLIENT_ORIGIN, o permite todo si está vacío
const allowedOrigins = CLIENT_ORIGIN
  ? CLIENT_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// Vercel genera una URL nueva por cada deployment (production Y cada preview), todas
// bajo <project>-<hash-opcional>-de-grandis-portones-projects.vercel.app. Si solo
// confiamos en CLIENT_ORIGIN (una URL fija), cualquier preview o redeploy con hash
// nuevo queda bloqueado. Aceptamos por patrón cualquier deployment de ESTE proyecto.
const VERCEL_PREVIEW_ORIGIN = /^https:\/\/remitos(-[a-z0-9-]+)?-de-grandis-portones-projects\.vercel\.app$/i;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (VERCEL_PREVIEW_ORIGIN.test(origin)) return true;
  // Sin CLIENT_ORIGIN configurado, se mantiene el comportamiento previo: permitir todo.
  if (!allowedOrigins.length) return true;
  return allowedOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error(`CORS bloqueado: ${origin}`));
  },
  credentials: false
}));

app.use('/api', apiRoutes);
app.use('/api', labelRoutes);

// Sin esto, un origen rechazado por cors() caía al handler de error default de
// Express: devolvía 500 sin headers de CORS, y el browser lo reportaba como un
// "Failed to fetch"/500 confuso en vez de un bloqueo de CORS claro.
app.use((err, req, res, next) => {
  if (err && String(err.message || '').startsWith('CORS bloqueado')) {
    return res.status(403).json({ error: err.message });
  }
  return next(err);
});

// Optional: serve built client
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serveClient = (process.env.SERVE_CLIENT ?? 'false').toLowerCase() === 'true';

if (serveClient) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Remitos server listening on http://localhost:${PORT}`);
  // Helpful startup diagnostics (no password printed)
  console.log('DB config:', {
    SQL_SERVER: process.env.SQL_SERVER,
    SQL_PORT: process.env.SQL_PORT,
    SQL_DATABASE: process.env.SQL_DATABASE,
    SQL_USER: process.env.SQL_USER,
    SQL_ENCRYPT: process.env.SQL_ENCRYPT,
    SQL_TRUST_SERVER_CERT: process.env.SQL_TRUST_SERVER_CERT,
    SQL_INSTANCE_NAME: process.env.SQL_INSTANCE_NAME
  });
});
