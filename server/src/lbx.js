import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, 'assets');
const TEMPLATE_DIR = path.join(ASSETS_DIR, 'portones_lbx_template');
const IPANEL_LOGO_BMP_PATH = path.join(ASSETS_DIR, 'ipanel_logo.bmp');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0 ^ -1;
  for (const b of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(0, 8); // store, no compression
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}


function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function upper(v) {
  return clean(v).toUpperCase();
}

function removeDigitsFromText(value) {
  const stripped = clean(value)
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || 'NO';
}

function nvDisplayText(label) {
  const raw = clean(label?.nv || label?.orderCode || label?.topCode || '');
  const match = raw.match(/\d+/);
  if (match) return `NV ${match[0]}`;
  if (!raw) return 'NV';
  return raw.replace(/^N[°º]?\s*/i, 'NV ').replace(/^NV\s*/i, 'NV ');
}

function dash(v) {
  const s = clean(v);
  return s ? `-${s}` : '-NO';
}

function escapeXml(v) {
  // No usar clean() aca: clean() colapsa saltos de linea y en P-touch
  // eso convierte campos multilinea en un string largo.
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


function textCharLen(value) {
  return Array.from(String(value ?? '')).length;
}

function resetStringItems(fragment, plainText) {
  const firstFontInfo = fragment.match(/<text:ptFontInfo>[\s\S]*?<\/text:ptFontInfo>/)?.[0] || '';
  if (!firstFontInfo) return fragment;
  const item = `<text:stringItem charLen="${textCharLen(plainText)}">${firstFontInfo}</text:stringItem>`;
  return fragment.replace(/(<pt:data>[\s\S]*?<\/pt:data>)(?:<text:stringItem[\s\S]*?<\/text:stringItem>)+/, `$1${item}`);
}

function setTextAlign(fragment, horizontal = 'LEFT', vertical = null) {
  let out = fragment.replace(/horizontalAlignment="[^"]+"/, `horizontalAlignment="${horizontal}"`);
  if (vertical) out = out.replace(/verticalAlignment="[^"]+"/, `verticalAlignment="${vertical}"`);
  return out;
}

function fmtDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return clean(v);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtDateDash(v) {
  const s = clean(v);
  if (!s || s.toLowerCase() === 'null' || s.toUpperCase() === 'NO') return 'NO';

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;

  const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    return `${dd}-${mm}-${dmy[3]}`;
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}


function wrapWords(value, maxChars = 12, maxLines = 2) {
  const source = clean(value);
  if (!source) return '';

  const words = source.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines.join('\n');

  const head = lines.slice(0, maxLines - 1);
  const tail = lines.slice(maxLines - 1).join(' ');
  return [...head, tail].join('\n');
}

function makeTextResponsive(xml) {
  return xml
    .replace(/shrink="false"/g, 'shrink="true"')
    .replace(/autoLF="false"/g, 'autoLF="true"');
}

function setAttr(fragment, attrName, value) {
  const re = new RegExp(` ${attrName}="[^"]*"`);
  if (re.test(fragment)) return fragment.replace(re, ` ${attrName}="${value}"`);
  return fragment.replace(/^(<[^>]+)/, `$1 ${attrName}="${value}"`);
}

function setTextBox(fragment, opts = {}) {
  let out = fragment;
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined && value !== null) out = setAttr(out, key, value);
  }
  return out;
}

function wrapValue(value, maxChars = 22, maxLines = 2) {
  const lines = wrapWords(value, maxChars, maxLines).split('\n').filter(Boolean);
  return lines.length ? lines : ['NO'];
}

function pairLines(prefix, value, maxChars = 30, maxLines = 2) {
  const safePrefix = clean(prefix);
  const val = clean(value) || '-NO';
  const firstMax = Math.max(8, maxChars - safePrefix.length - 1);
  const continuationMax = Math.max(8, maxChars - 2);
  const parts = wrapWords(val, firstMax, maxLines).split('\n').filter(Boolean);
  if (!parts.length) return [`${safePrefix} -NO`];
  return parts.map((part, idx) => (idx === 0 ? `${safePrefix} ${part}` : `  ${wrapWords(part, continuationMax, 1)}`));
}

