import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getPool, sql } from './db.js';
import { buildRemitoPdf } from './pdf.js';
import { fetchPreproduccionByNv, fetchPreproduccionByNvIpanel, fetchQuoteByNv } from './presupuestadorDb.js';
import { createTicket } from './ticketsDb.js';

const router = Router();

// POST /tickets es la única ruta de escritura pública de este archivo (todo
// remitos es sin login, ver comentario en ticketsDb.js) que inserta en la
// base de producción COMPARTIDA con el resto del ecosistema. Sin esto,
// cualquiera con la URL puede scriptear POSTs (incluso con adjuntos de
// hasta ~25MB) y llenar esa tabla compartida sin límite.
const ticketsCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados tickets enviados. Esperá unos minutos y probá de nuevo.' },
});

function parseIntSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}


function resolveDatabase(req) {
  const raw = (req.query.empresa ?? req.query.company ?? req.headers['x-empresa'] ?? req.headers['x-company'] ?? '').toString().trim().toLowerCase();
  if (raw === 'ipanel' || raw === 'ipanels' || raw === 'paneles' || raw === 'panel') return 'Paneles';
  if (raw === 'portones' || raw === 'porton' || raw === 'dg' || raw === 'degrandis') return 'Portones';
  // Default: el database configurado en el servicio (Render) o Portones.
  return process.env.SQL_DATABASE || 'Portones';
}


// Health check
router.get('/health', (req, res) => res.json({ ok: true }));

async function fetchFacturaByNv(pool, nv) {
  // La tabla NTASVTAS puede variar entre instalaciones (fecha/cfecha, etc.).
  // Probamos distintos queries para ser tolerantes a schema.
  const attempts = [
    {
      name: 'NTASVTAS(numero,factura,remito,cliente,fecha)',
      sql: `
        SELECT TOP (10) numero, factura, remito, cliente, fecha
        FROM dbo.NTASVTAS
        WHERE numero = @nv
        ORDER BY fecha DESC;
      `
    },
    {
      name: 'NTASVTAS(numero,factura,remito,cliente,cfecha)',
      sql: `
        SELECT TOP (10) numero, factura, remito, cliente, cfecha
        FROM dbo.NTASVTAS
        WHERE numero = @nv
        ORDER BY cfecha DESC;
      `
    },
    {
      name: 'NTASVTAS(numero,factura,remito,cliente)',
      sql: `
        SELECT TOP (10) numero, factura, remito, cliente
        FROM dbo.NTASVTAS
        WHERE numero = @nv;
      `
    }
  ];

  for (const att of attempts) {
    try {
      const r = await pool.request()
        .input('nv', sql.Int, nv)
        .query(att.sql);

      const rows = r.recordset || [];
      const first = rows.find(x => x?.factura !== null && x?.factura !== undefined);
      if (!first) continue;

      // NTASVTAS.remito es la confirmación directa de que esta NV ya fue remitada.
      // Si vino en el resultado y está en null, no confiamos en `factura`: puede
      // haber quedado con un número viejo/reciclado de otra NV (visto en producción:
      // NTASVTAS.factura duplicado entre dos NV distintas), lo que hacía traer un
      // remito de otra venta completamente distinta.
      if ('remito' in first && (first.remito === null || first.remito === undefined)) {
        return null;
      }

      return { factura: first.factura, cliente: first.cliente ?? null };
    } catch (_) {
      // try next attempt
      continue;
    }
  }
  return null;
}


async function fetchRemitoByNvPaneles(pool, nv) {
  // Paneles: NV -> NTASVTAS.remito -> REMITOS/IREMITOS(numero)
  const attempts = [
    {
      name: 'NTASVTAS(numero,remito,fecha)',
      sql: `
        SELECT TOP (10) numero, remito, fecha
        FROM dbo.NTASVTAS
        WHERE numero = @nv AND remito IS NOT NULL
        ORDER BY fecha DESC;
      `
    },
    {
      name: 'NTASVTAS(numero,remito,cfecha)',
      sql: `
        SELECT TOP (10) numero, remito, cfecha
        FROM dbo.NTASVTAS
        WHERE numero = @nv AND remito IS NOT NULL
        ORDER BY cfecha DESC;
      `
    },
    {
      name: 'NTASVTAS(numero,remito)',
      sql: `
        SELECT TOP (10) numero, remito
        FROM dbo.NTASVTAS
        WHERE numero = @nv AND remito IS NOT NULL;
      `
    }
  ];

  for (const att of attempts) {
    try {
      const r = await pool.request()
        .input('nv', sql.Int, nv)
        .query(att.sql);

      const rows = r.recordset || [];
      const first = rows.find(x => x?.remito !== null && x?.remito !== undefined);
      if (first) return first.remito;
    } catch (_) {
      continue;
    }
  }

  return null;
}

