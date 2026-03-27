/**
 * api/google.js
 * Vercel Serverless Function — proxy hacia Google Apps Script
 *
 * Acciones:
 *   POST /api/google?action=create  — reenvía los datos del formulario al Apps Script
 *   POST /api/google?action=upload  — convierte el archivo a base64 y lo reenvía al Apps Script
 *
 * Variable de entorno requerida en Vercel:
 *   APPS_SCRIPT_URL   URL de la implementación web del Apps Script
 */

const fetch = require('node-fetch');

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getBoundary(ct) {
  const m = ct.match(/boundary=([^\s;]+)/);
  return m ? m[1].replace(/^"|"$/g, '') : null;
}

function parseMultipart(buffer, boundary) {
  const parts = {};
  const sep   = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buffer.length) {
    const idx = buffer.indexOf(sep, pos);
    if (idx === -1) break;
    pos = idx + sep.length;
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = buffer.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;
    const next       = buffer.indexOf(sep, pos);
    const contentEnd = next === -1 ? buffer.length : next - 2;
    const content    = buffer.slice(pos, contentEnd);
    pos = next === -1 ? buffer.length : next;
    const nameM     = headers.match(/name="([^"]+)"/);
    const fileNameM = headers.match(/filename="([^"]+)"/);
    const ctM       = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    if (!nameM) continue;
    const name = nameM[1];
    if (fileNameM) {
      parts[name] = {
        filename:    fileNameM[1],
        contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
        data:        content,
      };
    } else {
      parts[name] = content.toString();
    }
  }
  return parts;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  if (!APPS_SCRIPT_URL) {
    res.status(500).json({ error: 'APPS_SCRIPT_URL no está definida en las variables de entorno.' });
    return;
  }

  const { action } = req.query;

  // ── CREATE: reenvía el JSON directamente al Apps Script ──────────────────
  if (action === 'create') {
    try {
      const raw  = await getRawBody(req);
      const body = JSON.parse(raw.toString());

      const resp = await fetch(APPS_SCRIPT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'create', ...body }),
        redirect: 'follow',
      });
      const data = await resp.json();
      res.status(data.error ? 500 : 200).json(data);
    } catch (e) {
      console.error('[create]', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── UPLOAD: convierte el archivo a base64 y reenvía al Apps Script ───────
  if (action === 'upload') {
    try {
      const ct       = req.headers['content-type'] || '';
      const boundary = getBoundary(ct);
      if (!boundary) throw new Error('No multipart boundary in Content-Type.');

      const raw   = await getRawBody(req);
      const parts = parseMultipart(raw, boundary);

      const { itemId, refId, file } = parts;
      if (!itemId) throw new Error('Missing itemId.');
      if (!file)   throw new Error('Missing file.');

      const filename = refId ? `${refId}_${file.filename}` : file.filename;

      const resp = await fetch(APPS_SCRIPT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action:      'upload',
          itemId,
          filename,
          contentType: file.contentType,
          fileBase64:  file.data.toString('base64'),
        }),
        redirect: 'follow',
      });
      const data = await resp.json();
      res.status(data.error ? 500 : 200).json(data);
    } catch (e) {
      console.error('[upload]', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(400).json({ error: `Acción desconocida "${action}". Válidas: create, upload.` });
};

module.exports.config = { api: { bodyParser: false } };
