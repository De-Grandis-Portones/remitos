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

async function query(text, params = []) {
  const pool = getPool();
  if (!pool) throw new Error('SUPABASE_DATABASE_URL no configurado');
  const res = await pool.query(text, params);
  return res.rows;
}

// ─── Helpers de extracción desde nv_lines ────────────────────────────────────

function normLine(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function extractMotorCondicion(lines) {
  const auto = lines.find(l =>
    normLine(l.raw_name).includes('accionador automatico') ||
    normLine(l.name).includes('automatiz')
  );
  if (auto) return 'AUTOMATICO';
  const manual = lines.find(l => normLine(l.name) === 'manual' || normLine(l.raw_name).includes('sin accionador'));
  if (manual) return 'MANUAL';
  return 'NO';
}

function extractMotorPosicion(lines) {
  const line = lines.find(l =>
    normLine(l.raw_name).includes('accionador') &&
    (normLine(l.raw_name).includes('izquierda') || normLine(l.raw_name).includes('derecha'))
  );
  if (!line) return 'NO';
  if (normLine(line.raw_name).includes('izquierda')) return 'IZQUIERDA';
  return 'DERECHA';
}

function extractPuertaPosicion(lines) {
  const line = lines.find(l =>
    normLine(l.raw_name).includes('puerta') &&
    (normLine(l.raw_name).includes('derecha') || normLine(l.raw_name).includes('izquierda'))
  );
  if (!line) return 'NO';
  if (normLine(line.raw_name).includes('derecha')) return 'DERECHA';
  if (normLine(line.raw_name).includes('izquierda')) return 'IZQUIERDA';
  return 'NO';
}

function extractLucera(lines) {
  const line = lines.find(l => normLine(l.raw_name).includes('lucera') || normLine(l.name).includes('lucera'));
  if (!line) return 'NO';
  if (normLine(line.raw_name).includes('sin lucera') || normLine(line.name).includes('sin')) return 'NO';
  return 'SI';
}

function extractColorSistema(lines) {
  const line = lines.find(l => normLine(l.raw_name).includes('marco y bastidor'));
  if (!line) return 'NO';
  return String(line.name || '').replace(/^Sistema\s*/i, '').trim() || 'NO';
}

function extractColorHoja(lines) {
  const line = lines.find(l =>
    normLine(l.raw_name).includes('revestimiento en lamas') ||
    normLine(l.raw_name).includes('revestimiento color')
  );
  if (!line) return 'NO';
  return String(line.name || '').trim() || 'NO';
}

function extractListon(lines) {
  const line = lines.find(l =>
    normLine(l.raw_name).includes('inserto') ||
    normLine(l.name).toLowerCase().startsWith('list')
  );
  if (!line) return 'NO';
  return String(line.name || '').replace(/^List[oó]n\s*/i, '').trim() || 'NO';
}

// Producto "Instalacion" en el catalogo del presupuestador / Odoo (ID Presupuestador: 2865 · ID Odoo: 2865).
const INSTALACION_PRODUCT_ID = 2865;

function hasInstalacionProduct(lines) {
  return lines.some(l => Number(l.product_id) === INSTALACION_PRODUCT_ID);
}

function extractTipoEmbalaje(lines) {
  const line = lines.find(l =>
    normLine(l.raw_name).includes('embalaje') ||
    normLine(l.name).includes('embalaj')
  );
  if (line) return String(line.name || '').trim() || 'NO';
  const inst = hasInstalacionProduct(lines) || lines.some(l => normLine(l.name).includes('con instalacion'));
  return inst ? 'CON INSTALACION' : 'Despacho';
}

function extractRazSoc(note) {
  const s = String(note || '').trim();
  const m = s.match(/Vendedor:\s*(.+)/i);
  return m ? m[1].trim() : '';
}

function toMmValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // valores < 100 vienen en metros (ej: 4.65), el resto ya esta en mm
  return n < 100 ? Math.round(n * 1000) : Math.round(n);
}

function firstMm(...candidates) {
  for (const c of candidates) {
    const mm = toMmValue(c);
    if (mm != null) return mm;
  }
  return null;
}

// ─── Construye un row compatible con toPortonPreProduccionLabel ───────────────