async function fetchVentasObservacionByFactura(pool, facturaNro, facturaTipo, facturaSuc) {
  const nro = Number(facturaNro);
  if (!Number.isFinite(nro)) return null;

  const tipo = facturaTipo !== null && facturaTipo !== undefined && String(facturaTipo).trim() !== ''
    ? String(facturaTipo).trim()
    : null;
  const suc = Number(facturaSuc);
  const hasSuc = Number.isFinite(suc);

  // Algunos esquemas guardan la factura en (tipo,sucursal,numero) y otros en (ctipo,csuc,cnro).
  // Además, puede haber duplicados por tipo/sucursal; por eso pedimos varios y tomamos el primero no vacío.
  const obsExpr = `COALESCE(NULLIF(LTRIM(RTRIM(observacion)), ''), NULLIF(LTRIM(RTRIM(observ)), ''))`;

  const attempts = [];

  // Match exacto por tipo/sucursal/numero
  {
    let where = 'numero = @nro';
    if (tipo) where += ' AND tipo = @tipo';
    if (hasSuc) where += ' AND sucursal = @suc';
    attempts.push({
      name: 'VENTAS(tipo/sucursal/numero)',
      sql: `
        SELECT TOP (50) ${obsExpr} AS obs
        FROM dbo.VENTAS
        WHERE ${where}
        ORDER BY fecha DESC;
      `
    });
  }

  // Match exacto por ctipo/csuc/cnro
  {
    let where = 'cnro = @nro';
    if (tipo) where += ' AND ctipo = @tipo';
    if (hasSuc) where += ' AND csuc = @suc';
    attempts.push({
      name: 'VENTAS(ctipo/csuc/cnro)',
      sql: `
        SELECT TOP (50) ${obsExpr} AS obs
        FROM dbo.VENTAS
        WHERE ${where}
        ORDER BY cfecha DESC;
      `
    });
  }

  // Fallbacks (sin tipo/sucursal)
  attempts.push({
    name: 'VENTAS(numero)',
    sql: `
      SELECT TOP (100) ${obsExpr} AS obs
      FROM dbo.VENTAS
      WHERE numero = @nro
      ORDER BY fecha DESC;
    `
  });

  attempts.push({
    name: 'VENTAS(cnro)',
    sql: `
      SELECT TOP (100) ${obsExpr} AS obs
      FROM dbo.VENTAS
      WHERE cnro = @nro
      ORDER BY cfecha DESC;
    `
  });

  for (const att of attempts) {
    try {
      let req = pool.request().input('nro', sql.Int, Math.trunc(nro));
      if (tipo) req = req.input('tipo', sql.VarChar(10), tipo);
      if (hasSuc) req = req.input('suc', sql.Int, Math.trunc(suc));

      const r = await req.query(att.sql);
      const rows = r.recordset || [];
      const firstNonEmpty = rows
        .map(x => x?.obs)
        .find(v => v !== null && v !== undefined && String(v).trim() !== '');

      if (firstNonEmpty) return firstNonEmpty;
    } catch (_) {
      continue;
    }
  }

  return null;
}




async function fetchPanelesNtasvtasObservacion(pool, { nv, remitoNumero }) {
  const obsExpr = `COALESCE(NULLIF(LTRIM(RTRIM(observ)), ''), NULLIF(LTRIM(RTRIM(obs)), ''))`;

  // 1) Si viene NV explícita: buscamos por numero (NV)
  const nvNum = Number(nv);
  if (Number.isFinite(nvNum)) {
    try {
      const r = await pool.request()
        .input('nv', sql.Int, Math.trunc(nvNum))
        .query(`
          SELECT TOP (10) numero, ${obsExpr} AS obs
          FROM dbo.NTASVTAS
          WHERE numero = @nv
            AND (tipo IS NULL OR LTRIM(RTRIM(tipo)) = 'NV')
          ORDER BY fecha DESC;
        `);

      const rows = r.recordset || [];
      const first = rows.find(x => x?.obs);
      if (first?.obs) return { nv: first.numero, obs: first.obs };
    } catch (_) {
      // ignore and fallback
    }
  }

  // 2) Fallback: buscar por remito (mapeo NV->Remito)
  const remNum = Number(remitoNumero);
  if (!Number.isFinite(remNum)) return null;

  try {
    const r = await pool.request()
      .input('rem', sql.Int, Math.trunc(remNum))
      .query(`
        SELECT TOP (50) numero, ${obsExpr} AS obs
        FROM dbo.NTASVTAS
        WHERE remito = @rem
          AND (tipo IS NULL OR LTRIM(RTRIM(tipo)) = 'NV')
        ORDER BY fecha DESC;
      `);

    const rows = r.recordset || [];
    const first = rows.find(x => x?.obs);
    if (first?.obs) return { nv: first.numero, obs: first.obs };
    return null;
  } catch (_) {
    return null;
  }
}


