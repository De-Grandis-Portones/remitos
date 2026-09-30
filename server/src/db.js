// Datos del sistema anterior (ERP en SQL Server: bases Portones, Paneles y
// WebApp). El SQL Server se dio de baja (2026-09-30): lo que usa remitos
// quedó copiado en Supabase, schema legacy_sqlserver (ver
// scripts/copiar_legacy_a_supabase.mjs). Para no reescribir cada consulta,
// este módulo mantiene la MISMA interfaz que tenía con mssql
// (getPool(db).request().input(...).query(tsql) -> { recordset }) y traduce
// al vuelo el dialecto de SQL Server que usan routes.js / labelRoutes.js:
//   TOP (n) -> LIMIT, @param -> $n (con el tipo declarado), [x] -> x,
//   dbo.TABLA / [DB].[dbo].[TABLA] -> legacy_sqlserver.db_tabla,
//   ISNULL -> COALESCE, CONVERT(tipo, x) -> CAST(x AS tipo), y el orden de
//   los NULL como SQL Server (primero en ASC, último en DESC).
// TRY_CONVERT no existía en el SQL Server 2008 R2 de producción: esas
// consultas fallaban y el código pasaba a la variante siguiente. Se emula
// ese mismo error para que el resultado sea idéntico.
import pkg from 'pg';
import { getSupabasePool } from './presupuestadorDb.js';

const { types } = pkg;
const SCHEMA = 'legacy_sqlserver';

// Mismos valores que devolvía mssql: decimal -> number, datetime/date -> Date en UTC.
// Se aplican por consulta: el pool es el mismo del Presupuestador (que usa los tipos por defecto).
const parsers = {
  1700: (v) => (v === null ? null : parseFloat(v)), // numeric
  20: (v) => (v === null ? null : Number(v)), // int8
  1114: (v) => (v === null ? null : new Date(`${v.replace(' ', 'T')}Z`)), // timestamp
  1082: (v) => (v === null ? null : new Date(`${v}T00:00:00Z`)), // date
};
const pgTypes = { getTypeParser: (oid, format) => parsers[oid] || types.getTypeParser(oid, format) };

function getPgPool() {
  const pool = getSupabasePool();
  if (!pool) throw new Error('SUPABASE_DATABASE_URL no configurado');
  return pool;
}

