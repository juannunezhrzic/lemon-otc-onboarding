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

/**
 * Apps Script devuelve un redirect 302 en POSTs.
 * node-fetch lo sigue cambiando el método a GET, lo que rompe doPost().
 * Esta función sigue el redirect manualmente como POST.
 */
async function postToAppsScript(url, bodyObj) {
  // POST to /exec — Apps Script processes doPost() and returns a 302
  // whose Location contains the encoded response. Follow it with GET.
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(bodyObj),
    redirect: 'manual',
  });
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('location');
    if (location) return fetch(location, { method: 'GET', redirect: 'follow' });
  }
  return resp;
}

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

      // Todo lo que carga el cliente va como texto al Sheet: lo que empieza con + = - @
      // Sheets lo toma como fórmula (el teléfono llegaba como #ERROR!) y lo que empieza con
      // un número lo convierte en número (un CBU que empieza con 0 perdía el cero y se
      // redondeaba). El apóstrofo lo guarda tal cual. Se hace acá y no en el Apps Script
      // para que estos arreglos se publiquen con un merge, sin tocar el script.
      const comoTexto = v => (typeof v === 'string' && /^[=+\-@0-9]/.test(v)) ? "'" + v : v;
      const campos = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, /^f\d+$/.test(k) ? comoTexto(v) : v]));
      const resp = await postToAppsScript(APPS_SCRIPT_URL, { action: 'create', ...campos });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch (_) {
        console.error('[create] non-JSON response:', text.slice(0, 600));
        throw new Error('Apps Script returned non-JSON. Check Vercel logs for details.');
      }
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

      const { itemId, refId, fieldId, file } = parts;
      if (!itemId) throw new Error('Missing itemId.');
      if (!file)   throw new Error('Missing file.');

      // refId_campo_nombre: así se sabe a qué campo del formulario corresponde cada archivo
      const campo    = /^u\d+$/.test(fieldId || '') ? `${fieldId}_` : '';
      const filename = refId ? `${refId}_${campo}${file.filename}` : `${campo}${file.filename}`;

      const resp = await postToAppsScript(APPS_SCRIPT_URL, {
        action:      'upload',
        itemId,
        filename,
        contentType: file.contentType,
        fileBase64:  file.data.toString('base64'),
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