function replaceDataInTextObject(xml, oldValue, newValue, transform = null) {
  const oldTag = `<pt:data>${oldValue}</pt:data>`;
  const pattern = /<text:text>[\s\S]*?<\/text:text>/g;
  let found = false;

  const out = xml.replace(pattern, (fragment) => {
    if (found || !fragment.includes(oldTag)) return fragment;
    found = true;
    let next = fragment.replace(oldTag, `<pt:data>${escapeXml(newValue)}</pt:data>`);
    if (typeof transform === 'function') next = transform(next);
    next = resetStringItems(next, newValue);
    return next;
  });

  if (!found) {
    console.warn('No se encontro texto LBX para reemplazar:', oldValue.slice(0, 80));
  }

  return out;
}

function setTextObjectFontSize(fragment, sizePt, orgPointPt = null) {
  let out = fragment.replace(/size="[0-9.]+pt"/g, `size="${sizePt}pt"`);
  if (orgPointPt !== null) {
    out = out.replace(/orgPoint="[0-9.]+pt"/g, `orgPoint="${orgPointPt}pt"`);
  }
  return out;
}

function extractMeasurementNumbers(value) {
  const source = clean(value)
    .replace(/^MED(?:IDAS)?\s*:\s*/i, '')
    .replace(/\s*mm\s*$/i, '');
  return source.match(/-?\d+(?:[.,]\d+)?/g) || [];
}

function normalizeDimensionTokenToMm(token) {
  const raw = clean(token).replace(/\s*mm\s*$/i, '').replace(',', '.');
  if (!raw) return '';
  const n = Number(raw);
  if (!Number.isFinite(n)) return clean(token).replace(/\s*mm\s*$/i, '');
  const mm = Math.abs(n) < 100 ? n * 1000 : n;
  return String(Math.round(mm));
}

function measurementPartsMm(label) {
  const source = clean(label?.medidas || label?.medidaFinal || '');
  const nums = extractMeasurementNumbers(source);

  if (nums.length >= 2) {
    const ancho = normalizeDimensionTokenToMm(nums[0]);
    const alto = normalizeDimensionTokenToMm(nums[1]);
    if (ancho && alto) return { ancho, alto };
  }

  return { ancho: '', alto: '' };
}

function medidasMmText(label) {
  const { ancho, alto } = measurementPartsMm(label);
  if (ancho && alto) return `${ancho} X ${alto} MM`;

  const source = clean(label?.medidas || label?.medidaFinal || '');
  if (!source || source.toUpperCase() === 'NO') return 'NO';

  const nums = extractMeasurementNumbers(source);
  if (nums.length === 1) {
    const only = normalizeDimensionTokenToMm(nums[0]);
    if (only) return `${only} MM`;
  }

  return source.replace(/\s*mm\s*$/i, '').toUpperCase();
}

function medidasMmVerticalText(label) {
  const { ancho, alto } = measurementPartsMm(label);
  if (ancho && alto) return `${ancho}\nX\n${alto}`;

  const text = medidasMmText(label);
  return text === 'NO' ? 'NO' : text.replace(/\s+MM$/i, '');
}

function medidasMmTwoLineText(label) {
  const { ancho, alto } = measurementPartsMm(label);
  if (ancho && alto) return `MEDIDAS:\n${ancho}X${alto}`;

  const source = clean(label?.medidas || label?.medidaFinal || '');
  if (!source || source.toUpperCase() === 'NO') return 'MEDIDAS:\nNO';

  const nums = extractMeasurementNumbers(source);
  if (nums.length === 1) {
    const only = normalizeDimensionTokenToMm(nums[0]);
    if (only) return `MEDIDAS:\n${only}`;
  }

  return `MEDIDAS:\n${source.replace(/\s*mm\s*$/i, '').toUpperCase()}`;
}

