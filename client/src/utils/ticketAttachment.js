// src/utils/ticketAttachment.js
// Portado tal cual desde el Presupuestador (cotizador-front/src/utils/ticketAttachment.js)
// para que el adjunto de las Consultas de Logística funcione igual que el de
// vendedor/distribuidor (mismo formato de attachment, mismos límites).
const MAX_TICKET_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_TICKET_VIDEO_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const VIDEO_TICKET_ATTACHMENT_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const ALLOWED_TICKET_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  ...VIDEO_TICKET_ATTACHMENT_TYPES,
]);

function isVideoFile(file) {
  const type = safeText(file?.type).toLowerCase();
  if (type) return VIDEO_TICKET_ATTACHMENT_TYPES.has(type);
  return ['mp4', 'mov', 'webm'].includes(extensionFromName(file?.name));
}

function maxBytesForFile(file) {
  return isVideoFile(file) ? MAX_TICKET_VIDEO_ATTACHMENT_BYTES : MAX_TICKET_ATTACHMENT_BYTES;
}

function formatMb(bytes) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function safeText(value) {
  return String(value ?? '').trim();
}

function extensionFromName(name = '') {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function extensionFromMimeType(type = '') {
  const mime = safeText(type).toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  return '';
}

function normalizeAttachmentName(attachment = {}) {
  const rawName = safeText(attachment?.name || attachment?.filename || attachment?.file_name) || 'adjunto';
  if (extensionFromName(rawName)) return rawName;
  const ext = extensionFromMimeType(attachment?.type || attachment?.mime_type || attachment?.mimetype);
  return ext ? `${rawName}.${ext}` : rawName;
}

function dataUrlToBlob(dataUrl = '', fallbackType = 'application/octet-stream') {
  const raw = safeText(dataUrl);
  if (!raw) return null;
  if (!raw.startsWith('data:')) return null;

  const commaIndex = raw.indexOf(',');
  if (commaIndex < 0) return null;

  const meta = raw.slice(5, commaIndex);
  const body = raw.slice(commaIndex + 1);
  const [mimePart = ''] = meta.split(';');
  const mimeType = safeText(mimePart) || safeText(fallbackType) || 'application/octet-stream';
  const isBase64 = meta.toLowerCase().includes(';base64');

  if (isBase64) {
    const binary = window.atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  return new Blob([decodeURIComponent(body)], { type: mimeType });
}

function buildAttachmentObjectUrl(attachment = {}) {
  const href = safeText(attachment?.data_url || attachment?.dataUrl || attachment?.url || attachment?.href);
  if (!href) return null;

  if (href.startsWith('blob:') || href.startsWith('http://') || href.startsWith('https://')) {
    return { url: href, revoke: false };
  }

  const blob = dataUrlToBlob(href, attachment?.type || attachment?.mime_type || attachment?.mimetype);
  if (!blob) return { url: href, revoke: false };

  return { url: window.URL.createObjectURL(blob), revoke: true };
}

export function isAllowedTicketAttachment(file) {
  if (!file) return false;
  const type = safeText(file.type).toLowerCase();
  const ext = extensionFromName(file.name);
  return ALLOWED_TICKET_ATTACHMENT_TYPES.has(type) || ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm'].includes(ext);
}

export function fileToTicketAttachment(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (!isAllowedTicketAttachment(file)) {
      reject(new Error('El adjunto debe ser una imagen, un PDF o un video.'));
      return;
    }
    const maxBytes = maxBytesForFile(file);
    if (Number(file.size || 0) > maxBytes) {
      reject(new Error(`El archivo excede el tamaño permitido (máximo ${formatMb(maxBytes)}).`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        name: safeText(file.name) || 'adjunto',
        type: safeText(file.type) || 'application/octet-stream',
        size: Number(file.size || 0) || 0,
        data_url: String(reader.result || ''),
        uploaded_at: new Date().toISOString(),
      });
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo adjunto.'));
    reader.readAsDataURL(file);
  });
}

export function isImageTicketAttachment(attachment) {
  const type = safeText(attachment?.type).toLowerCase();
  return type.startsWith('image/');
}

export function isVideoTicketAttachment(attachment) {
  const type = safeText(attachment?.type).toLowerCase();
  return type.startsWith('video/');
}

export function formatTicketAttachmentMeta(attachment) {
  if (!attachment) return '';
  const name = normalizeAttachmentName(attachment);
  const size = Number(attachment.size || 0) || 0;
  if (!size) return name;
  const unit = size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${name} · ${unit}`;
}

export function ticketAttachmentDisplayUrl(attachment) {
  return buildAttachmentObjectUrl(attachment)?.url || '';
}

export function openTicketAttachment(attachment) {
  if (typeof window === 'undefined') return false;
  const target = buildAttachmentObjectUrl(attachment);
  if (!target?.url) return false;

  const opened = window.open(target.url, '_blank', 'noopener,noreferrer');
  if (target.revoke) window.setTimeout(() => window.URL.revokeObjectURL(target.url), 60 * 1000);
  return !!opened;
}

export function downloadTicketAttachment(attachment) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const target = buildAttachmentObjectUrl(attachment);
  if (!target?.url) return false;

  const a = document.createElement('a');
  a.href = target.url;
  a.download = normalizeAttachmentName(attachment);
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (target.revoke) window.setTimeout(() => window.URL.revokeObjectURL(target.url), 1000);
  return true;
}
