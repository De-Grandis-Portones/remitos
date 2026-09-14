import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchLabelDataForNv,
  generateCustomRemitoPdf,
  generateCompleteLabelLbxFromLabels,
  generateLabelLbxFromLabels,
  generateSmallLabelLbxFromLabels,
  pdfUrlForRemito,
  pingServer,
  searchRemitosByNumero,
  searchRemitosByNv,
  warmupNv,
} from './api.js';
import TicketWidget from './TicketWidget.jsx';

const WARMUP_EMPRESA = 'portones';
const WARMUP_NV = 4000;
const STATUS_REFRESH_MS = 60000;

const PORTONES_LABEL_FIELDS = [
  { key: 'orderCode', label: 'Numero' },
  { key: 'colorPiernas', label: 'Color piernas' },
  { key: 'revestimiento', label: 'Revestimiento' },
  { key: 'liston', label: 'Liston' },
  { key: 'puerta', label: 'Puerta' },
  { key: 'lucera', label: 'Lucera' },
  { key: 'accionamiento', label: 'Accionamiento' },
  { key: 'tarea', label: 'Instalacion / Embalaje' },
  { key: 'fechaVenta', label: 'Fecha de venta', type: 'date' },
  { key: 'direccion', label: 'Direccion linea 1' },
  { key: 'direccion2', label: 'Localidad (linea 2)' },
  { key: 'cliente', label: 'Cliente' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'comercializa', label: 'Comercializa' },
  { key: 'medidas', label: 'Medidas' },
];

const IPANEL_LABEL_FIELDS = [
  { key: 'orderCode', label: 'NV' },
  { key: 'producto', label: 'Producto' },
  { key: 'cliente', label: 'Cliente / distribuidor' },
  { key: 'direccion', label: 'Direccion' },
  { key: 'localidad', label: 'Localidad' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'observacionItem', label: 'Observaciones' },
];

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('es-AR');
}