// La NV todavía no tiene remito confirmado en el SQL legado (NTASVTAS.remito IS NULL).
// Nivel 0: la NV YA está cargada en el SQL legado (NTASVTAS/INTASVTAS) aunque todavía
// no se emitió el remito — este es el caso más común y es el pedido real tal cual se
// vendió (productos, cantidades y descripciones reales desde INTASVTAS+PRODUCTOS).
// Nivel 1 (fallback): preproduccion_valores / preproduccion_valores_ipanels (Supabase) —
// se carga recién cuando el cliente final aceptó el link de medición, momento en que el
// pedido queda "apto para fabricar". Si la fila es solo un espejo del legado sin
// nv_lines reales, se arma un resumen sintético a partir de los campos técnicos.
// Nivel 2 (fallback): presupuestador_quotes — mientras el cliente no aceptó, igual
// puede hacer falta remitar; usamos la misma info que ve el cliente en el link de
// aceptación pendiente (nombre/dirección/líneas del presupuesto).
async function fetchPortonesNvFromLegacySql(pool, nv) {
  try {
    // 'ONV' (venta "Otros" vinculada, ej. instalación) puede compartir el mismo
    // numero que el pedido principal (tipo 'NV'/otros). El remito es de la
    // mercadería, no del servicio vinculado, así que nunca debe ganarle al elegir
    // el header — mismo criterio que fetchPreproduccionByNv/fetchQuoteByNv (Supabase).
    const headerR = await pool.request()
      .input('nv', sql.Int, nv)
      .query(`
        SELECT TOP 1 fecha, nombre, direccion, localidad, provincia, observ, dirent, tipo, sucursal
        FROM dbo.NTASVTAS
        WHERE numero = @nv
        ORDER BY CASE WHEN LTRIM(RTRIM(tipo)) = 'ONV' THEN 1 ELSE 0 END ASC, fecha DESC;
      `);

    const header = headerR.recordset?.[0];
    if (!header) return null;

    // Los items quedan atados a (tipo, sucursal, numero) del header elegido, para no
    // mezclar los ítems del portón con los de la venta "Otros" vinculada.
    const itemsR = await pool.request()
      .input('nv', sql.Int, nv)
      .input('tipo', sql.VarChar(10), header.tipo)
      .input('sucursal', sql.SmallInt, header.sucursal)
      .query(`
        SELECT i.producto, i.cantidad, p.descripcion
        FROM dbo.INTASVTAS i
        LEFT JOIN dbo.PRODUCTOS p ON p.codigo = i.producto
        WHERE i.numero = @nv AND i.tipo = @tipo AND i.sucursal = @sucursal
        ORDER BY i.producto;
      `);

    const lines = (itemsR.recordset || []).map((it) => {
      const producto = String(it.producto || '').trim();
      const descripcion = String(it.descripcion || '').trim() || producto;
      return {
        producto,
        qty: Number(it.cantidad) || 1,
        name: descripcion,
        raw_name: descripcion,
      };
    });

    if (lines.length === 0) return null;

    // El destinatario real (cliente final) suele venir en observ/dirent, distinto
    // del titular de cuenta (nombre/direccion) cuando compra un distribuidor.
    const nombre = String(header.observ || '').trim() || String(header.nombre || '').trim();
    const direccion = String(header.dirent || '').trim() || String(header.direccion || '').trim();

    return {
      nombre,
      direccion,
      localidad: direccion ? '' : String(header.localidad || '').trim(),
      provincia: String(header.provincia || '').trim(),
      fecha: header.fecha || null,
      lines,
    };
  } catch (_) {
    return null;
  }
}

function toPendingRemitoDataFromLegacySql(legacyData) {
  return {
    pendingClientApproval: false,
    nombre: legacyData.nombre,
    direccion: legacyData.direccion,
    localidad: legacyData.localidad,
    provincia: legacyData.provincia,
    fecha: legacyData.fecha,
    note: '',
    lines: legacyData.lines,
    // Ítems reales desde INTASVTAS, no un resumen armado.
    linesAreSynthesized: false,
  };
}

function toPendingRemitoData(preproData) {
  return {
    pendingClientApproval: false,
    nombre: preproData.nombre,
    direccion: preproData.direccion,
    localidad: preproData.localidad,
    provincia: preproData.provincia,
    fecha: preproData.fecha_nv || null,
    note: preproData.note || '',
    lines: preproData.nv_lines || [],
    // NV que nunca pasó por el Presupuestador nuevo: los ítems son un resumen
    // armado con los datos técnicos de Pre-Producción, no el detalle real del pedido.
    linesAreSynthesized: !!preproData.linesAreSynthesized,
  };
}

