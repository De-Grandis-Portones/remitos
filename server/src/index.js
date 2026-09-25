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

app.use(cors({
  origin: allowedOrigins.length
    ? (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS bloqueado: ${origin}`));
      }
    : true,
  credentials: false
}));

app.use('/api', apiRoutes);
app.use('/api', labelRoutes);

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