// Nombres como los pliega Postgres sin comillas (solo A-Z).
function plegar(nombre) {
  return String(nombre).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// Nombre original (mayúsculas/minúsculas del SQL Server) de cada columna,
// para devolver las filas con las mismas claves que antes (ej. Pre_Produccion: NV, Nombre).
let _columnas = null;
async function columnasOriginales() {
  if (_columnas) return _columnas;
  const { rows } = await conReintento(() => getPgPool().query({ text: `select db, tabla, columna_pg, columna_original from ${SCHEMA}.columnas`, types: pgTypes }));
  const m = new Map();
  for (const r of rows) {
    const k = `${r.db}_${r.tabla}`;
    if (!m.has(k)) m.set(k, new Map());
    m.get(k).set(r.columna_pg, r.columna_original);
  }
  _columnas = m;
  return m;
}

// ---------------------------------------------------------------- tipos (como mssql)
function tipo(pgCast, nombre) {
  const t = { pgCast, nombre };
  const fn = () => t;
  Object.assign(fn, t);
  return fn;
}
export const sql = {
  Int: tipo('integer', 'Int'),
  SmallInt: tipo('smallint', 'SmallInt'),
  BigInt: tipo('bigint', 'BigInt'),
  VarChar: tipo('varchar', 'VarChar'),
  NVarChar: tipo('varchar', 'NVarChar'),
  Char: tipo('varchar', 'Char'),
  Decimal: tipo('numeric', 'Decimal'),
  Bit: tipo('boolean', 'Bit'),
  Date: tipo('date', 'Date'),
  DateTime: tipo('timestamp', 'DateTime'),
};

// ---------------------------------------------------------------- traductor
// Aplica fn solo a los tramos fuera de literales '...'.
function fueraDeLiterales(texto, fn) {
  return texto.split(/('(?:[^']|'')*')/g).map((parte, i) => (i % 2 ? parte : fn(parte))).join('');
}

function cierreParentesis(texto, abre) {
  let nivel = 0;
  for (let i = abre; i < texto.length; i++) {
    if (texto[i] === '(') nivel++;
    else if (texto[i] === ')') { nivel--; if (nivel === 0) return i; }
  }
  throw new Error('Paréntesis sin cerrar en la consulta');
}

function comaDeNivelCero(texto) {
  let nivel = 0;
  for (let i = 0; i < texto.length; i++) {
    if (texto[i] === '(') nivel++;
    else if (texto[i] === ')') nivel--;
    else if (texto[i] === ',' && nivel === 0) return i;
  }
  return -1;
}

function reemplazarFuncion(texto, nombre, armar) {
  const re = new RegExp(`\\b${nombre}\\s*\\(`, 'i');
  let m;
  while ((m = re.exec(texto))) {
    const abre = m.index + m[0].length - 1;
    const cierra = cierreParentesis(texto, abre);
    const args = texto.slice(abre + 1, cierra);
    const coma = comaDeNivelCero(args);
    if (coma === -1) throw new Error(`${nombre} sin segundo argumento`);
    texto = texto.slice(0, m.index) + armar(args.slice(0, coma).trim(), args.slice(coma + 1).trim()) + texto.slice(cierra + 1);
  }
  return texto;
}

// ORDER BY de nivel superior: NULLS FIRST en ASC / NULLS LAST en DESC (como SQL Server).
function ordenComoSqlServer(texto) {
  const re = /\bORDER\s+BY\b/gi;
  let ultimo = null;
  let m;
  while ((m = re.exec(texto))) {
    const antes = texto.slice(0, m.index);
    const nivel = (antes.match(/\(/g) || []).length - (antes.match(/\)/g) || []).length;
    if (nivel === 0) ultimo = m;
  }
  if (!ultimo) return texto;
  const inicio = ultimo.index + ultimo[0].length;
  const items = [];
  let resto = texto.slice(inicio);
  while (resto.trim()) {
    const c = comaDeNivelCero(resto);
    const item = c === -1 ? resto : resto.slice(0, c);
    items.push(item.trim());
    resto = c === -1 ? '' : resto.slice(c + 1);
  }
  const conNulls = items.map((it) => (/\bDESC$/i.test(it) ? `${it} NULLS LAST` : `${it.replace(/\s+ASC$/i, '')} ASC NULLS FIRST`));
  return `${texto.slice(0, inicio)} ${conNulls.join(', ')}`;
}

export function traducir(tsql, dbPorDefecto, inputs) {
  if (/\bTRY_CONVERT\s*\(/i.test(tsql)) {
    // SQL Server 2008 R2: "'TRY_CONVERT' is not a recognized built-in function name."
    throw new Error("'TRY_CONVERT' is not a recognized built-in function name.");
  }
  const tablas = new Set();
  const params = [];
  let limite = null;

  let q = fueraDeLiterales(tsql.trim().replace(/;\s*$/, ''), (s) => {
    s = s.replace(/(?:\[?([A-Za-z_]\w*)\]?\s*\.\s*)?\[?dbo\]?\s*\.\s*\[?([A-Za-z_]\w*)\]?/gi, (_, db, tabla) => {
      const nombre = `${plegar(db || dbPorDefecto)}_${plegar(tabla)}`;
      tablas.add(nombre);
      return `${SCHEMA}.${nombre}`;
    });
    s = s.replace(/\[([^\]]+)\]/g, '$1');
    return s;
  });

  q = fueraDeLiterales(q, (s) => {
    const tops = s.match(/\bTOP\b/gi) || [];
    if (tops.length > 1) throw new Error('Más de un TOP en la misma consulta: no soportado');
    return s.replace(/\bSELECT\s+(DISTINCT\s+)?TOP\s*(?:\(\s*(@?\w+)\s*\)|(\d+))\s*/i, (_, distinct, expr, num) => {
      limite = expr || num;
      return `SELECT ${distinct || ''}`;
    });
  });

  q = reemplazarFuncion(q, 'CONVERT', (tipoDestino, expr) => `CAST(${expr} AS ${tipoDestino})`);
  q = reemplazarFuncion(q, 'ISNULL', (a, b) => `COALESCE(${a}, ${/^-?\d+(\.\d+)?$/.test(b) ? `'${b}'` : b})`);

  const placeholder = (nombre) => {
    const def = inputs.get(nombre.toLowerCase());
    if (!def) throw new Error(`Must declare the scalar variable "@${nombre}".`);
    let idx = params.findIndex((p) => p.nombre === nombre.toLowerCase());
    if (idx === -1) {
      let valor = def.valor;
      // SQL Server ignora los espacios finales al comparar; Postgres no.
      if (typeof valor === 'string' && def.pgCast === 'varchar') valor = valor.replace(/\s+$/, '');
      params.push({ nombre: nombre.toLowerCase(), valor });
      idx = params.length - 1;
    }
    return `$${idx + 1}::${def.pgCast}`;
  };

  q = fueraDeLiterales(q, (s) => s.replace(/@(\w+)/g, (_, n) => placeholder(n)));
  q = ordenComoSqlServer(q);
  if (limite !== null) q += ` LIMIT ${String(limite).startsWith('@') ? placeholder(limite.slice(1)) : Number(limite)}`;

  // Nombres tal como están escritos en la consulta (SQL Server devuelve la
  // columna como se la nombró en el SELECT), sin los @parámetros.
  const comoEscrito = new Map();
  fueraDeLiterales(tsql, (s) => {
    for (const m of s.matchAll(/(@?)\b([A-Za-z_]\w*)\b/g)) {
      if (!m[1] && !comoEscrito.has(plegar(m[2]))) comoEscrito.set(plegar(m[2]), m[2]);
    }
    return s;
  });

  return { texto: q, valores: params.map((p) => p.valor), tablas: [...tablas], comoEscrito };
}

// routes.js / labelRoutes.js prueban variantes de consulta y toman un error
// como "esta variante no aplica" (columna inexistente, etc.). Un error de
// CONEXIÓN (ej. el pooler de Supabase lleno) no es eso: sin reintentar, una
// NV que existe aparecía como "sin remito". Los errores de SQL (con código
// SQLSTATE de Postgres) se devuelven enseguida, como antes.
function esErrorDeConexion(err) {
  if (/max clients|EMAXCONN|Connection terminated|timeout/i.test(String(err?.message || ''))) return true;
  const code = String(err?.code || '');
  if (/^[0-9A-Z]{5}$/.test(code)) return code.startsWith('08') || code.startsWith('53') || code.startsWith('57P');
  return true; // ECONNRESET, ETIMEDOUT, etc.
}

async function conReintento(fn, intentos = 4) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimo = err;
      if (!esErrorDeConexion(err) || i === intentos - 1) throw err;
      console.warn(`[legacy db] error de conexión (${err.code || err.message}), reintento ${i + 1}`);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw ultimo;
}