function replaceData(xml, oldValue, newValue) {
  const oldTag = `<pt:data>${oldValue}</pt:data>`;
  const newTag = `<pt:data>${escapeXml(newValue)}</pt:data>`;
  if (!xml.includes(oldTag)) {
    console.warn('No se encontro texto LBX para reemplazar:', oldValue.slice(0, 80));
    return xml;
  }
  return xml.replace(oldTag, newTag);
}

function replaceDataRaw(xml, oldValue, newValue, plainValue = null) {
  const oldTag = `<pt:data>${oldValue}</pt:data>`;
  const newTag = `<pt:data>${newValue}</pt:data>`;
  if (!xml.includes(oldTag)) {
    console.warn('No se encontro texto LBX para reemplazar:', oldValue.slice(0, 80));
    return xml;
  }

  const pattern = /<text:text>[\s\S]*?<\/text:text>/g;
  let done = false;
  return xml.replace(pattern, (fragment) => {
    if (done || !fragment.includes(oldTag)) return fragment;
    done = true;
    const next = fragment.replace(oldTag, newTag);
    return resetStringItems(next, plainValue ?? newValue);
  });
}


function setMainLogoToIpanel(xml) {
  return xml
    .replace(/fileName="Object1\.emf"/g, 'fileName="ObjectIpanel.bmp"')
    .replace(/originalName=""/g, 'originalName="ipanel_logo.bmp"');
}

function mainOnlyLabelXml(xml, height = 475.5) {
  const objects = extractObjectFragments(xml).filter(isMainLabelObject);
  const bgHeight = Math.max(1, Math.round((height - 16.9) * 10) / 10);
  const bottomCut = `${height}pt`;

  let out = xml;
  out = out.replace(/<style:paper([^>]*?)height="[^"]+"([^>]*?)>/, (_m, before, after) => `<style:paper${before}height="${height}pt"${after}>`);
  // La QL usa cinta continua con cutter: agregamos el corte al final de la etiqueta grande.
  out = out.replace(/<style:cutLine[^>]*\/>/, `<style:cutLine regularCut="0pt" freeCut="${bottomCut}"/>`);
  out = out.replace(/<style:backGround([^>]*?)height="[^"]+"([^>]*?)\/>/, (_m, before, after) => `<style:backGround${before}height="${bgHeight}pt"${after}/>`);
  out = out.replace(/<pt:objects>[\s\S]*?<\/pt:objects>/, `<pt:objects>${objects.join('')}</pt:objects>`);
  return out;
}