async function fetchPendingRemitoDataFromQuote(nv) {
  const quoteData = await fetchQuoteByNv(nv);
  if (!quoteData) return null;

  const endCustomer = quoteData.end_customer || {};
  return {
    pendingClientApproval: true,
    nombre: String(endCustomer.name || '').trim(),
    direccion: String(endCustomer.address || '').trim(),
    localidad: String(endCustomer.city || '').trim(),
    // presupuestador_quotes.end_customer no guarda provincia por separado.
    provincia: '',
    fecha: quoteData.created_at || null,
    note: quoteData.note || '',
    lines: quoteData.lines || [],
    linesAreSynthesized: false,
  };
}

// Portones / otros / plegados / puerta (comparten preproduccion_valores).
async function fetchPendingRemitoDataByNv(pool, nv) {
  const legacyData = await fetchPortonesNvFromLegacySql(pool, nv);
  if (legacyData) return toPendingRemitoDataFromLegacySql(legacyData);

  const preproData = await fetchPreproduccionByNv(nv);
  if (preproData) return toPendingRemitoData(preproData);
  return fetchPendingRemitoDataFromQuote(nv);
}

// iPanel (usa preproduccion_valores_ipanels en vez de preproduccion_valores).
async function fetchPendingRemitoDataByNvIpanel(nv) {
  const preproData = await fetchPreproduccionByNvIpanel(nv);
  if (preproData) return toPendingRemitoData(preproData);
  return fetchPendingRemitoDataFromQuote(nv);
}

async function fetchHeaderAndItems(pool, { tipo, sucursal, numero }) {

  async function fetchItems(queryInputs, whereSql) {
    // Intentamos enriquecer con descripción desde tablas típicas (si existen).
    // Si falla (tabla/columna inexistente), caemos al query base sin descripción.
    const attempts = [
      {
        name: 'PRODUCTOS(codigo/descripcion)',
        sql: `
          SELECT i.rnd, i.producto, i.cantidad, i.uventa,
                 i.precio, i.bonific, i.preneto,
                 i.facnro, i.facfecha, i.lista,
                 i.cfecha, i.ctipo, i.csuc, i.cnro,
                 i.tipo, i.sucursal, i.numero, i.deposito,
                 p.descripcion AS descripcion
          FROM dbo.IREMITOS i
          LEFT JOIN dbo.PRODUCTOS p ON p.codigo = i.producto
          WHERE ${whereSql}
          ORDER BY ISNULL(i.rnd, 9999), i.producto;
        `
      },
      {
        name: 'ARTICULOS(codigo/descripcion)',
        sql: `
          SELECT i.rnd, i.producto, i.cantidad, i.uventa,
                 i.precio, i.bonific, i.preneto,
                 i.facnro, i.facfecha, i.lista,
                 i.cfecha, i.ctipo, i.csuc, i.cnro,
                 i.tipo, i.sucursal, i.numero, i.deposito,
                 a.descripcion AS descripcion
          FROM dbo.IREMITOS i
          LEFT JOIN dbo.ARTICULOS a ON a.codigo = i.producto
          WHERE ${whereSql}
          ORDER BY ISNULL(i.rnd, 9999), i.producto;
        `
      },
      {
        name: 'ARTICULOS(codart/detalle)',
        sql: `
          SELECT i.rnd, i.producto, i.cantidad, i.uventa,
                 i.precio, i.bonific, i.preneto,
                 i.facnro, i.facfecha, i.lista,
                 i.cfecha, i.ctipo, i.csuc, i.cnro,
                 i.tipo, i.sucursal, i.numero, i.deposito,
                 a.detalle AS descripcion
          FROM dbo.IREMITOS i
          LEFT JOIN dbo.ARTICULOS a ON a.codart = i.producto
          WHERE ${whereSql}
          ORDER BY ISNULL(i.rnd, 9999), i.producto;
        `
      },
      {
        name: 'BASE (sin descripcion)',
        sql: `
          SELECT
            rnd, producto, cantidad, uventa,
            precio, bonific, preneto,
            facnro, facfecha, lista,
            cfecha, ctipo, csuc, cnro,
            tipo, sucursal, numero, deposito
          FROM dbo.IREMITOS
          WHERE ${whereSql.replace(/\bi\./g, '')}
          ORDER BY ISNULL(rnd, 9999), producto;
        `
      }
    ];

    for (const att of attempts) {
      try {
        const req = pool.request();
        for (const [k, v] of Object.entries(queryInputs)) {
          if (k === 'tipo') req.input('tipo', sql.VarChar(10), v);
          else if (k === 'sucursal') req.input('sucursal', sql.Int, v);
          else if (k === 'numero') req.input('numero', sql.Int, v);
          else if (k === 'deposito') req.input('deposito', sql.Int, v);
        }
        const r = await req.query(att.sql);
        return r.recordset || [];
      } catch (_) {
        continue;
      }
    }
    return [];
  }

  const headerR = await pool.request()
    .input('tipo', sql.VarChar(10), tipo)
    .input('sucursal', sql.Int, sucursal)
    .input('numero', sql.Int, numero)
    .query(`
      SELECT TOP 1 *
      FROM dbo.REMITOS
      WHERE tipo=@tipo AND sucursal=@sucursal AND numero=@numero;
    `);

  const header = headerR.recordset?.[0];
  if (!header) return { header: null, items: [] };

  // Items por clave compuesta (preferido)
  let items = await fetchItems(
    { tipo, sucursal, numero },
    'i.tipo=@tipo AND i.sucursal=@sucursal AND i.numero=@numero'
  );

  // Fallback (sin usar cnro): si por clave compuesta no aparecen ítems,
  // intentamos por numero + deposito (si existe) y finalmente solo por numero.
  if (items.length === 0) {
    const dep = header.deposito;
    if (dep !== null && dep !== undefined) {
      items = await fetchItems(
        { numero, deposito: dep },
        'i.numero=@numero AND i.deposito=@deposito'
      );
    }
  }

  if (items.length === 0) {
    items = await fetchItems({ numero }, 'i.numero=@numero');
  }

  return { header, items };
}

