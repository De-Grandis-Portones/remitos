import React, { useEffect, useRef, useState } from 'react';
import { createTicket } from './api.js';
import {
  fileToTicketAttachment,
  formatTicketAttachmentMeta,
  isImageTicketAttachment,
  ticketAttachmentsTotalBytes,
  formatTicketAttachmentsMb,
  MAX_TICKET_ATTACHMENTS_TOTAL_BYTES,
} from './utils/ticketAttachment.js';

// Remitos no tiene ningún sistema de login (toda la API es pública), así que
// a diferencia del mismo widget en las demás apps, acá no hay pestaña "Mis
// tickets" (no hay sesión para filtrar) — solo se puede crear, y quien lo
// manda escribe su nombre a mano. Mismo look que el resto de las apps del
// ecosistema (colores/tamaños hardcodeados a propósito, para que se vea
// igual sin importar el tema propio de cada app).
const TICKET_CATEGORIAS = [
  'Duda sobre el sistema',
  'Error / algo no funciona',
  'Solicitud de acceso o permiso',
  'Consulta sobre un pedido / NV',
  'Otro',
];

const T = {
  surface: '#ffffff',
  ink: '#0f172a',
  inkWeak: '#475569',
  border: '#dfe3e8',
  brand: '#008241',
  brand700: '#0a6a33',
  brand100: '#e8f6ee',
  danger: '#b3261e',
};