export function buildFakePreProduccionRow(preproData) {
  const lines = Array.isArray(preproData.nv_lines) ? preproData.nv_lines : [];
  const data = preproData.data || {};
  const dims = data.dimensions || {};

  // Medida final del portón (la aceptada por el cliente), no la medida de hoja/paso.
  // dimensions en mm: si es < 100 está en metros, si >= 100 ya está en mm
  const anchoRaw = data.ancho_final_mm ?? dims.ancho_final_mm ?? (dims.hoja_ancho_m != null ? dims.hoja_ancho_m : null);
  const altoRaw  = data.alto_final_mm  ?? dims.alto_final_mm  ?? (dims.hoja_alto_m  != null ? dims.hoja_alto_m  : null);

  return {
    Nombre:         preproData.nombre    || '',
    Direccion:      preproData.direccion || '',
    Localidad:      preproData.localidad || '',
    RazSoc:         extractRazSoc(preproData.note),
    Fecha_NV:       preproData.fecha_nv  || '',
    Ancho:          anchoRaw,
    Alto:           altoRaw,
    Color_Sistema:  extractColorSistema(lines),
    Color_Hoja:     extractColorHoja(lines),
    Liston:         extractListon(lines),
    PUERTA_Posicion: extractPuertaPosicion(lines),
    Lucera:         extractLucera(lines),
    MOTOR_Condicion: extractMotorCondicion(lines),
    MOTOR_Posicion: extractMotorPosicion(lines),
    Tipo_Embalaje:  extractTipoEmbalaje(lines),
  };
}

// Fallback nivel 3: el portón todavía no tiene fila en preproduccion_valores (eso recien
// se carga cuando el cliente final acepta el link de aceptación de la NV). Se arma la
// etiqueta con lo que haya en presupuestador_quotes. Ancho/alto: measurement_form (medida
// real tomada en el vano por el medidor) pisa a payload.dimensions, con la misma prioridad
// que usa Presupuestador al armar preproduccion_valores (ver measurementFinalization.js,
// buildPreproduccionPayload) — measurement_form solo vive en la fila "original" del
// presupuesto, así que fetchQuoteByNv la trae vía parent_quote_id si matcheó la "copy".
// Dentro de payload.dimensions, width/height es la medida CALCULADA del portón, ya con las
// reglas de vano aplicadas, nunca dimensions.vano_width/vano_height (la abertura en bruto).
export function buildFakeQuoteRow(quoteData) {
  const lines = Array.isArray(quoteData.lines) ? quoteData.lines : [];
  const dims = quoteData.payload?.dimensions || {};
  const measurementForm = quoteData.measurement_form || {};
  const endCustomer = quoteData.end_customer || {};

  const anchoRaw = firstMm(measurementForm.ancho_final_mm, dims.ancho_final_mm, dims.width_mm, dims.width, dims.ancho);
  const altoRaw  = firstMm(measurementForm.alto_final_mm, dims.alto_final_mm, dims.height_mm, dims.height, dims.alto);

  return {
    Nombre:         String(endCustomer.name    || '').trim(),
    Direccion:      String(endCustomer.address || '').trim(),
    Localidad:      String(endCustomer.city    || '').trim(),
    RazSoc:         extractRazSoc(quoteData.note),
    Fecha_NV:       quoteData.created_at || '',
    Ancho:          anchoRaw,
    Alto:           altoRaw,
    Color_Sistema:  extractColorSistema(lines),
    Color_Hoja:     extractColorHoja(lines),
    Liston:         extractListon(lines),
    PUERTA_Posicion: extractPuertaPosicion(lines),
    Lucera:         extractLucera(lines),
    MOTOR_Condicion: extractMotorCondicion(lines),
    MOTOR_Posicion: extractMotorPosicion(lines),
    Tipo_Embalaje:  extractTipoEmbalaje(lines),
  };
}

// Algunas filas de preproduccion_valores son solo un espejo del legado
// WebApp.dbo.Pre_Produccion (sincronizado por Integrador) para NV que nunca
// pasaron por el Presupuestador nuevo: no tienen nv_lines (llega null/[]) pero
// sí tienen los campos técnicos ya calculados (Sistema, Color, Liston, etc.).
// Armamos un ítem resumen con esos datos en vez de dejar el remito sin ítems.
function synthesizeLegacyLines(data) {
  const sistema = String(data?.Sistema || '').trim();
  if (!sistema) return [];

  const color = String(data?.Color_Sistema || data?.Color || '').trim();
  const revestimiento = String(data?.Revestimiento || data?.Color_Hoja || '').trim();
  const liston = String(data?.Liston || '').trim();
  const embalaje = String(data?.Tipo_Embalaje || '').trim();

  const detalle = [
    color && `Color: ${color}`,
    revestimiento && `Revestimiento: ${revestimiento}`,
    liston && liston !== 'NO' && `Listón: ${liston}`,
    embalaje && `Embalaje: ${embalaje}`,
  ].filter(Boolean).join('. ');

  return [{
    name: sistema,
    raw_name: [sistema, detalle].filter(Boolean).join('. '),
    qty: 1,
  }];
}