class Request {
  constructor(db) {
    this.db = db;
    this.inputs = new Map();
  }

  input(nombre, tipoDef, valor) {
    let def = typeof tipoDef === 'function' ? tipoDef() : tipoDef;
    if (valor === undefined && (def === undefined || def === null || typeof def !== 'object' || !def.pgCast)) {
      // input(nombre, valor) sin tipo
      valor = tipoDef;
      def = { pgCast: typeof valor === 'number' ? 'integer' : 'varchar' };
    }
    this.inputs.set(String(nombre).toLowerCase(), { pgCast: def.pgCast || 'varchar', valor: valor ?? null });
    return this;
  }

  async query(tsql) {
    const { texto, valores, tablas, comoEscrito } = traducir(tsql, this.db, this.inputs);
    const [res, columnas] = await Promise.all([conReintento(() => getPgPool().query({ text: texto, values: valores, types: pgTypes })), columnasOriginales()]);
    const deTablas = new Map();
    for (const t of tablas) for (const [pg, orig] of columnas.get(t) || []) if (!deTablas.has(pg)) deTablas.set(pg, orig);
    const recordset = res.rows.map((fila) => {
      const out = {};
      for (const [k, v] of Object.entries(fila)) out[comoEscrito.get(k) || deTablas.get(k) || k] = v;
      return out;
    });
    return { recordset, rowsAffected: [res.rowCount] };
  }
}

export async function getPool(databaseOverride) {
  const db = databaseOverride || process.env.SQL_DATABASE || 'Portones';
  return { request: () => new Request(db) };
}
