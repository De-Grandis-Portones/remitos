// ticketsDb.js — sistema de Tickets, COMPARTIDO entre todas las apps del
// ecosistema (planificación, integrador, presupuestador, remitos). Todas
// escriben en las mismas tablas public.tickets / public.ticket_mensajes de
// la base de Supabase que ya usa presupuestadorDb.js (SUPABASE_DATABASE_URL)
// — no hay tabla propia de remitos. Se gestionan todos desde /admin/tickets
// en planificación.
//
// Remitos no tiene ningún sistema de login (confirmado: toda la API es
// pública), así que no hay forma de saber "quién" manda un ticket salvo que
// lo escriba a mano en el formulario — por eso acá no hay "mis tickets"
// (no hay sesión para filtrar), solo crear.
import pkg from 'pg';
const { Pool } = pkg;

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) return null;
  const ssl = (process.env.SUPABASE_SSL ?? 'false').toLowerCase() !== 'false'
    ? { rejectUnauthorized: false }
    : false;
  _pool = new Pool({ connectionString: url, ssl, max: 5, idleTimeoutMillis: 30000 });
  return _pool;
}

let ensured = false;

// Idempotente — mismo esquema final que ya usan planificación/presupuestador.
async function ensureTicketsSchema(pool) {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.tickets (
      id SERIAL PRIMARY KEY,
      categoria TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pending',
      creado_por_id TEXT,
      creado_por_username TEXT,
      ruta_origen TEXT,
      app_origen TEXT NOT NULL DEFAULT 'planificacion',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      adjuntos JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_estado ON public.tickets(estado);
    CREATE INDEX IF NOT EXISTS idx_tickets_creado_por ON public.tickets(creado_por_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_app_origen ON public.tickets(app_origen);

    CREATE TABLE IF NOT EXISTS public.ticket_mensajes (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
      autor_id TEXT,
      autor_username TEXT,
      es_admin BOOLEAN NOT NULL DEFAULT FALSE,
      mensaje TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_mensajes_ticket ON public.ticket_mensajes(ticket_id);

    ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS adjuntos JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
  ensured = true;
}

export async function createTicket({ categoria, mensaje, rutaOrigen, creadoPorUsername, adjuntos }) {
  const pool = getPool();
  if (!pool) throw new Error('SUPABASE_DATABASE_URL no configurado');
  await ensureTicketsSchema(pool);

  const { rows } = await pool.query(
    `
    insert into public.tickets (categoria, mensaje, ruta_origen, creado_por_username, app_origen, adjuntos)
    values ($1, $2, $3, $4, 'remitos', $5::jsonb)
    returning *;
    `,
    [categoria, mensaje, rutaOrigen || null, creadoPorUsername || null, JSON.stringify(Array.isArray(adjuntos) ? adjuntos : [])]
  );
  return rows[0];
}