// ─── Query principal ──────────────────────────────────────────────────────────

// Prefijos reales de nv_tipo usados en Odoo (odoo_sale_order_name / final_sale_order_name):
// NV = portón (también usado como default para "otros"/"plegados"/"puerta" cuando no
// coincide ningún prefijo especial), INV = ipanel, ONV = otros, PLNV = plegados, PNV = puerta.
const NV_TIPO_PREFIXES = ['NV', 'INV', 'ONV', 'PLNV', 'PNV'];

function candidateNvNames(nvInt) {
  return NV_TIPO_PREFIXES.map((prefix) => `${prefix}${nvInt}`);
}

/**
 * Busca en preproduccion_valores (Supabase) por NV. Portón, otros, plegados y puerta
 * comparten esta tabla (se distinguen por nv_tipo); ipanel usa preproduccion_valores_ipanels
 * (ver fetchPreproduccionByNvIpanel). Los datos de cliente salen directo de pv.data
 * (cliente_nombre/cliente_direccion/cliente_localidad), sin depender de ningún JOIN,
 * así funciona sin importar el nv_tipo. Retorna null si no se encuentra nada.
 */
export async function fetchPreproduccionByNv(nv) {
  const nvInt = Math.trunc(Number(nv));
  if (!Number.isFinite(nvInt) || nvInt <= 0) return null;

  try {
    // (nv, nv_tipo) puede tener más de una fila para el mismo nv: además de las que
    // carga el Presupuestador nuevo, un sync viejo (Integrador, desde el legado
    // WebApp.dbo.Pre_Produccion) puede haber dejado otra fila con nv_tipo='NV' y sin
    // nv_lines. Preferimos la fila que realmente tenga ítems cargados.
    // Además, 'ONV' (venta "Otros" vinculada, ej. instalación) puede compartir el
    // mismo nv que el pedido principal (portón/puerta/plegado) y sincronizarse más
    // tarde: nunca debe ganarle a la fila principal, el remito es de la mercadería,
    // no del servicio vinculado.
    const rows = await query(
      `SELECT nv, nv_tipo, nv_lines, data, updated_at
         FROM public.preproduccion_valores
        WHERE nv = $1 AND nv_tipo <> 'INV'
        ORDER BY (nv_tipo = 'ONV') ASC,
                 (jsonb_array_length(coalesce(nv_lines, '[]'::jsonb)) > 0) DESC,
                 updated_at DESC
        LIMIT 1`,
      [nvInt]
    );

    if (!rows.length) return null;
    const row = rows[0];
    const data = row.data || {};

    // data trae 2 formatos posibles: el nuevo (cliente_nombre_completo/cliente_direccion,
    // del Presupuestador) o el viejo (Nombre/Direccion/Fecha_NV, espejo de la fila legada
    // de WebApp.dbo.Pre_Produccion). Probamos el nuevo primero y caemos al viejo.
    const fechaNv = data.fecha_nv || data.Fecha_NV || row.updated_at || null;
    const nombre = data.cliente_nombre_completo || data.cliente_nombre || data.Nombre || '';
    const direccion = data.cliente_direccion || data.Direccion || '';

    const realLines = Array.isArray(row.nv_lines) ? row.nv_lines : [];
    const isSynthesized = realLines.length === 0;
    const nvLines = isSynthesized ? synthesizeLegacyLines(data) : realLines;

    return {
      nv:        row.nv,
      nv_tipo:   row.nv_tipo,
      nv_lines:  nvLines,
      linesAreSynthesized: isSynthesized && nvLines.length > 0,
      data,
      nombre:    String(nombre || '').trim(),
      direccion: String(direccion || '').trim(),
      localidad: String(data.cliente_localidad || '').trim(),
      // presupuestador_quotes.end_customer no guarda provincia por separado.
      provincia: '',
      note:      '',
      fecha_nv:  fechaNv,
    };
  } catch (err) {
    console.warn('[presupuestadorDb] fetchPreproduccionByNv error:', err?.message || err);
    return null;
  }
}

