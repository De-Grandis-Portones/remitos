const API_BASE = import.meta.env.VITE_API_URL || '';

function withEmpresa(url, empresa) {
  if (!empresa) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}empresa=${encodeURIComponent(empresa)}`;
}

async function httpJsonDetailed(url, options) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text ? { raw: text } : null;
  }
  return { ok: r.ok, status: r.status, data };
}

async function httpJson(url, options) {
  const { ok, status, data } = await httpJsonDetailed(url, options);
  if (!ok) {
    // Un 413 (body-parser rechaza el JSON por tamaño) no trae `data.error`
    // -- el body-parser corta antes de llegar a la ruta -- así que exponemos
    // `status` en el Error para que quien llama pueda dar un mensaje claro
    // en ese caso puntual en vez de un "HTTP 413" genérico.
    const msg = data?.error || `HTTP ${status}`;
    const error = new Error(msg);
    error.status = status;
    throw error;
  }
  return data;
}

async function httpBlob(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) {
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    const msg = data?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return r.blob();
}

export async function pingServer(empresa) {
  const base = `${API_BASE}/api/health`;
  const url = withEmpresa(base, empresa);
  return httpJsonDetailed(url);
}

export async function warmupNv(nv, empresa) {
  const base = `${API_BASE}/api/remitos/search-by-nv?nv=${encodeURIComponent(nv)}`;
  const url = withEmpresa(base, empresa);
  const result = await httpJsonDetailed(url);
  const msg = String(result.data?.error || '').toLowerCase();

  return {
    ...result,
    alive: result.ok || (result.status === 404 && msg.includes('no tiene remito')),
  };
}

export async function searchRemitosByNumero(numero, empresa) {
  const base = `${API_BASE}/api/remitos/search?numero=${encodeURIComponent(numero)}`;
  const url = withEmpresa(base, empresa);
  return httpJson(url);
}

export async function searchRemitosByNv(nv, empresa) {
  const base = `${API_BASE}/api/remitos/search-by-nv?nv=${encodeURIComponent(nv)}`;
  const url = withEmpresa(base, empresa);
  return httpJson(url);
}

export function pdfUrlForRemito({ tipo, sucursal, numero, empresa }) {
  const base = `${API_BASE}/api/remitos/${encodeURIComponent(tipo)}/${encodeURIComponent(sucursal)}/${encodeURIComponent(numero)}/pdf`;
  return withEmpresa(base, empresa);
}


export function labelDataUrlForNv({ nv, empresa }) {
  const base = `${API_BASE}/api/etiquetas/by-nv/data?nv=${encodeURIComponent(nv)}`;
  return withEmpresa(base, empresa);
}

export async function fetchLabelDataForNv({ nv, empresa }) {
  const url = labelDataUrlForNv({ nv, empresa });
  return httpJson(url);
}




export async function generateSmallLabelLbxFromLabels({ labels, nv, empresa, copies = 4 }) {
  const base = `${API_BASE}/api/etiquetas/small/lbx`;
  const url = withEmpresa(base, empresa);
  return httpBlob(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels, nv, empresa, copies }),
  });
}



export async function generateCompleteLabelLbxFromLabels({ labels, nv, empresa, smallCopies = 4 }) {
  const base = `${API_BASE}/api/etiquetas/complete/lbx`;
  const url = withEmpresa(base, empresa);
  return httpBlob(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels, nv, empresa, smallCopies }),
  });
}

export async function generateLabelLbxFromLabels({ labels, nv, empresa }) {
  const base = `${API_BASE}/api/etiquetas/lbx`;
  const url = withEmpresa(base, empresa);
  return httpBlob(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels, nv, empresa }),
  });
}

export function jsonUrlForRemito({ tipo, sucursal, numero, empresa }) {
  const base = `${API_BASE}/api/remitos/${encodeURIComponent(tipo)}/${encodeURIComponent(sucursal)}/${encodeURIComponent(numero)}`;
  return withEmpresa(base, empresa);
}

export async function createTicket({ categoria, mensaje, nombre, adjuntos }) {
  const url = `${API_BASE}/api/tickets`;
  return httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoria, mensaje, nombre, rutaOrigen: 'remitos', adjuntos }),
  });
}

export async function generateCustomRemitoPdf({ empresa, header, items }) {
  const base = `${API_BASE}/api/remitos/custom/pdf`;
  const url = withEmpresa(base, empresa);
  return httpBlob(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ header, items }),
  });
}