// Search headers by numero (can return multiple due to tipo/sucursal)
router.get('/remitos/search', async (req, res) => {
  const numero = parseIntSafe(req.query.numero);
  const limit = Math.min(parseIntSafe(req.query.limit) ?? 20, 100);

  if (numero === null) {
    return res.status(400).json({ error: 'Query param "numero" must be a number.' });
  }

  try {
    const db = resolveDatabase(req);
    const pool = await getPool(db);
    const r = await pool.request()
      .input('numero', sql.Int, numero)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          fecha, tipo, sucursal, numero,
          cliente, nombre, direccion, localidad, cp, provincia,
          fpago, vendedor, operador, zona,
          iva, cuit, ibrutos,
          observ, dirent,
          anulado, pendiente,
          transporte, fechaviaje,
          cnro, cfecha, ctipo, csuc
        FROM dbo.REMITOS
        WHERE numero = @numero
        ORDER BY fecha DESC;
      `);

    return res.json({ items: r.recordset });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: String(err.message || err) });
  }
});

// Search remitos by Nota de Venta (NV)
// NV -> NTASVTAS.factura -> IREMITOS.facnro -> REMITOS
router.get('/remitos/search-by-nv', async (req, res) => {
  const nv = parseIntSafe(req.query.nv);
  const limit = Math.min(parseIntSafe(req.query.limit) ?? 20, 100);

  if (nv === null) {
    return res.status(400).json({ error: 'Query param "nv" must be a number.' });
  }

  try {
    const db = resolveDatabase(req);
    const pool = await getPool(db);
    // Paneles: NV -> NTASVTAS.remito -> REMITOS/IREMITOS(numero)
    if (String(db).toLowerCase() === 'paneles') {
      const remito = await fetchRemitoByNvPaneles(pool, nv);

      // Si la NV no existe en SQL (Paneles) → buscar en el presupuestador nuevo (Supabase)
      if (!remito) {
        const pending = await fetchPendingRemitoDataByNvIpanel(nv);
        if (!pending) {
          return res.status(404).json({ error: 'La NV ingresada no tiene remito aún.' });
        }
        const virtualItem = {
          tipo: 'PP',
          sucursal: 1,
          numero: nv,
          fecha: pending.fecha || new Date().toISOString(),
          cliente: '',
          nombre: pending.nombre,
          direccion: pending.direccion,
          localidad: pending.localidad,
          provincia: pending.provincia,
          cp: '',
          anulado: null,
          pendiente: pending.pendingClientApproval || pending.linesAreSynthesized,
          _fromPresupuestador: true,
          _pendingClientApproval: pending.pendingClientApproval,
          _linesAreSynthesized: pending.linesAreSynthesized,
        };
        return res.json({
          nv,
          fromPresupuestador: true,
          pendingClientApproval: pending.pendingClientApproval,
          linesAreSynthesized: pending.linesAreSynthesized,
          items: [virtualItem],
        });
      }

      const r = await pool.request()
        .input('remito', sql.Int, Number(remito))
        .input('limit', sql.Int, limit)
        .query(`
          SELECT TOP (@limit)
            fecha, tipo, sucursal, numero,
            cliente, nombre, direccion, localidad, cp, provincia,
            fpago, vendedor, operador, zona,
            iva, cuit, ibrutos,
            observ, dirent,
            anulado, pendiente,
            transporte, fechaviaje,
            cnro, cfecha, ctipo, csuc
          FROM dbo.REMITOS
          WHERE numero = @remito
          ORDER BY fecha DESC;
        `);

      const items = r.recordset || [];
      if (items.length === 0) {
        return res.status(404).json({ error: 'La NV ingresada no tiene remito aún.' });
      }

      return res.json({ nv, remito: Number(remito), items });
    }

    // Portones (default): NV -> NTASVTAS.factura -> IREMITOS.facnro -> REMITOS
    const facturaInfo = await fetchFacturaByNv(pool, nv);

    async function fallbackToPresupuestador() {
      const pending = await fetchPendingRemitoDataByNv(pool, nv);
      if (!pending) {
        return res.status(404).json({ error: 'La NV ingresada no tiene remito aún.' });
      }
      const virtualItem = {
        tipo: 'PP',
        sucursal: 1,
        numero: nv,
        fecha: pending.fecha || new Date().toISOString(),
        cliente: '',
        nombre: pending.nombre,
        direccion: pending.direccion,
        localidad: pending.localidad,
        provincia: pending.provincia,
        cp: '',
        anulado: null,
        pendiente: pending.pendingClientApproval || pending.linesAreSynthesized,
        _fromPresupuestador: true,
        _pendingClientApproval: pending.pendingClientApproval,
        _linesAreSynthesized: pending.linesAreSynthesized,
      };
      return res.json({
        nv,
        fromPresupuestador: true,
        pendingClientApproval: pending.pendingClientApproval,
        linesAreSynthesized: pending.linesAreSynthesized,
        items: [virtualItem],
      });
    }

    // Si la NV no existe en SQL → buscar en el presupuestador nuevo (Supabase)
    if (!facturaInfo) {
      return await fallbackToPresupuestador();
    }

    const { factura, cliente: nvCliente } = facturaInfo;

    // Traemos remitos que tengan ítems con esa factura (facnro)
    const r = await pool.request()
      .input('factura', sql.Int, Number(factura))
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          r.fecha, r.tipo, r.sucursal, r.numero,
          r.cliente, r.nombre, r.direccion, r.localidad, r.cp, r.provincia,
          r.fpago, r.vendedor, r.operador, r.zona,
          r.iva, r.cuit, r.ibrutos,
          r.observ, r.dirent,
          r.anulado, r.pendiente,
          r.transporte, r.fechaviaje,
          r.cnro, r.cfecha, r.ctipo, r.csuc
        FROM dbo.REMITOS r
        INNER JOIN (
          SELECT DISTINCT tipo, sucursal, numero
          FROM dbo.IREMITOS
          WHERE facnro = @factura
        ) i ON i.tipo = r.tipo AND i.sucursal = r.sucursal AND i.numero = r.numero
        ORDER BY r.fecha DESC;
      `);

    let items = r.recordset || [];

    // El número de factura puede estar reciclado entre NV distintas (visto en
    // producción). Si sabemos el cliente de la NV, descartamos remitos de un
    // cliente distinto: mostrar el remito de otra venta es peor que no mostrar nada.
    const nvClienteTrim = typeof nvCliente === 'string' ? nvCliente.trim() : nvCliente;
    if (nvClienteTrim) {
      items = items.filter((it) => String(it?.cliente ?? '').trim() === nvClienteTrim);
    }

    if (items.length === 0) {
      return await fallbackToPresupuestador();
    }

    return res.json({ nv, factura: Number(factura), items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: String(err.message || err) });
  }
});

