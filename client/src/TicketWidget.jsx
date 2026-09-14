import React, { useEffect, useRef, useState } from 'react';
import { createTicket } from './api.js';
import {
  fileToTicketAttachment,
  formatTicketAttachmentMeta,
} from './utils/ticketAttachment.js';

// Remitos no tiene ningún sistema de login (toda la API es pública), así que
// a diferencia del mismo widget en las demás apps, acá no hay pestaña "Mis
// tickets" (no hay sesión para filtrar) — solo se puede crear, y quien lo
// manda escribe su nombre a mano.
const TICKET_CATEGORIAS = [
  'Duda sobre el sistema',
  'Error / algo no funciona',
  'Solicitud de acceso o permiso',
  'Consulta sobre un pedido / NV',
  'Otro',
];

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

  async function onSeleccionarArchivos(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setError('');
    setSubiendoAdjunto(true);
    try {
      const nuevos = [];
      for (const file of files) {
        nuevos.push(await fileToTicketAttachment(file));
      }
      setAdjuntos((prev) => [...prev, ...nuevos].slice(0, 5));
    } catch (err) {
      setError(err.message || 'No se pudo adjuntar el archivo.');
    } finally {
      setSubiendoAdjunto(false);
    }
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
      setError(err.message || String(err));
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
          padding: '8px 12px', borderRadius: 8,
          border: '1px solid #d0d0d0', background: '#fff', cursor: 'pointer',
        }}
      >
        <img src="/ticket-logo.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain' }} />
        Tickets
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0,
            width: 320, maxWidth: '90vw',
            background: '#fff', border: '1px solid #d0d0d0', borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,.18)', zIndex: 1000, padding: 14,
          }}
        >
          <form onSubmit={enviar}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Tu nombre</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Nombre y apellido"
              style={{ width: '100%', padding: 8, marginBottom: 10, borderRadius: 8, border: '1px solid #d0d0d0' }}
            />

            <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Categoría</label>
            <select
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              style={{ width: '100%', padding: 8, marginBottom: 10, borderRadius: 8, border: '1px solid #d0d0d0' }}
            >
              {TICKET_CATEGORIAS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Contanos tu ticket</label>
            <textarea
              value={mensaje}
              onChange={(e) => setMensaje(e.target.value)}
              rows={5}
              placeholder="Escribí acá el detalle..."
              style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #d0d0d0', resize: 'vertical' }}
            />

            <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Adjuntar foto, video o PDF (opcional)</label>
            <input
              type="file"
              accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf"
              multiple
              onChange={onSeleccionarArchivos}
              disabled={subiendoAdjunto || adjuntos.length >= 5}
              style={{ fontSize: 12 }}
            />
            {subiendoAdjunto && <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>Procesando...</div>}
            {adjuntos.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {adjuntos.map((a, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      fontSize: 12, padding: '4px 8px', marginBottom: 4,
                      borderRadius: 6, border: '1px solid #d0d0d0',
                    }}
                  >
                    <span>{formatTicketAttachmentMeta(a)}</span>
                    <button
                      type="button"
                      onClick={() => quitarAdjunto(idx)}
                      style={{ background: 'none', border: 'none', color: '#b3261e', cursor: 'pointer', padding: 0 }}
                    >
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            )}

            {error && <div style={{ color: '#b3261e', fontSize: 12, marginTop: 6 }}>{error}</div>}
            {enviado && <div style={{ color: '#1f7a45', fontSize: 12, marginTop: 6 }}>¡Listo! Tu ticket fue enviado.</div>}

            <button
              type="submit"
              disabled={enviando}
              style={{
                width: '100%', marginTop: 10, padding: '8px 12px', borderRadius: 8,
                border: 'none', background: '#1f7a45', color: '#fff', cursor: 'pointer', fontWeight: 600,
              }}
            >
              {enviando ? 'Enviando...' : 'Enviar ticket'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