/**
 * Equivalente a fetchPreproduccionByNv pero para iPanel, que usa una tabla propia
 * (preproduccion_valores_ipanels) en vez de preproduccion_valores.
 */
export async function fetchPreproduccionByNvIpanel(nv) {
  const nvInt = Math.trunc(Number(nv));
  if (!Number.isFinite(nvInt) || nvInt <= 0) return null;

  try {
    const rows = await query(
      `SELECT nv, partida, fecha_nv, descripcion, descripcion_simple, data, updated_at
         FROM public.preproduccion_valores_ipanels
        WHERE nv = $1
        LIMIT 1`,
      [nvInt]
    );

    if (!rows.length) return null;
    const row = rows[0];
    const data = row.data || {};
    const nombre = data.cliente_nombre_completo || data.cliente_nombre || '';

    return {
      nv:        row.nv,
      nv_tipo:   'INV',
      nv_lines:  Array.isArray(data.lines) ? data.lines : [],
      data,
      nombre:    String(nombre || '').trim(),
      direccion: String(data.cliente_direccion || '').trim(),
      localidad: String(data.cliente_localidad || '').trim(),
      provincia: '',
      note:      '',
      fecha_nv:  row.fecha_nv || row.updated_at || null,
    };
  } catch (err) {
    console.warn('[presupuestadorDb] fetchPreproduccionByNvIpanel error:', err?.message || err);
    return null;
  }
}

/**
 * Busca directo en presupuestador_quotes (Supabase) por NV, para pedidos que
 * todavia no entraron a produccion (no tienen fila en preproduccion_valores ni
 * preproduccion_valores_ipanels) — típicamente porque el cliente final aún no
 * aceptó el link de medición. Prueba los 5 prefijos posibles (NV/INV/ONV/PLNV/PNV)
 * porque a esta altura no sabemos el catalog_kind, solo el número de NV.
 * Retorna null si no se encuentra nada.
 */
export async function fetchQuoteByNv(nv) {
  const nvInt = Math.trunc(Number(nv));
  if (!Number.isFinite(nvInt) || nvInt <= 0) return null;
  const candidates = candidateNvNames(nvInt);
  // Igual que en fetchPreproduccionByNv: 'ONV<nv>' (venta "Otros" vinculada) puede
  // coexistir con la fila principal (NV/PLNV/PNV<nv>) bajo el mismo número. El remito
  // es de la mercadería, no del servicio vinculado, así que nunca debe ganarle.
  const onvCandidate = `ONV${nvInt}`;

  try {
    const rows = await query(
      `SELECT end_customer, note, lines, payload, measurement_form, quote_kind, parent_quote_id, created_at
         FROM public.presupuestador_quotes
        WHERE odoo_sale_order_name = ANY($1::text[])
           OR final_sale_order_name = ANY($1::text[])
        ORDER BY (coalesce(odoo_sale_order_name = $2, false) OR coalesce(final_sale_order_name = $2, false)) ASC,
                 created_at DESC NULLS LAST
        LIMIT 1`,
      [candidates, onvCandidate]
    );

    if (!rows.length) return null;
    const row = rows[0];

    // La fila que matchea por NV suele ser la "copy" (quote_kind='copy', sincronizada a
    // Odoo), pero measurement_form (medida real tomada en el vano) solo se guarda en la
    // fila "original" de la que salió. Si no vino en la fila matcheada, la buscamos ahí.
    let measurementForm = row.measurement_form && typeof row.measurement_form === 'object' ? row.measurement_form : null;
    if (!measurementForm && row.quote_kind === 'copy' && row.parent_quote_id) {
      const originalRows = await query(
        `SELECT measurement_form FROM public.presupuestador_quotes WHERE id = $1 LIMIT 1`,
        [row.parent_quote_id]
      );
      const originalForm = originalRows[0]?.measurement_form;
      measurementForm = originalForm && typeof originalForm === 'object' ? originalForm : null;
    }

    return {
      end_customer:     row.end_customer || {},
      note:              String(row.note || '').trim(),
      lines:             Array.isArray(row.lines) ? row.lines : [],
      payload:           row.payload || {},
      measurement_form:  measurementForm || {},
      created_at:        row.created_at || null,
    };
  } catch (err) {
    console.warn('[presupuestadorDb] fetchQuoteByNv error:', err?.message || err);
    return null;
  }
}