function ipanelLabelToXml(label) {
  let xml = fs.readFileSync(path.join(TEMPLATE_DIR, 'label.xml'), 'utf8').replace(/\r\n/g, '\n');
  xml = setMainLogoToIpanel(xml);

  const product = wrapWords(upper(label.producto || label.revestimiento || 'NO'), 24, 5);
  const productBlock = `PRODUCTO:\n${product}`;

  const detailLines = [
    ...pairLines('CLIENTE:', dash(upper(label.cliente || 'NO')), 34, 2),
    ...pairLines('DIRECCION:', dash(upper(label.direccion || 'NO')), 34, 2),
    ...pairLines('LOCALIDAD:', dash(upper(label.localidad || label.direccion2 || 'NO')), 34, 2),
    `FECHA: ${dash(fmtDateDash(label.fechaVenta || label.fecha || new Date()))}`,
  ].join('\n');

  const observaciones = wrapWords(upper(label.observacionItem || label.observaciones || 'NO'), 20, 4);

  xml = replaceDataInTextObject(xml, 'N°3463/3309 ', nvDisplayText(label), (fragment) =>
    setTextBox(fragment, { size: '31pt', orgPoint: '31pt', shrink: 'true', autoLF: 'true' })
  );

  xml = replaceDataInTextObject(xml, 'COLOR PIERNAS:\nREVESTIMIENTO:\nLISTON:\nPUERTA:\nLUCERA:\nACCIONAMIENTO:', productBlock, (fragment) =>
    setTextAlign(setTextBox(fragment, {
      x: '8pt',
      y: '154pt',
      width: '160pt',
      height: '96pt',
      size: '8.2pt',
      orgPoint: '8.2pt',
      shrink: 'true',
      autoLF: 'true',
    }), 'LEFT', 'CENTER')
  );
  xml = replaceDataInTextObject(xml, '-NEG MICRO\n-NEG MICRO\n-NO\n-NO\n-NO\n-AUT DERECHA', ' ', (fragment) =>
    setTextBox(fragment, { width: '1pt', height: '1pt', size: '1pt', orgPoint: '1pt' })
  );

  xml = replaceDataInTextObject(xml, 'INSTALACIÓN', 'IPANELS', (fragment) =>
    setTextBox(fragment, { size: '24pt', orgPoint: '24pt', shrink: 'true', autoLF: 'true' })
  );

  xml = replaceDataInTextObject(xml, 'DIRECCION:\nLOCALIDAD:\nCLIENTE:\nREFERENCIA:\nFECHA:', detailLines, (fragment) =>
    setTextAlign(setTextBox(fragment, {
      x: '8pt',
      y: '298pt',
      width: '160pt',
      height: '78pt',
      size: '6.9pt',
      orgPoint: '6.9pt',
      shrink: 'true',
      autoLF: 'true',
    }), 'LEFT', 'CENTER')
  );
  xml = replaceDataInTextObject(xml, '-\n-VILLA MARIA\n-POMILLO JOSE 2\n-\n-23/04/2026', ' ', (fragment) =>
    setTextBox(fragment, { width: '1pt', height: '1pt', size: '1pt', orgPoint: '1pt' })
  );

  xml = replaceDataInTextObject(xml, 'COMERCIALIZA', 'OBSERVACIONES', (fragment) =>
    setTextBox(fragment, { x: '8pt', width: '120pt', size: '8.5pt', orgPoint: '8.5pt' })
  );

  xml = replaceDataInTextObject(xml, 'BARENGO', observaciones, (fragment) => {
    const lines = observaciones.split('\n').length;
    const maxLen = Math.max(...observaciones.split('\n').map((line) => line.length));
    const size = lines > 2 ? (maxLen > 18 ? 8.5 : 9.5) : (maxLen > 20 ? 10 : 12);
    return setTextAlign(setTextBox(fragment, { x: '10pt', width: '155pt', height: '46pt', size: `${size}pt`, orgPoint: `${size}pt`, shrink: 'true', autoLF: 'true' }), 'LEFT', 'CENTER');
  });

  xml = replaceDataInTextObject(xml, 'MEDIDAS: 2980X2380', ' ', (fragment) =>
    setTextBox(fragment, { width: '1pt', height: '1pt', size: '1pt', orgPoint: '1pt' })
  );

  xml = replaceDataRaw(xml, '267', ' ');
  xml = makeTextResponsive(xml);
  return mainOnlyLabelXml(xml);
}