function Badge({ children, tone = 'neutral' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeDateInput(v) {
  if (!v) return todayIsoDate();
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayIsoDate();
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function statusLabel(serverStatus) {
  if (serverStatus === 'online') return 'Online';
  if (serverStatus === 'offline') return 'Offline';
  return 'Conectando...';
}

function statusTone(serverStatus) {
  if (serverStatus === 'online') return 'ok';
  if (serverStatus === 'offline') return 'danger';
  return 'warn';
}

function labelFieldsFor(label) {
  return label?.brand === 'ipanel' ? IPANEL_LABEL_FIELDS : PORTONES_LABEL_FIELDS;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function App() {
  const [numero, setNumero] = useState('');
  const [mode, setMode] = useState('nv'); // remito | nv | custom
  const [empresa, setEmpresa] = useState('portones'); // portones | ipanel
  const [loading, setLoading] = useState(false);
  const [labelLoading, setLabelLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState([]);
  const [logoShake, setLogoShake] = useState(null); // 'portones' | 'ipanel' | null
  const [serverStatus, setServerStatus] = useState('checking'); // checking | online | offline
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [labelModalNv, setLabelModalNv] = useState('');
  const [labelModalLabels, setLabelModalLabels] = useState([]);

  const [customHeader, setCustomHeader] = useState(() => ({
    tipo: 'RR',
    sucursal: 1,
    numero: '',
    fecha: todayIsoDate(), // YYYY-MM-DD
    cnro: '',
    nv: '',
    cliente: '',
    nombre: '',
    direccion: '',
    localidad: '',
    provincia: '',
    cp: '',
    iva: '',
    cuit: '',
    ibrutos: '',
    operador: '',
    observ: '',
  }));

  const [customItems, setCustomItems] = useState(() => ([
    { producto: '', cantidad: 1, descripcion: '' },
  ]));

  useEffect(() => {
    document.title = empresa === 'portones' ? 'De Grandis Portones' : 'Ipanels';
  }, [empresa]);

  useEffect(() => {
    let cancelled = false;

    async function refreshServerStatus() {
      if (!cancelled) setServerStatus('checking');

      try {
        const warmup = await warmupNv(WARMUP_NV, WARMUP_EMPRESA);
        if (cancelled) return;

        if (warmup.alive) {
          setServerStatus('online');
          return;
        }

        const health = await pingServer(WARMUP_EMPRESA);
        if (cancelled) return;
        setServerStatus(health.ok ? 'online' : 'offline');
      } catch {
        if (!cancelled) setServerStatus('offline');
      }
    }

    refreshServerStatus();
    const timerId = window.setInterval(refreshServerStatus, STATUS_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, []);

  const canSearch = useMemo(() => String(numero).trim().length > 0, [numero]);

  function triggerLogoShake() {
    setLogoShake(empresa);
    window.setTimeout(() => setLogoShake(null), 420);
  }

  async function onSearch(e) {
    e.preventDefault();
    if (mode === 'custom') return;

    triggerLogoShake();

    setError('');
    setResults([]);

    const n = Number(numero);
    if (!Number.isFinite(n)) {
      setError('Ingresa un numero valido.');
      return;
    }

    setLoading(true);
    try {
      const data = mode === 'nv'
        ? await searchRemitosByNv(Math.trunc(n), empresa)
        : await searchRemitosByNumero(Math.trunc(n), empresa);

      setResults(data.items || []);
      if (!data.items || data.items.length === 0) {
        if (mode === 'nv') {
          window.alert('La NV ingresada no tiene remito aun.');
          setError('');
        } else {
          setError('No se encontraron remitos con ese numero.');
        }
      }
    } catch (err) {
      const msg = err?.message || 'Error';
      if (mode === 'nv' && String(msg).toLowerCase().includes('no tiene remito')) {
        window.alert('La NV ingresada no tiene remito aun.');
        setError('');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  function openPdf(r) {
    if (r._pendingClientApproval) {
      const ok = window.confirm(
        'El cliente final todavia no aprobo esta NV. El remito se va a armar con los datos del presupuesto (pueden cambiar). ¿Generar igual?'
      );
      if (!ok) return;
    } else if (r._linesAreSynthesized) {
      const ok = window.confirm(
        'Esta NV no tiene el detalle de items cargado (viene de Pre-Producción, no del Presupuestador). El remito se va a armar con un resumen general, no con el detalle real del pedido. ¿Generar igual?'
      );
      if (!ok) return;
    }

    let url = pdfUrlForRemito({ tipo: r.tipo, sucursal: r.sucursal, numero: r.numero, empresa });
    if (mode === 'nv' && String(numero).trim() !== '') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}nv=${encodeURIComponent(String(numero).trim())}`;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function openLabelsForNv() {
    triggerLogoShake();
    setError('');

    const n = Number(numero);
    if (!Number.isFinite(n)) {
      setError('Ingresa un numero de NV valido.');
      return;
    }

    try {
      setLabelLoading(true);
      const data = await fetchLabelDataForNv({ nv: Math.trunc(n), empresa });
      const labels = (data.labels || []).map((label) => ({
        ...label,
        fecha: normalizeDateInput(label.fecha),
        fechaVenta: normalizeDateInput(label.fechaVenta),
      }));

      if (!labels.length) {
        setError('No se encontraron datos para generar la etiqueta.');
        return;
      }

      setLabelModalNv(String(Math.trunc(n)));
      setLabelModalLabels(labels);
      setLabelModalOpen(true);
    } catch (err) {
      setError(err?.message || 'Error al preparar etiqueta');
    } finally {
      setLabelLoading(false);
    }
  }

  function updateLabelField(labelIndex, key, value) {
    setLabelModalLabels((prev) => prev.map((label, idx) => (
      idx === labelIndex ? { ...label, [key]: value } : label
    )));
  }

  function closeLabelModal() {
    if (labelLoading) return;
    setLabelModalOpen(false);
    setLabelModalLabels([]);
    setLabelModalNv('');
  }

  async function downloadEditedLabelLbx() {
    if (!labelModalLabels.length) return;

    try {
      setLabelLoading(true);
      setError('');
      const blob = await generateLabelLbxFromLabels({
        labels: labelModalLabels,
        nv: labelModalNv,
        empresa,
      });
      const prefix = empresa === 'ipanel' ? 'etiqueta-ipanel' : 'etiqueta-portones';
      downloadBlob(blob, `${prefix}-${labelModalNv || 'nv'}.lbx`);
      closeLabelModal();
    } catch (err) {
      setError(err?.message || 'Error al generar archivo LBX');
    } finally {
      setLabelLoading(false);
    }
  }


  async function downloadSmallEditedLabelLbx() {
    if (!labelModalLabels.length) return;

    try {
      setLabelLoading(true);
      setError('');
      const blob = await generateSmallLabelLbxFromLabels({
        labels: labelModalLabels,
        nv: labelModalNv,
        empresa,
        copies: 4,
      });
      downloadBlob(blob, `etiquetas-chicas-portones-${labelModalNv || 'nv'}-x4.lbx`);
    } catch (err) {
      setError(err?.message || 'Error al generar etiqueta chica LBX');
    } finally {
      setLabelLoading(false);
    }
  }


  async function downloadCompleteEditedLabelLbx() {
    if (!labelModalLabels.length) return;

    try {
      setLabelLoading(true);
      setError('');
      const blob = await generateCompleteLabelLbxFromLabels({
        labels: labelModalLabels,
        nv: labelModalNv,
        empresa,
        smallCopies: 4,
      });
      downloadBlob(blob, `etiquetas-completo-portones-${labelModalNv || 'nv'}.lbx`);
      closeLabelModal();
    } catch (err) {
      setError(err?.message || 'Error al generar LBX completo');
    } finally {
      setLabelLoading(false);
    }
  }

  function pickEmpresa(next) {
    setEmpresa(next);
    setResults([]);
    setError('');
  }

  function updateCustomField(key, value) {
    setCustomHeader((prev) => ({ ...prev, [key]: value }));
  }

  function updateCustomItem(idx, key, value) {
    setCustomItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  }

  function addCustomItem() {
    setCustomItems((prev) => [...prev, { producto: '', cantidad: 1, descripcion: '' }]);
  }

  function removeCustomItem(idx) {
    setCustomItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function resetCustom() {
    setCustomHeader((prev) => ({
      ...prev,
      tipo: 'RR',
      sucursal: 1,
      numero: '',
      fecha: todayIsoDate(),
      cnro: '',
      nv: '',
      cliente: '',
      nombre: '',
      direccion: '',
      localidad: '',
      provincia: '',
      cp: '',
      iva: '',
      cuit: '',
      ibrutos: '',
      operador: '',
      observ: '',
    }));
    setCustomItems([{ producto: '', cantidad: 1, descripcion: '' }]);
    setError('');
  }

  async function onGenerateCustomPdf() {
    triggerLogoShake();
    setError('');

    const header = {
      ...customHeader,
      sucursal: Number(customHeader.sucursal || 0),
      numero: Number(customHeader.numero || 0),
      cnro: String(customHeader.cnro || '').trim() ? Number(customHeader.cnro) : null,
      nv: String(customHeader.nv || '').trim() ? Number(customHeader.nv) : null,
      fecha: customHeader.fecha ? new Date(`${customHeader.fecha}T00:00:00`).toISOString() : new Date().toISOString(),
    };

    const items = customItems
      .map((it) => ({
        producto: String(it.producto || '').trim(),
        cantidad: Number(it.cantidad || 0),
        descripcion: String(it.descripcion || '').trim(),
      }))
      .filter((it) => it.producto || it.descripcion);

    if (!header.tipo || !header.sucursal || !header.numero) {
      window.alert('Completa Tipo, Sucursal y Numero de remito.');
      return;
    }
    if (!header.nombre || String(header.nombre).trim() === '') {
      window.alert('Completa el nombre del cliente.');
      return;
    }
    if (items.length === 0) {
      window.alert('Agrega al menos 1 item.');
      return;
    }

    try {
      setLoading(true);
      const blob = await generateCustomRemitoPdf({ empresa, header, items });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err?.message || 'Error al generar PDF');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div className="brand">
          <button
            type="button"
            className={`logo-btn ${empresa === 'portones' ? 'active' : ''}`}
            onClick={() => pickEmpresa('portones')}
            title="De Grandis Portones"
          >
            <img
              className={`logo ${logoShake === 'portones' ? 'shake' : ''}`}
              src="/logo.ico"
              alt="De Grandis Portones"
            />
          </button>

          <button
            type="button"
            className={`logo-btn ${empresa === 'ipanel' ? 'active' : ''}`}
            onClick={() => pickEmpresa('ipanel')}
            title="IPANELS"
          >
            <img
              className={`logo ${logoShake === 'ipanel' ? 'shake' : ''}`}
              src="/logoipanel.png"
              alt="IPANELS"
            />
          </button>

          <div className="brand-text">
            <h1>{empresa === 'portones' ? 'De Grandis Portones' : 'Ipanels'}</h1>
            <div className="brand-status">
              <span className={`status-dot status-dot-${serverStatus}`} aria-hidden="true" />
              <span className="status-caption">Servidor Portones</span>
              <Badge tone={statusTone(serverStatus)}>{statusLabel(serverStatus)}</Badge>
            </div>
          </div>
        </div>

        <TicketWidget />
      </header>

      <form className="card" onSubmit={onSearch}>
        <div className="mode">
          <label>
            <input
              type="radio"
              name="mode"
              value="nv"
              checked={mode === 'nv'}
              onChange={() => { setMode('nv'); setResults([]); setError(''); }}
            />
            NV
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="remito"
              checked={mode === 'remito'}
              onChange={() => { setMode('remito'); setResults([]); setError(''); }}
            />
            Remito
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="custom"
              checked={mode === 'custom'}
              onChange={() => { setMode('custom'); setResults([]); setError(''); }}
            />
            Custom
          </label>
        </div>

        {mode !== 'custom' ? (
          <>
            <label className="label">
              {mode === 'nv' ? 'Numero de NV' : 'Numero de remito'}
              <input
                className="input"
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                placeholder={mode === 'nv' ? 'Ej: 1234' : 'Ej: 670'}
                inputMode="numeric"
              />
            </label>
            <div className="row">
              <button className="btn" disabled={!canSearch || loading} type="submit">
                {loading ? 'Buscando...' : 'Buscar'}
              </button>
              {mode === 'nv' ? (
                <button className="btn btn-secondary" disabled={!canSearch || labelLoading} type="button" onClick={openLabelsForNv}>
                  {labelLoading ? 'Cargando...' : 'Etiqueta'}
                </button>
              ) : null}
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => { setNumero(''); setResults([]); setError(''); }}
              >
                Limpiar
              </button>
            </div>
          </>
        ) : (
          <div className="custom">
            <div className="custom-grid">
              <div>
                <div className="section-title">Remito</div>
                <div className="grid2">
                  <label className="label">
                    Tipo
                    <input
                      className="input"
                      value={customHeader.tipo}
                      onChange={(e) => updateCustomField('tipo', e.target.value.toUpperCase())}
                    />
                  </label>
                  <label className="label">
                    Sucursal
                    <input
                      className="input"
                      type="number"
                      value={customHeader.sucursal}
                      onChange={(e) => updateCustomField('sucursal', e.target.value)}
                    />
                  </label>
                  <label className="label">
                    Numero
                    <input
                      className="input"
                      type="number"
                      value={customHeader.numero}
                      onChange={(e) => updateCustomField('numero', e.target.value)}
                    />
                  </label>
                  <label className="label">
                    Fecha
                    <input
                      className="input"
                      type="date"
                      value={customHeader.fecha}
                      onChange={(e) => updateCustomField('fecha', e.target.value)}
                    />
                  </label>
                  <label className="label">
                    Factura Nro. (opcional)
                    <input
                      className="input"
                      type="number"
                      value={customHeader.cnro}
                      onChange={(e) => updateCustomField('cnro', e.target.value)}
                    />
                  </label>
                  <label className="label">
                    NV (opcional)
                    <input
                      className="input"
                      type="number"
                      value={customHeader.nv}
                      onChange={(e) => updateCustomField('nv', e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div>
                <div className="section-title">Cliente</div>
                <div className="grid2">
                  <label className="label">
                    Codigo
                    <input className="input" value={customHeader.cliente} onChange={(e) => updateCustomField('cliente', e.target.value)} />
                  </label>
                  <label className="label">
                    Nombre
                    <input className="input" value={customHeader.nombre} onChange={(e) => updateCustomField('nombre', e.target.value)} />
                  </label>
                  <label className="label grid-span-2">
                    Direccion
                    <input className="input" value={customHeader.direccion} onChange={(e) => updateCustomField('direccion', e.target.value)} />
                  </label>
                  <label className="label">
                    Localidad
                    <input className="input" value={customHeader.localidad} onChange={(e) => updateCustomField('localidad', e.target.value)} />
                  </label>
                  <label className="label">
                    Provincia
                    <input className="input" value={customHeader.provincia} onChange={(e) => updateCustomField('provincia', e.target.value)} />
                  </label>
                  <label className="label">
                    CP
                    <input className="input" value={customHeader.cp} onChange={(e) => updateCustomField('cp', e.target.value)} />
                  </label>
                  <label className="label">
                    IVA
                    <input className="input" value={customHeader.iva} onChange={(e) => updateCustomField('iva', e.target.value)} />
                  </label>
                  <label className="label">
                    CUIT
                    <input className="input" value={customHeader.cuit} onChange={(e) => updateCustomField('cuit', e.target.value)} />
                  </label>
                  <label className="label">
                    Ingresos Brutos
                    <input className="input" value={customHeader.ibrutos} onChange={(e) => updateCustomField('ibrutos', e.target.value)} />
                  </label>
                  <label className="label">
                    Operador (firma)
                    <input className="input" value={customHeader.operador} onChange={(e) => updateCustomField('operador', e.target.value)} />
                  </label>
                </div>
              </div>
            </div>

            <div className="section-title">Items</div>
            <div className="items">
              {customItems.map((it, idx) => (
                <div className="item-row" key={idx}>
                  <input
                    className="input item-prod"
                    placeholder="Producto"
                    value={it.producto}
                    onChange={(e) => updateCustomItem(idx, 'producto', e.target.value)}
                  />
                  <input
                    className="input item-qty"
                    type="number"
                    step="0.01"
                    placeholder="Cant."
                    value={it.cantidad}
                    onChange={(e) => updateCustomItem(idx, 'cantidad', e.target.value)}
                  />
                  <input
                    className="input item-desc"
                    placeholder="Descripcion"
                    value={it.descripcion}
                    onChange={(e) => updateCustomItem(idx, 'descripcion', e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => removeCustomItem(idx)}
                    disabled={customItems.length <= 1}
                    title="Quitar"
                  >
                    Quitar
                  </button>
                </div>
              ))}
              <div className="items-actions">
                <button type="button" className="btn btn-secondary" onClick={addCustomItem}>
                  + Agregar item
                </button>
              </div>
            </div>

            <div className="section-title">Texto inferior</div>
            <label className="label">
              Observacion (se imprime abajo)
              <input className="input" value={customHeader.observ} onChange={(e) => updateCustomField('observ', e.target.value)} />
            </label>

            <div className="row">
              <button className="btn" type="button" onClick={onGenerateCustomPdf} disabled={loading}>
                {loading ? 'Generando...' : 'Generar PDF'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={resetCustom} disabled={loading}>
                Limpiar
              </button>
            </div>
          </div>
        )}

        {error ? <div className="error">{error}</div> : null}
      </form>

      {labelModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-header">
              <div>
                <div className="modal-title">Editar etiqueta NV {labelModalNv}</div>
                <div className="modal-subtitle">Revisa y ajusta los datos antes de generar la etiqueta.</div>
              </div>
              <button className="modal-close" type="button" onClick={closeLabelModal} disabled={labelLoading}>x</button>
            </div>

            <div className="modal-body">
              {labelModalLabels.map((label, labelIndex) => (
                <div className="label-edit-card" key={`${label.nv || labelModalNv}-${labelIndex}`}>
                  <div className="label-edit-title">Etiqueta {labelIndex + 1}</div>
                  {label.advertencia ? (
                    <div className="label-warning">{label.advertencia}</div>
                  ) : null}
                  <div className="label-edit-grid">
                    {labelFieldsFor(label).map((field) => (
                      <label className="label label-edit-field" key={field.key}>
                        {field.label}
                        <input
                          className="input"
                          type={field.type || 'text'}
                          value={label[field.key] ?? ''}
                          onChange={(e) => updateLabelField(labelIndex, field.key, e.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" type="button" onClick={closeLabelModal} disabled={labelLoading}>
                Cancelar
              </button>
              {empresa === 'portones' ? (
                <button className="btn" type="button" onClick={downloadCompleteEditedLabelLbx} disabled={labelLoading || labelModalLabels.length === 0}>
                  {labelLoading ? 'Generando...' : 'LBT completo'}
                </button>
              ) : null}
              <button className="btn btn-secondary" type="button" onClick={downloadEditedLabelLbx} disabled={labelLoading || labelModalLabels.length === 0}>
                {labelLoading ? 'Generando...' : 'LBX grande'}
              </button>
              {empresa === 'portones' ? (
                <button className="btn btn-secondary" type="button" onClick={downloadSmallEditedLabelLbx} disabled={labelLoading || labelModalLabels.length === 0}>
                  {labelLoading ? 'Generando...' : 'LBX chico x4'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {results.length > 0 && (
        <section className="card">
          <div className="card-title">
            Resultados <Badge>{results.length}</Badge>
          </div>

          <div className="table">
            <div className="t-head">
              <div>Fecha</div>
              <div>Tipo</div>
              <div>Suc</div>
              <div>Nro</div>
              <div>Cliente</div>
              <div>Estado</div>
              <div></div>
            </div>

            {results.map((r, idx) => (
              <div className="t-row" key={`${r.tipo}-${r.sucursal}-${r.numero}-${idx}`}>
                <div>{fmtDate(r.fecha)}</div>
                <div>{r.tipo}</div>
                <div>{r.sucursal}</div>
                <div>{r.numero}</div>
                <div className="muted">
                  <div><b>{r.cliente}</b> - {r.nombre}</div>
                  <div className="small">{r.localidad} ({r.provincia})</div>
                </div>
                <div>
                  {r.anulado ? <Badge tone="danger">ANULADO</Badge> : <Badge tone="ok">OK</Badge>}
                  {r.pendiente ? <span style={{ marginLeft: 6 }}><Badge tone="warn">PEND</Badge></span> : null}
                </div>
                <div className="right">
                  <button className="btn btn-small" onClick={() => openPdf(r)} type="button">
                    PDF
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="hint">
            Tip: el PDF se abre en una pestana nueva. Desde ahi podes imprimir.
          </div>
        </section>
      )}
    </div>
  );
}