// Get header + items as JSON
router.get('/remitos/:tipo/:sucursal/:numero', async (req, res) => {
  const { tipo } = req.params;
  const sucursal = parseIntSafe(req.params.sucursal);
  const numero = parseIntSafe(req.params.numero);

  if (!tipo || sucursal === null || numero === null) {
    return res.status(400).json({ error: 'Invalid path params. Use /remitos/:tipo/:sucursal/:numero' });
  }

  try {
    const db = resolveDatabase(req);
    const pool = await getPool(db);
    const { header, items } = await fetchHeaderAndItems(pool, { tipo, sucursal, numero });
    if (!header) return res.status(404).json({ error: 'Remito not found' });
    return res.json({ header, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error', detail: String(err.message || err) });
  }
});

// Get PDF for a remito
router.get('/remitos/:tipo/:sucursal/:numero/pdf', async (req, res) => {
  const { tipo } = req.params;
  const sucursal = parseIntSafe(req.params.sucursal);
  const numero = parseIntSafe(req.params.numero);

  if (!tipo || sucursal === null || numero === null) {
    return res.status(400).json({ error: 'Invalid path params. Use /remitos/:tipo/:sucursal/:numero/pdf' });
  }

  // Tipo 'PP' = NV sin remito confirmado: primero SQL legado (NTASVTAS/INTASVTAS),
  // si no está ahí cae a Supabase (Pre-Producción / Presupuestador nuevo).
  if (tipo === 'PP') {
    try {
      const db = resolveDatabase(req);
      const isPaneles = String(db).toLowerCase() === 'paneles';
      const pending = isPaneles
        ? await fetchPendingRemitoDataByNvIpanel(numero)
        : await fetchPendingRemitoDataByNv(await getPool(db), numero);
      if (!pending) return res.status(404).json({ error: 'NV no encontrada en el presupuestador.' });

      const header = {
        tipo: 'PP',
        sucursal: 1,
        numero,
        numerov: numero,
        fecha: pending.fecha || new Date().toISOString(),
        nombre: pending.nombre,
        direccion: pending.direccion,
        localidad: pending.localidad,
        provincia: pending.provincia,
        cliente: '',
        cp: '',
        iva: '',
        cuit: '',
        ibrutos: '',
        operador: '',
        observ: '',
        ventas_observacion: pending.note || '',
      };

      const items = pending.lines.map((l) => ({
        producto: String(l.producto || '').trim(),
        cantidad: Number(l.qty) || 1,
        descripcion: String(l.raw_name || l.name || '').trim(),
      }));

      const pdfBuffer = await buildRemitoPdf({ header, items });
      const filename = `remito-PP-${numero}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      return res.send(pdfBuffer);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'PDF generation error', detail: String(err.message || err) });
    }
  }

  try {
    const db = resolveDatabase(req);
    const pool = await getPool(db);
    const { header, items } = await fetchHeaderAndItems(pool, { tipo, sucursal, numero });
    if (!header) return res.status(404).json({ error: 'Remito not found' });

    // Observación para leyenda inferior:
// - Portones: desde VENTAS.observacion (por factura)
// - Paneles: desde NTASVTAS.observ (por NV), fallback por remito
let ventas_observacion = null;
let numerov = header?.numerov;

if (String(db).toLowerCase() === 'paneles') {
  const nv = parseIntSafe(req.query.nv);
  const info = await fetchPanelesNtasvtasObservacion(pool, { nv, remitoNumero: numero });
  ventas_observacion = info?.obs ?? null;
  if ((numerov === null || numerov === undefined || String(numerov).trim() === '') && info?.nv) {
    numerov = info.nv;
  }
} else {
  const facturaNro = header?.cnro ?? items?.[0]?.facnro;
  const facturaTipo = header?.ctipo ?? items?.[0]?.ctipo;
  const facturaSuc = header?.csuc ?? items?.[0]?.csuc;
  ventas_observacion = await fetchVentasObservacionByFactura(pool, facturaNro, facturaTipo, facturaSuc);
}

const pdfHeader = { ...header, ventas_observacion, numerov };
    const pdfBuffer = await buildRemitoPdf({ header: pdfHeader, items });
    const filename = `remito-${tipo}-${sucursal}-${numero}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'PDF generation error', detail: String(err.message || err) });
  }
});


// Generate PDF from user-provided data (Custom remito)
// POST /api/remitos/custom/pdf?empresa=portones|ipanel
router.post('/remitos/custom/pdf', async (req, res) => {
  try {
    const body = req.body || {};
    const hIn = body.header || body.remito || {};
    const itemsIn = Array.isArray(body.items) ? body.items : (Array.isArray(body.detalle) ? body.detalle : []);

    const tipo = String(hIn.tipo ?? 'RR').trim().toUpperCase().slice(0, 10);
    const sucursal = parseIntSafe(hIn.sucursal) ?? 1;
    const numero = parseIntSafe(hIn.numero);

    if (!tipo || sucursal === null || numero === null) {
      return res.status(400).json({ error: 'Datos inválidos. Requiere tipo, sucursal y numero.' });
    }

    const fecha = hIn.fecha ? new Date(hIn.fecha) : new Date();
    const fechaOk = Number.isFinite(fecha.getTime()) ? fecha.toISOString() : new Date().toISOString();

    const cnro = hIn.cnro !== undefined && hIn.cnro !== null && String(hIn.cnro).trim() !== ''
      ? (parseIntSafe(hIn.cnro) ?? null)
      : null;

    const numerov = hIn.nv !== undefined && hIn.nv !== null && String(hIn.nv).trim() !== ''
      ? (parseIntSafe(hIn.nv) ?? null)
      : (hIn.numerov !== undefined && hIn.numerov !== null && String(hIn.numerov).trim() !== '' ? (parseIntSafe(hIn.numerov) ?? null) : null);

    const observText = String(hIn.observ ?? hIn.observacion ?? hIn.texto ?? '').trim();

    const header = {
      tipo,
      sucursal,
      numero,
      fecha: fechaOk,
      cnro,
      numerov,
      cliente: String(hIn.cliente ?? '').slice(0, 30),
      nombre: String(hIn.nombre ?? '').slice(0, 120),
      direccion: String(hIn.direccion ?? '').slice(0, 140),
      localidad: String(hIn.localidad ?? '').slice(0, 80),
      provincia: String(hIn.provincia ?? '').slice(0, 10),
      cp: String(hIn.cp ?? '').slice(0, 12),
      iva: String(hIn.iva ?? '').slice(0, 10),
      cuit: String(hIn.cuit ?? '').slice(0, 20),
      ibrutos: String(hIn.ibrutos ?? '').slice(0, 30),
      operador: String(hIn.operador ?? '').slice(0, 40),
      // Para la leyenda inferior, pdf.js prioriza ventas_observacion.
      ventas_observacion: observText,
      observ: observText,
    };

    if (!header.nombre || header.nombre.trim() === '') {
      return res.status(400).json({ error: 'Completá el nombre del cliente.' });
    }

    const items = (itemsIn || [])
      .slice(0, 250)
      .map((it) => ({
        producto: String(it.producto ?? it.codigo ?? it.cod ?? '').trim().slice(0, 30),
        cantidad: Number(it.cantidad ?? it.qty ?? it.cant ?? 0),
        descripcion: String(it.descripcion ?? it.detalle ?? it.desc ?? '').trim().slice(0, 500),
      }))
      .filter((it) => it.producto || it.descripcion);

    if (items.length === 0) {
      return res.status(400).json({ error: 'Agregá al menos 1 ítem.' });
    }

    const pdfBuffer = await buildRemitoPdf({ header, items });
    const filename = `remito-custom-${tipo}-${sucursal}-${numero}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'PDF generation error', detail: String(err.message || err) });
  }
});

// Tickets: remitos no tiene login, así que el nombre de quien lo manda viaja
// en el body (lo escribe a mano en el formulario). Se gestionan todos desde
// /admin/tickets en planificación.
const MAX_TICKET_ADJUNTOS = 5;
// ~15MB de bytes crudos de adjuntos (igual al límite combinado del cliente,
// ver ticketAttachment.js) codificado en base64 (~x1.34). Es una defensa de
// segunda línea: el cliente ya valida esto antes de enviar, pero acá no hay
// login, así que no hay que confiar en que el request venga de ese cliente.
const MAX_TICKET_ADJUNTOS_DATA_URL_CHARS = 21 * 1024 * 1024;
// El cliente SIEMPRE genera data_url con FileReader.readAsDataURL(), así que
// nunca debería ser otra cosa. Sin este chequeo, alguien podía mandar
// data_url = "https://atacante.com/pixel.gif" (o un data: URI con un mime no
// permitido, ej. text/html) y que se renderizara solo (<img src>) o se
// abriera (openTicketAttachment) al primer admin que mirara el ticket —
// tracking pixel o, peor, un blob text/html ejecutando JS en el origen del
// panel admin (robo de token vía localStorage). Se valida el mime REAL
// embebido en el data: URI, no el campo `type` (que también lo controla
// quien manda el ticket y no tiene por qué coincidir) — acá es más crítico
// todavía porque esta ruta no tiene login.
const ALLOWED_ADJUNTO_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf|video\/(?:mp4|quicktime|webm));base64,/i;
function normalizeTicketAdjuntos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_TICKET_ADJUNTOS).map((a) => ({
    name: String(a?.name || 'adjunto').slice(0, 200),
    type: String(a?.type || 'application/octet-stream').slice(0, 100),
    size: Number(a?.size || 0) || 0,
    data_url: String(a?.data_url || ''),
    uploaded_at: a?.uploaded_at || new Date().toISOString(),
  })).filter((a) => ALLOWED_ADJUNTO_DATA_URL_RE.test(a.data_url));
}

router.post('/tickets', ticketsCreateLimiter, async (req, res) => {
  try {
    const categoria = String(req.body?.categoria || '').trim();
    const mensaje = String(req.body?.mensaje || '').trim();
    const nombre = String(req.body?.nombre || '').trim();
    const rutaOrigen = req.body?.rutaOrigen ? String(req.body.rutaOrigen) : null;
    const adjuntos = normalizeTicketAdjuntos(req.body?.adjuntos);
    if (!categoria) return res.status(400).json({ error: 'Falta la categoría' });
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });
    if (!nombre) return res.status(400).json({ error: 'Falta tu nombre' });
    const adjuntosChars = adjuntos.reduce((sum, a) => sum + a.data_url.length, 0);
    if (adjuntosChars > MAX_TICKET_ADJUNTOS_DATA_URL_CHARS) {
      return res.status(400).json({ error: 'Los adjuntos superan el tamaño total permitido.' });
    }

    const ticket = await createTicket({ categoria, mensaje, rutaOrigen, creadoPorUsername: nombre, adjuntos });
    return res.json({ ok: true, ticket });
  } catch (err) {
    console.error('POST /tickets error:', err);
    return res.status(500).json({ error: 'Error creando el ticket', detail: String(err.message || err) });
  }
});

export default router;