function portonesLabelToXml(label) {
  let xml = fs.readFileSync(path.join(TEMPLATE_DIR, 'label.xml'), 'utf8').replace(/\r\n/g, '\n');

  const specs = [
    `COLOR PIERNAS: ${dash(upper(label.colorPiernas || 'NO'))}`,
    `REVESTIMIENTO: ${dash(upper(label.revestimiento || 'NO'))}`,
    `LISTON: ${dash(upper(label.liston || 'NO'))}`,
    `PUERTA: ${dash(upper(label.puerta || 'NO'))}`,
    `LUCERA: ${dash(upper(label.lucera || 'NO'))}`,
    `ACCIONAMIENTO: ${dash(upper(label.accionamiento || 'NO'))}`,
  ].join('\n');

  const detailLines = [
    `FECHA DE VENTA: ${dash(fmtDateDash(label.fechaVenta || 'NO'))}`,
    ...pairLines('DIRECCION:', dash(upper(label.direccion || 'NO')), 34, 2),
    ...pairLines('LOCALIDAD:', dash(upper(label.direccion2 || 'NO')), 34, 2),
    ...pairLines('CLIENTE:', dash(upper(label.cliente || 'NO')), 34, 2),
    `FECHA: ${dash(fmtDate(label.fecha || new Date()))}`,
  ].join('\n');

  const medidas = medidasMmTwoLineText(label);
  const comercializa = wrapWords(upper(removeDigitsFromText(label.comercializa || 'NO')), 12, 3);

  xml = replaceDataInTextObject(xml, 'N°3463/3309 ', nvDisplayText(label), (fragment) =>
    setTextBox(fragment, { size: '31pt', orgPoint: '31pt', shrink: 'true', autoLF: 'true' })
  );

  // La plantilla original tiene las etiquetas de especificaciones y los valores en dos objetos.
  // Para evitar que P-touch junte todos los valores en una sola linea cuando algo es largo,
  // usamos un unico objeto de ancho completo, con un renglon por dato.
  xml = replaceDataInTextObject(xml, 'COLOR PIERNAS:\nREVESTIMIENTO:\nLISTON:\nPUERTA:\nLUCERA:\nACCIONAMIENTO:', specs, (fragment) =>
    setTextAlign(setTextBox(fragment, { x: '7pt', y: '172pt', width: '160pt', height: '78pt', size: '7.2pt', orgPoint: '7.2pt', shrink: 'true', autoLF: 'true' }), 'LEFT', 'CENTER')
  );
  xml = replaceDataInTextObject(xml, '-NEG MICRO\n-NEG MICRO\n-NO\n-NO\n-NO\n-AUT DERECHA', ' ', (fragment) =>
    setTextBox(fragment, { width: '1pt', height: '1pt', size: '1pt', orgPoint: '1pt' })
  );

  const tarea = wrapWords(upper(label.tarea || 'NO'), 13, 2);
  xml = replaceDataInTextObject(xml, 'INSTALACIÓN', tarea, (fragment) => {
    const lines = tarea.split('\n').length;
    const maxLen = Math.max(...tarea.split('\n').map((line) => line.length));
    const size = lines > 1 ? (maxLen > 12 ? 14 : 16) : (maxLen > 12 ? 18 : 20);
    return setTextBox(fragment, { size: `${size}pt`, orgPoint: `${size}pt`, shrink: 'true', autoLF: 'true' });
  });

  // Igual que las especificaciones: datos de direccion/cliente/fecha en un solo objeto ancho.
  // Si un valor no entra, se parte por palabras y sigue abajo.
  xml = replaceDataInTextObject(xml, 'DIRECCION:\nLOCALIDAD:\nCLIENTE:\nREFERENCIA:\nFECHA:', detailLines, (fragment) =>
    setTextAlign(setTextBox(fragment, { x: '8pt', y: '291pt', width: '160pt', height: '82pt', size: '6.4pt', orgPoint: '6.4pt', shrink: 'true', autoLF: 'true' }), 'LEFT', 'CENTER')
  );
  xml = replaceDataInTextObject(xml, '-\n-VILLA MARIA\n-POMILLO JOSE 2\n-\n-23/04/2026', ' ', (fragment) =>
    setTextBox(fragment, { width: '1pt', height: '1pt', size: '1pt', orgPoint: '1pt' })
  );

  xml = replaceDataInTextObject(xml, 'BARENGO', comercializa, (fragment) => {
    const lines = comercializa.split('\n').length;
    const maxLen = Math.max(...comercializa.split('\n').map((line) => line.length));
    const size = lines > 1 ? (maxLen > 14 ? 11 : 13) : (maxLen > 15 ? 14 : 17);
    return setTextAlign(setTextBox(fragment, { x: '16pt', width: '143pt', height: '43pt', size: `${size}pt`, orgPoint: `${size}pt`, shrink: 'true', autoLF: 'true' }), 'CENTER', 'CENTER');
  });

  xml = replaceDataInTextObject(xml, 'MEDIDAS: 2980X2380', medidas, (fragment) =>
    setTextAlign(
      setTextBox(fragment, {
        x: '8pt',
        y: '425pt',
        width: '160pt',
        height: '34pt',
        size: '9.2pt',
        orgPoint: '9.2pt',
        shrink: 'true',
        autoLF: 'true',
      }),
      'CENTER',
      'CENTER'
    )
  );

  // Texto auxiliar superior de la plantilla original. Lo dejamos vacio para no interferir con el logo.
  xml = replaceDataRaw(xml, '267', ' ');
  xml = makeTextResponsive(xml);

  return xml;
}