export default function TicketWidget() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  const [nombre, setNombre] = useState('');
  const [categoria, setCategoria] = useState(TICKET_CATEGORIAS[0]);
  const [mensaje, setMensaje] = useState('');
  const [adjuntos, setAdjuntos] = useState([]);
  const [subiendoAdjunto, setSubiendoAdjunto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function onDocClick(e) {
      if (open && panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  async function agregarArchivos(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError('');
    setSubiendoAdjunto(true);
    try {
      const nuevos = [];
      for (const file of files) {
        nuevos.push(await fileToTicketAttachment(file));
      }
      const combinados = [...adjuntos, ...nuevos].slice(0, 5);
      const totalBytes = ticketAttachmentsTotalBytes(combinados);
      if (totalBytes > MAX_TICKET_ATTACHMENTS_TOTAL_BYTES) {
        throw new Error(
          `Entre todos los adjuntos no pueden superar ${formatTicketAttachmentsMb(MAX_TICKET_ATTACHMENTS_TOTAL_BYTES)} ` +
          `(llevás ${formatTicketAttachmentsMb(totalBytes)}). Sacá alguno o elegí uno más liviano.`
        );
      }
      setAdjuntos(combinados);
    } catch (err) {
      setError(err.message || 'No se pudo adjuntar el archivo.');
    } finally {
      setSubiendoAdjunto(false);
    }
  }

  async function onSeleccionarArchivos(e) {
    // Copiar el FileList a un array ANTES de limpiar e.target.value - si no,
    // vaciar el input también vacía esta misma referencia (es "viva").
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await agregarArchivos(files);
  }

  function onDropArchivos(e) {
    e.preventDefault();
    if (subiendoAdjunto || adjuntos.length >= 5) return;
    agregarArchivos(e.dataTransfer.files);
  }

  function quitarAdjunto(idx) {
    setAdjuntos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function enviar(e) {
    e.preventDefault();
    if (!nombre.trim()) return setError('Escribí tu nombre.');
    if (!mensaje.trim()) return setError('Escribí el detalle antes de enviar.');
    setError('');
    setEnviando(true);
    try {
      await createTicket({ categoria, mensaje: mensaje.trim(), nombre: nombre.trim(), adjuntos });
      setMensaje('');
      setAdjuntos([]);
      setEnviado(true);
      setTimeout(() => setEnviado(false), 4000);
    } catch (err) {
      if (err?.status === 413) {
        setError('Los adjuntos son demasiado pesados para enviarse juntos. Sacá alguno o achicalo e intentá de nuevo.');
      } else {
        setError(err.message || String(err));
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Tickets"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 10,
          border: `1px solid ${T.border}`, background: T.surface, color: T.ink,
          cursor: 'pointer', fontWeight: 700, fontSize: 14,
        }}
      >
        <img src="/ticket-logo.png" alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} />
        Tickets
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0,
            width: 340, maxWidth: '90vw',
            background: T.surface, color: T.ink,
            border: `1px solid ${T.border}`, borderRadius: 12,
            boxShadow: '0 12px 32px rgba(15,23,42,.18)', zIndex: 1000, overflow: 'hidden',
          }}
        >
          <div style={{ padding: 14, maxHeight: 460, overflowY: 'auto' }}>
            <form onSubmit={enviar} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                  Tu nombre
                </label>
                <input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder="Nombre y apellido"
                  style={{ width: '100%', padding: '9px 10px', borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                  Categoría
                </label>
                <select
                  value={categoria}
                  onChange={(e) => setCategoria(e.target.value)}
                  style={{ width: '100%', padding: '9px 10px', borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, boxSizing: 'border-box' }}
                >
                  {TICKET_CATEGORIAS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                  Contanos tu ticket
                </label>
                <textarea
                  value={mensaje}
                  onChange={(e) => setMensaje(e.target.value)}
                  rows={5}
                  placeholder="Escribí acá el detalle..."
                  style={{ width: '100%', padding: 10, borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, resize: 'vertical', lineHeight: 1.4, boxSizing: 'border-box' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                  Adjuntos (opcional)
                </label>
                <label
                  htmlFor="ticket-adjuntos-input-remitos"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDropArchivos}
                  style={{
                    position: 'relative',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                    padding: '14px 10px', borderRadius: 10, textAlign: 'center',
                    border: `1.5px dashed ${T.border}`, background: T.brand100,
                    opacity: (subiendoAdjunto || adjuntos.length >= 5) ? 0.6 : 1,
                    cursor: (subiendoAdjunto || adjuntos.length >= 5) ? 'not-allowed' : 'pointer',
                  }}
                >
                  <span style={{ fontSize: 20, lineHeight: 1 }}>📎</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: T.brand700 }}>
                    {subiendoAdjunto ? 'Procesando...' : 'Foto, video o PDF'}
                  </span>
                  <span style={{ fontSize: 11, color: T.inkWeak }}>
                    Elegí un archivo o arrastralo acá · máx. 5
                  </span>
                  <input
                    id="ticket-adjuntos-input-remitos"
                    type="file"
                    accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf"
                    multiple
                    onChange={onSeleccionarArchivos}
                    disabled={subiendoAdjunto || adjuntos.length >= 5}
                    style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                  />
                </label>

                {adjuntos.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {adjuntos.map((a, idx) => (
                      <div
                        key={idx}
                        title={formatTicketAttachmentMeta(a)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                          padding: '4px 6px 4px 4px', borderRadius: 999,
                          border: `1px solid ${T.border}`, background: T.surface, fontSize: 12,
                        }}
                      >
                        {isImageTicketAttachment(a) ? (
                          <img
                            src={a.data_url}
                            alt={a.name}
                            style={{ width: 22, height: 22, objectFit: 'cover', borderRadius: '50%', flexShrink: 0 }}
                          />
                        ) : (
                          <span style={{ fontSize: 14, flexShrink: 0 }}>📄</span>
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                          {a.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => quitarAdjunto(idx)}
                          aria-label={`Quitar ${a.name}`}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            width: 18, height: 18, borderRadius: '50%', border: 'none', padding: 0,
                            background: 'rgba(179,38,30,0.12)', color: T.danger,
                            cursor: 'pointer', fontSize: 12, lineHeight: 1,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {error && <div style={{ color: T.danger, fontSize: 12 }}>{error}</div>}
              {enviado && (
                <div style={{ color: T.brand700, fontSize: 12, fontWeight: 600 }}>
                  ¡Listo! Tu ticket fue enviado.
                </div>
              )}

              <button
                type="submit"
                disabled={enviando || !nombre.trim() || !mensaje.trim()}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 13, borderRadius: 10,
                  border: 'none', background: T.brand, color: '#fff', fontWeight: 700, cursor: 'pointer',
                }}
              >
                {enviando ? 'Enviando...' : 'Enviar ticket'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
