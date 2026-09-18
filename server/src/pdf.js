import PDFDocument from 'pdfkit';

function padLeft(v, len) {
  const s = String(v ?? '');
  return s.length >= len ? s : '0'.repeat(len - s.length) + s;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  let hh = dt.getHours();
  const min = String(dt.getMinutes()).padStart(2, '0');
  const sec = String(dt.getSeconds()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  const hhStr = String(hh).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hhStr}:${min}:${sec} ${ampm}`;
}

function formatQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  // 2 decimales como el ejemplo
  return x.toFixed(2);
}

function normalizeText(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function ivaLabel(ivaCode) {
  const c = String(ivaCode ?? '').trim().toUpperCase();
  if (c === 'CF') return 'Consumidor Final';
  if (c === 'RI') return 'IVA Responsable Inscripto';
  if (c === 'EX') return 'Exento';
  if (c === 'MT') return 'Monotributo';
  return c ? c : '';
}

function green(doc) {
  doc.strokeColor('#0b8b1d');
}

function roundedBox(doc, x, y, w, h, r = 8) {
  green(doc);
  doc.lineWidth(2);
  doc.roundedRect(x, y, w, h, r).stroke();
  doc.lineWidth(1);
}

function headerBlock(doc, header) {
  const pageW = doc.page.width;
  const x = 28;
  const y = 22;
  const w = pageW - 56;
  const h = 122;

  roundedBox(doc, x, y, w, h, 10);

  // Logo (vector simple, sin imagen externa)
  const logoX = x + 16;
  const logoY = y + 16;
  doc.save();
  doc.fillColor('#0aa39c');
  doc.roundedRect(logoX, logoY, 42, 42, 6).fill();
  doc.fillColor('white');
  doc.font('Helvetica-Bold').fontSize(18);
  doc.text('DG', logoX, logoY + 10, { width: 42, align: 'center' });
  doc.restore();

  doc.fillColor('black');
  doc.font('Helvetica-Bold').fontSize(20);
  doc.text('DeGrandis', logoX + 52, logoY + 2);
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('PORTONES', logoX + 55, logoY + 30);

  // Datos empresa izquierda
  const companyName = process.env.COMPANY_LEGAL_NAME || 'DFLEX ARGENTINA SAS';
  const companyAddr1 = process.env.COMPANY_ADDR1 || 'Ruta Nacional 9 Km. 658';
  const companyAddr2 = process.env.COMPANY_ADDR2 || 'Pilar - Cordoba';

  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(companyName, logoX, y + 78);
  doc.font('Helvetica').fontSize(9.5);
  doc.text(companyAddr1, logoX, y + 96);
  doc.text(companyAddr2, logoX, y + 110);

  // Caja tipo "R" + codigo
  const codeBoxX = x + w * 0.48;
  const codeBoxY = y + 22;
  doc.rect(codeBoxX, codeBoxY, 42, 32).strokeColor('black').lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fontSize(14);
  doc.text(String(header?.tipo ?? 'R').slice(0, 1), codeBoxX, codeBoxY + 7, { width: 42, align: 'center' });
  doc.font('Helvetica').fontSize(7);
  doc.fillColor('black');
  doc.text('Código Nro 91', codeBoxX - 2, codeBoxY + 36, { width: 46, align: 'center' });
  // Lado derecho: Remito + numeracion
  // Columna derecha (alineada al borde interno para que nunca "sobresalga")
  const rightEdge = x + w - 14; // padding dentro del marco
  const rightColW = 220;
  const rightColX = rightEdge - rightColW;

  // Etiquetas (separadas en 2 líneas para evitar solapado)
  doc.font('Helvetica-Bold').fontSize(14);
  doc.text('REMITO', rightColX, y + 10, { width: rightColW, align: 'center' });

  const suc = padLeft(header?.sucursal ?? '', 4);
  const nro = padLeft(header?.numero ?? '', 10);
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text(`${suc} - ${nro}`, rightColX, y + 28, { width: rightColW, align: 'right' });

  doc.font('Helvetica-Bold').fontSize(12);
  doc.text(`Fecha:  ${formatDate(header?.fecha)}`, rightColX, y + 48, { width: rightColW, align: 'right' });
  doc.font('Helvetica').fontSize(10);
  doc.text('ORIGINAL', rightColX, y + 66, { width: rightColW, align: 'right' });

  // Datos fiscales empresa (derecha)
  const iva = process.env.COMPANY_IVA || 'IVA Responsable Inscripto';
  const cuit = process.env.COMPANY_CUIT || '33-71608175-9';
  const iib = process.env.COMPANY_IIBB || '284463706';
  const start = process.env.COMPANY_START_DATE || '01/09/2018';
  doc.font('Helvetica').fontSize(10);
  doc.text(iva, rightColX, y + 82, { width: rightColW, align: 'right' });
  doc.text(`CUIT:  ${cuit}`, rightColX, y + 96, { width: rightColW, align: 'right' });
  doc.text(`Ingresos Brutos: ${iib}`, rightColX, y + 110, { width: rightColW, align: 'right' });
  doc.text(`Fecha Inicio: ${start}`, rightColX, y + 124, { width: rightColW, align: 'right' });

  return y + h;
}

function customerBlock(doc, header, yStart) {
  const pageW = doc.page.width;
  const x = 28;
  const y = yStart + 12;
  const w = pageW - 56;
  const h = 70;

  roundedBox(doc, x, y, w, h, 10);

  const name = normalizeText(header?.nombre);
  const cliente = header?.cliente ?? '';
  const dir = normalizeText(header?.direccion);
  const loc = normalizeText(header?.localidad);
  const iva = ivaLabel(header?.iva);
  const cuit = normalizeText(header?.cuit);
  const iib = normalizeText(header?.ibrutos);

  doc.fillColor('black');
  doc.font('Helvetica-Bold').fontSize(16);
  doc.text(name || '-', x + 12, y + 10, { width: w - 24 });

  doc.font('Helvetica').fontSize(10);
  doc.text(String(cliente), x + w - 90, y + 12, { width: 78, align: 'right' });

  doc.font('Courier').fontSize(10.5);
  doc.text(`${dir}${loc ? ' ' + loc : ''}`, x + 12, y + 34, { width: w - 24 });

  doc.font('Courier').fontSize(10.5);
  doc.text(iva, x + 12, y + 52, { width: 220 });
  doc.text(cuit, x + w * 0.50 - 40, y + 52, { width: 160, align: 'center' });
  doc.text(iib, x + w - 170, y + 52, { width: 158, align: 'right' });

  return y + h;
}

function tableHeaderBlock(doc, header, yStart) {
  const pageW = doc.page.width;
  const x = 28;
  const y = yStart + 14;
  const w = pageW - 56;
  const h = 28;

  roundedBox(doc, x, y, w, h, 10);

  doc.fillColor('black');
  doc.font('Helvetica').fontSize(11);
  doc.text('Producto', x + 12, y + 8);
  doc.text('Cantidad', x + 128, y + 8);
  doc.text('Descripción', x + 210, y + 8);

  const fac = header?.cnro ?? '';
  doc.font('Courier').fontSize(11);
  doc.text(`Factura Nro.`, x + w - 190, y + 8, { width: 120, align: 'right' });
  doc.font('Courier-Bold').fontSize(11);
  doc.text(String(fac), x + w - 60, y + 8, { width: 48, align: 'right' });

  return y + h;
}

// Trunca por ancho real (no por cantidad de caracteres) para que en modo 'single'/'clip'
// el texto entre garantizado en una sola línea visual dentro de descWidth. Sin esto,
// una descripción larga puede seguir siendo más ancha que la columna a ese fontSize y
// PDFKit la envuelve en 2 líneas aunque solo reservamos el alto de 1 (rowH = fontSize+2),
// pisando la fila siguiente ("letras sobrepuestas").
function truncateToWidth(doc, text, maxWidth) {
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid).trimEnd() + ellipsis;
    if (doc.widthOfString(candidate) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo).trimEnd() + ellipsis : ellipsis;
}

function fitItemsLayout(doc, items, descWidth, opts) {
  const { topY, bottomY, prodX, qtyX, descX } = opts;
  const available = bottomY - topY;

  // candidate layouts
  const candidates = [
    { font: 'Courier', fontSize: 10.5, lineGap: 1.5, mode: 'wrap' },
    { font: 'Courier', fontSize: 9.5, lineGap: 1.2, mode: 'wrap' },
    { font: 'Courier', fontSize: 8.8, lineGap: 1.0, mode: 'wrap' },
    { font: 'Courier', fontSize: 8.2, lineGap: 0.8, mode: 'wrap' },
    { font: 'Courier', fontSize: 8.0, lineGap: 0.6, mode: 'single' },
    { font: 'Courier', fontSize: 7.5, lineGap: 0.4, mode: 'single' },
  ];

  function measure(layout) {
    doc.font(layout.font).fontSize(layout.fontSize);
    let y = topY;
    for (const it of items) {
      const desc = normalizeText(it.descripcion || it.desc || it.producto || '');
      const d = layout.mode === 'wrap' ? desc : truncateToWidth(doc, desc, descWidth);
      const h = doc.heightOfString(d, { width: descWidth, lineGap: layout.lineGap });
      const rowH = Math.max(h, layout.fontSize + 2);
      y += rowH;
      if (y > bottomY) return { fits: false, total: y - topY };
    }
    return { fits: true, total: y - topY };
  }

  for (const c of candidates) {
    const m = measure(c);
    if (m.fits) return c;
  }

  // If nothing fits, we'll show as many rows as possible in single-line mode.
  return { font: 'Courier', fontSize: 7.2, lineGap: 0.2, mode: 'clip' };
}

function itemsBlock(doc, header, items, yStart) {
  const pageW = doc.page.width;
  const x = 28;
  const w = pageW - 56;

  const prodX = x + 12;
  const qtyX = x + 120;
  const descX = x + 210;
  const descWidth = w - (descX - x) - 12;

  const topY = yStart + 10;

  // Footer (firma) SIEMPRE en la misma hoja. Reservamos un alto realista.
  // IMPORTANTE: si este alto es más chico que lo que dibuja signatureBlock, PDFKit agrega páginas.
  const FOOTER_H = 82; // compactado para que entre en 1 página
  const MARGIN_BOTTOM = 18;
  const footerTopY = doc.page.height - MARGIN_BOTTOM - FOOTER_H;
  const bottomY = footerTopY - 6;

  const layout = fitItemsLayout(doc, items, descWidth, { topY, bottomY, prodX, qtyX, descX });

  doc.fillColor('black');
  doc.font(layout.font).fontSize(layout.fontSize);

  let y = topY;
  let rendered = 0;

  for (const it of items) {
    const prod = normalizeText(it.producto).slice(0, 8);
    const qty = formatQty(it.cantidad);
    const descFull = normalizeText(it.descripcion || it.desc || it.producto || '');

    let desc;
    if (layout.mode === 'wrap') desc = descFull;
    else desc = truncateToWidth(doc, descFull, descWidth);

    const h = layout.mode === 'wrap'
      ? doc.heightOfString(desc, { width: descWidth, lineGap: layout.lineGap })
      : (layout.fontSize + 2);

    const rowH = Math.max(h, layout.fontSize + 2);

    if (y + rowH > bottomY) break;

    doc.text(prod, prodX, y, { width: 90 });
    doc.text(qty, qtyX, y, { width: 70, align: 'right' });
    if (layout.mode === 'wrap') {
      doc.text(desc, descX, y, { width: descWidth, lineGap: layout.lineGap });
    } else {
      // lineBreak:false es el resguardo final: aunque truncateToWidth calcule mal
      // por algún caso límite, PDFKit nunca va a envolver a una 2da línea y pisar
      // la fila siguiente.
      doc.text(desc, descX, y, { width: descWidth, lineGap: layout.lineGap, lineBreak: false });
    }

    y += rowH;
    rendered += 1;
  }

  const remaining = items.length - rendered;
  if (remaining > 0) {
    doc.font('Helvetica').fontSize(9);
    doc.fillColor('black');
    doc.text(`… (${remaining} ítems más no impresos para mantener 1 página)`, prodX, bottomY - 12, {
      width: w - 24,
      align: 'left'
    });
  }

  return footerTopY;
}

function signatureBlock(doc, header, yTop) {
  const pageW = doc.page.width;
  const x = 28;
  const w = pageW - 56;

  // Línea verde (arriba y dentro de la hoja → evita páginas extra)
  green(doc);
  doc.lineWidth(1);
  doc.moveTo(x, yTop).lineTo(x + w, yTop).stroke();

  // Leyenda inferior:
  // - Portones: usar observación de VENTAS (header.ventas_observacion)
  // - Paneles: usar observación del remito (header.observ)
  // - fallback: texto anterior
  const ventasObs = normalizeText(header?.ventas_observacion);
  const remitoObs = normalizeText(header?.observ);
  const nv = header?.numerov ? `NV ${header.numerov}. ` : '';
  const fallbackSubject = `${nv}PORTON DE ${normalizeText(header?.nombre)}.`.trim();
  const subject = ventasObs || remitoObs || fallbackSubject;
  doc.fillColor('black');
  doc.font('Helvetica').fontSize(10.5);
  doc.text(subject, x + 6, yTop + 6, { width: w - 12 });

  // Caja de firma (compacta, MISMA hoja)
  const boxY = yTop + 22;
  const boxH = 46;
  doc.strokeColor('#000000');
  doc.roundedRect(x + 6, boxY, w - 12, boxH, 8).stroke();

  const oper = normalizeText(header?.operador) || '';
  doc.fillColor('black');
  doc.font('Helvetica').fontSize(10.5);
  doc.text(oper, x + 40, boxY + 10, { width: 160, align: 'center' });
  doc.text(formatDateTime(new Date()), x + 18, boxY + 28, { width: 240 });

  // Líneas (Firma al centro, Aclaracion + DNI a la derecha)
  const firmaX = x + w * 0.56;
  const rightX = x + w * 0.82;
  doc.lineWidth(1);
  doc.moveTo(firmaX - 85, boxY + 30).lineTo(firmaX + 85, boxY + 30).stroke();
  doc.font('Helvetica').fontSize(9.5);
  doc.text('Firma', firmaX - 85, boxY + 32, { width: 170, align: 'center' });

  doc.moveTo(rightX - 85, boxY + 14).lineTo(rightX + 85, boxY + 14).stroke();
  doc.text('Aclaracion', rightX - 85, boxY + 16, { width: 170, align: 'center' });

  doc.moveTo(rightX - 85, boxY + 30).lineTo(rightX + 85, boxY + 30).stroke();
  doc.text('DNI', rightX - 85, boxY + 32, { width: 170, align: 'center' });
}

export async function buildRemitoPdf({ header, items }) {
  // Ensure we always produce a single page.
  // A4 (como el remito original). Más alto que LETTER → más margen para ítems.
  const doc = new PDFDocument({ size: 'A4', margin: 0 });

  const chunks = [];
  doc.on('data', (d) => chunks.push(d));

  // 1) Encabezado
  const yAfterHeader = headerBlock(doc, header);

  // 2) Cliente
  const yAfterCustomer = customerBlock(doc, header, yAfterHeader);

  // 3) Cabecera tabla
  const yAfterTableHeader = tableHeaderBlock(doc, header, yAfterCustomer);

  // 4) Items (ajusta tipografía para que entre en 1 página)
  const yFooterTop = itemsBlock(doc, header, items || [], yAfterTableHeader);

  // 5) Firma (compacta) en la MISMA hoja
  signatureBlock(doc, header, yFooterTop);

  return await new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