export async function buildIpanelLabelLbx(label) {
  const normalized = { ...(label || {}), brand: 'ipanel' };
  const labelXml = ipanelLabelToXml(normalized);

  return buildZip([
    { name: 'label.xml', data: Buffer.from(labelXml, 'utf8') },
    { name: 'prop.xml', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'prop.xml')) },
    { name: 'ObjectIpanel.bmp', data: fs.readFileSync(IPANEL_LOGO_BMP_PATH) },
  ]);
}


export async function buildPortonesLabelLbx(label) {
  const normalized = { ...(label || {}), brand: 'portones' };
  const labelXml = portonesLabelToXml(normalized);

  return buildZip([
    { name: 'label.xml', data: Buffer.from(labelXml, 'utf8') },
    { name: 'prop.xml', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'prop.xml')) },
    { name: 'Object0.bmp', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'Object0.bmp')) },
    { name: 'Object1.emf', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'Object1.emf')) },
  ]);
}


function extractFirstObject(xml, tagName, containsText) {
  const pattern = new RegExp(`<${tagName}[\\s\\S]*?</${tagName}>`, 'g');
  const matches = xml.match(pattern) || [];
  return matches.find((fragment) => fragment.includes(containsText)) || '';
}

function shiftPt(value, delta) {
  const n = Number(String(value).replace('pt', ''));
  if (!Number.isFinite(n)) return value;
  const shifted = Math.round((n + delta) * 10) / 10;
  return `${shifted}pt`;
}

function shiftObjectFragment(fragment, yDelta, suffix) {
  let out = fragment;
  out = out.replace(/objectName="([^"]+)"/, (_m, name) => `objectName="${name}_${suffix}"`);
  out = out.replace(/ y="([0-9.]+pt)"/g, (_m, y) => ` y="${shiftPt(y, yDelta)}"`);
  return out;
}

function escapeXmlPreserveWhitespace(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


function prepareSmallTextFragment(fragment) {
  // La etiqueta chica solo lleva N° y REF.
  // Usamos mas alto/ancho y autoLF para que nombres largos bajen de renglon
  // en lugar de cortarse.
  let out = makeTextResponsive(fragment)
    .replace(/height="39\.8pt"/g, 'height="44pt"')
    .replace(/width="101\.8pt"/g, 'width="132pt"')
    .replace(/x="39\.2pt"/g, 'x="34pt"')
    .replace(/size="24pt"/g, 'size="9pt"')
    .replace(/size="11\.7pt"/g, 'size="9pt"')
    .replace(/orgPoint="40pt"/g, 'orgPoint="9pt"')
    .replace(/orgPoint="28\.8pt"/g, 'orgPoint="9pt"');
  out = setTextAlign(setTextBox(out, { width: '132pt', height: '44pt', size: '9pt', orgPoint: '9pt', shrink: 'true', autoLF: 'true' }), 'CENTER', 'CENTER');
  return out;
}

function smallRefText(label) {
  const nvRaw = clean(label?.nv || label?.orderCode || label?.topCode || '');
  const nvMatch = nvRaw.match(/\d+/);
  const nv = nvMatch ? nvMatch[0] : nvRaw;
  const ref = clean(label?.cliente) || 'NO';
  // Misma fuente que usa la etiqueta grande para "LOCALIDAD:" (direccion2, con
  // localidad como respaldo), para que grande y chica muestren lo mismo.
  const localidad = clean(label?.direccion2 || label?.localidad) || 'NO';
  const distribuidor = clean(label?.comercializa) || 'NO';

  // La chica no lleva medidas. N°, REF (Nombre), DIST (Distribuidor) y LOC (Localidad).
  // Si el nombre es largo, se parte por espacios en hasta 2 renglones; distribuidor y
  // localidad quedan en un solo renglón (el cuadro tiene poco alto disponible) y el
  // auto-shrink de P-touch (ya activado en prepareSmallTextFragment) achica la letra
  // si no entra, igual que ya hace hoy con nombres largos.
  const refLines = wrapWords(upper(ref), 14, 2).split('\n').filter(Boolean);
  if (refLines.length) {
    refLines[0] = `REF: ${refLines[0]}`;
  } else {
    refLines.push('REF: NO');
  }

  const distLine = wrapWords(upper(distribuidor), 16, 1).split('\n').filter(Boolean)[0] || 'NO';
  const locLine = wrapWords(upper(localidad), 16, 1).split('\n').filter(Boolean)[0] || 'NO';

  return [`NV ${nv}`, ...refLines, `DIST: ${distLine}`, `LOC: ${locLine}`].join('\n');
}

function buildSmallPortonesLabelXml(label, copies = 4) {
  let xml = fs.readFileSync(path.join(TEMPLATE_DIR, 'label.xml'), 'utf8').replace(/\r\n/g, '\n');
  const smallText = extractFirstObject(xml, 'text:text', 'N°4165');
  const smallLogo = extractFirstObject(xml, 'image:image', 'Imagen19');

  if (!smallText || !smallLogo) {
    throw new Error('No se encontro la plantilla de etiqueta chica dentro del LBX.');
  }

  const count = Math.max(1, Math.min(20, Number(copies) || 4));
  const originalStartY = 475.5;
  const segmentHeight = 59.2;
  const objects = [];
  const textValue = smallRefText(label);

  for (let i = 0; i < count; i += 1) {
    const delta = -originalStartY + (segmentHeight * i);
    const suffix = `small${i + 1}`;
    const logo = shiftObjectFragment(smallLogo, delta, suffix);
    const textObj = replaceDataRaw(
      prepareSmallTextFragment(shiftObjectFragment(smallText, delta, suffix)),
      'N°4165 \nREF: CORREDIZO ',
      escapeXmlPreserveWhitespace(textValue),
      textValue
    );
    objects.push(logo, textObj);
  }

  const totalHeight = Math.round(segmentHeight * count * 10) / 10;
  const bgHeight = Math.max(1, Math.round((totalHeight - 16.9) * 10) / 10);
  const cutLines = Array.from({ length: Math.max(0, count - 1) }, (_, i) => `${Math.round(segmentHeight * (i + 1) * 10) / 10}pt`).join(' ');

  xml = xml.replace(/<style:paper([^>]*?)height="[^"]+"([^>]*?)>/, (m, before, after) => `<style:paper${before}height="${totalHeight}pt"${after}>`);
  xml = xml.replace(/<style:cutLine[^>]*\/>/, `<style:cutLine regularCut="0pt" freeCut="${cutLines}"/>`);
  xml = xml.replace(/<style:backGround([^>]*?)height="[^"]+"([^>]*?)\/>/, (m, before, after) => `<style:backGround${before}height="${bgHeight}pt"${after}/>`);
  xml = xml.replace(/<pt:objects>[\s\S]*?<\/pt:objects>/, `<pt:objects>${objects.join('')}</pt:objects>`);

  return xml;
}


function extractObjectFragments(xml) {
  const pattern = /<(?:text:text|image:image)[\s\S]*?<\/(?:text:text|image:image)>/g;
  return xml.match(pattern) || [];
}

function ptToNumber(value) {
  const n = Number(String(value || '').replace('pt', ''));
  return Number.isFinite(n) ? n : 0;
}

function objectNumber(fragment, attrName) {
  const re = new RegExp(` ${attrName}="([^"]+)"`);
  const m = fragment.match(re);
  return m ? ptToNumber(m[1]) : 0;
}

function isMainLabelObject(fragment) {
  const y = objectNumber(fragment, 'y');
  const x = objectNumber(fragment, 'x');
  // Conserva solo los objetos visibles de la etiqueta grande.
  // Descarta la etiqueta chica original y textos viejos que estaban despues del primer corte.
  return y < 475.5 && x < 176;
}

function buildCompletePortonesLabelXml(label, smallCopies = 4) {
  const mainXml = portonesLabelToXml(label);
  const templateXml = fs.readFileSync(path.join(TEMPLATE_DIR, 'label.xml'), 'utf8').replace(/\r\n/g, '\n');

  const mainObjects = extractObjectFragments(mainXml).filter(isMainLabelObject);
  const smallText = extractFirstObject(templateXml, 'text:text', 'N°4165');
  const smallLogo = extractFirstObject(templateXml, 'image:image', 'Imagen19');

  if (!smallText || !smallLogo) {
    throw new Error('No se encontro la plantilla de etiqueta chica dentro del LBX.');
  }

  const count = Math.max(1, Math.min(20, Number(smallCopies) || 4));
  const mainHeight = 475.5;
  const smallSegmentHeight = 59.2;
  const smallObjects = [];
  const textValue = smallRefText(label);

  for (let i = 0; i < count; i += 1) {
    const delta = smallSegmentHeight * i;
    const suffix = `completeSmall${i + 1}`;
    const logo = shiftObjectFragment(smallLogo, delta, suffix);
    const textObj = replaceDataRaw(
      prepareSmallTextFragment(shiftObjectFragment(smallText, delta, suffix)),
      'N°4165 \nREF: CORREDIZO ',
      escapeXmlPreserveWhitespace(textValue),
      textValue
    );
    smallObjects.push(logo, textObj);
  }

  const totalHeight = Math.round((mainHeight + (smallSegmentHeight * count)) * 10) / 10;
  const bgHeight = Math.max(1, Math.round((totalHeight - 16.9) * 10) / 10);
  const cutLineValues = [mainHeight];
  for (let i = 1; i < count; i += 1) {
    cutLineValues.push(Math.round((mainHeight + (smallSegmentHeight * i)) * 10) / 10);
  }
  const cutLines = cutLineValues.map((v) => `${v}pt`).join(' ');

  let xml = mainXml;
  xml = xml.replace(/<style:paper([^>]*?)height="[^"]+"([^>]*?)>/, (_m, before, after) => `<style:paper${before}height="${totalHeight}pt"${after}>`);
  xml = xml.replace(/<style:cutLine[^>]*\/>/, `<style:cutLine regularCut="0pt" freeCut="${cutLines}"/>`);
  xml = xml.replace(/<style:backGround([^>]*?)height="[^"]+"([^>]*?)\/>/, (_m, before, after) => `<style:backGround${before}height="${bgHeight}pt"${after}/>`);
  xml = xml.replace(/<pt:objects>[\s\S]*?<\/pt:objects>/, `<pt:objects>${mainObjects.join('')}${smallObjects.join('')}</pt:objects>`);

  return xml;
}

export async function buildSmallPortonesLabelLbx(label, copies = 4) {
  const normalized = { ...(label || {}), brand: 'portones' };
  const labelXml = buildSmallPortonesLabelXml(normalized, copies);

  return buildZip([
    { name: 'label.xml', data: Buffer.from(labelXml, 'utf8') },
    { name: 'prop.xml', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'prop.xml')) },
    { name: 'Object0.bmp', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'Object0.bmp')) },
    { name: 'Object1.emf', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'Object1.emf')) },
  ]);
}


export async function buildCompletePortonesLabelLbx(label, smallCopies = 4) {
  const normalized = { ...(label || {}), brand: 'portones' };
  const labelXml = buildCompletePortonesLabelXml(normalized, smallCopies);

  return buildZip([
    { name: 'label.xml', data: Buffer.from(labelXml, 'utf8') },
    { name: 'prop.xml', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'prop.xml')) },
    { name: 'Object0.bmp', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'Object0.bmp')) },
    { name: 'Object1.emf', data: fs.readFileSync(path.join(TEMPLATE_DIR, 'Object1.emf')) },
  ]);
}
