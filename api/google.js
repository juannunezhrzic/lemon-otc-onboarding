/**
 * api/google.js
 * Vercel Serverless Function — reemplaza api/monday.js
 *
 * Acciones:
 *   POST /api/google?action=create  — agrega una fila en Google Sheets
 *   POST /api/google?action=upload  — sube un archivo a Google Drive
 *
 * Variables de entorno requeridas en Vercel:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   JSON completo de la service account key
 *   GOOGLE_SHEET_ID               ID del Google Sheet (de la URL)
 *   GOOGLE_DRIVE_FOLDER_ID        ID de la carpeta destino en Drive
 */

const fetch = require('node-fetch');

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Genera un JWT firmado con RS256 y lo intercambia por un access token de OAuth2.
 * No usa ninguna SDK externa — solo crypto nativo de Node.
 */
async function getAccessToken(scopes) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no está definida.');

  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);

  // Construir JWT
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${header}.${payload}.${signature}`;

  // Intercambiar JWT por access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('No se pudo obtener access_token: ' + JSON.stringify(data));
  return data.access_token;
}

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Raw body + multipart parser (igual que monday.js) ────────────────────────

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

// ── Sheets helpers ────────────────────────────────────────────────────────────

const SHEETS_HEADERS = [
  'Timestamp',
  'Corporate name',
  'Business activity',
  'Reporting entity (Law 25246)',
  'Website',
  'Registration date',
  'Registration number',
  'Bylaws amended',
  'Registered address',
  'Business address',
  'Tax ID (CUIT/CDI)',
  'Phone',
  'Email',
  'Bank account',
  'Wallet / network',
  'Board members',
  'Legal representative',
  'Biometric notes',
  'PEP status',
  'UBO declaration',
  'More than one UBO',
  'Drive folder URL',   // se llenará en el action=upload del primer archivo
];

/**
 * Asegura que la primera fila del sheet tenga los headers.
 * Si ya existen, no hace nada.
 */
async function ensureHeaders(token, sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:V1`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.values && data.values[0] && data.values[0][0] === 'Timestamp') return; // ya existe

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:V1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [SHEETS_HEADERS] }),
    }
  );
}

async function appendRow(token, sheetId, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);

  // Devolver el número de fila recién insertada
  const updatedRange = data.updates?.updatedRange || '';
  const match = updatedRange.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

/**
 * Crea una subcarpeta con el nombre de la empresa dentro de la carpeta raíz.
 * Devuelve { folderId, folderUrl }
 */
async function createCompanyFolder(token, parentFolderId, companyName) {
  const safe = companyName.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 100);
  const name  = `${safe} — ${new Date().toISOString().slice(0, 10)}`;

  const resp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return {
    folderId:  data.id,
    folderUrl: `https://drive.google.com/drive/folders/${data.id}`,
  };
}

/**
 * Sube un archivo a la carpeta de Drive especificada.
 * Usa multipart upload (metadata + binario en una sola request).
 */
async function uploadToDrive(token, folderId, filename, contentType, data) {
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const boundary = '-------lemon_boundary_' + Date.now();

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
    ),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    }
  );
  const result = await resp.json();
  if (result.error) throw new Error(result.error.message);
  return result.id;
}

/**
 * Actualiza la celda "Drive folder URL" (columna V = índice 21) de una fila dada.
 */
async function updateFolderUrl(token, sheetId, rowNumber, folderUrl) {
  const range = `V${rowNumber}`;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[folderUrl]] }),
    }
  );
}

// ── Handler principal ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
  const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!SHEET_ID || !FOLDER_ID) {
    res.status(500).json({ error: 'Faltan env vars: GOOGLE_SHEET_ID o GOOGLE_DRIVE_FOLDER_ID.' });
    return;
  }

  const { action } = req.query;

  // ── CREATE: agrega fila en Sheets + crea carpeta en Drive ────────────────
  if (action === 'create') {
    try {
      const raw  = await getRawBody(req);
      const body = JSON.parse(raw.toString());

      // Campos enviados por el frontend (igual que antes, pero en JSON plano)
      const {
        f1='', f2='', f3='', f4='', f5='', f6='', f7='',
        f8='', f9='', f10='', f11='', f12='',
        f13='', f14='', f15='', f16='', f17='',
        f18='', f19='', f20='',
      } = body;

      const token = await getAccessToken([
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ]);

      // 1. Asegurar headers en el sheet
      await ensureHeaders(token, SHEET_ID);

      // 2. Crear carpeta de Drive para esta empresa
      const { folderId, folderUrl } = await createCompanyFolder(token, FOLDER_ID, f1 || 'Sin nombre');

      // 3. Construir la fila
      const row = [
        new Date().toISOString(),
        f1, f2, f3, f4, f5, f6, f7, f8, f9,
        f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20,
        folderUrl,
      ];

      // 4. Agregar fila al sheet
      const rowNumber = await appendRow(token, SHEET_ID, row);

      res.status(200).json({ itemId: `${folderId}::${rowNumber}` });
    } catch (e) {
      console.error('[create]', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── UPLOAD: sube archivo a la carpeta Drive de la empresa ────────────────
  if (action === 'upload') {
    try {
      const ct       = req.headers['content-type'] || '';
      const boundary = getBoundary(ct);
      if (!boundary) throw new Error('No multipart boundary in Content-Type.');

      const raw   = await getRawBody(req);
      const parts = parseMultipart(raw, boundary);

      // itemId ahora es "folderId::rowNumber"
      const { itemId, file } = parts;
      if (!itemId) throw new Error('Missing itemId.');
      if (!file)   throw new Error('Missing file.');

      const [folderId] = itemId.split('::');

      const token = await getAccessToken([
        'https://www.googleapis.com/auth/drive',
      ]);

      await uploadToDrive(token, folderId, file.filename, file.contentType, file.data);

      res.status(200).json({ success: true });
    } catch (e) {
      console.error('[upload]', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(400).json({ error: `Acción desconocida "${action}". Válidas: create, upload.` });
};

module.exports.config = { api: { bodyParser: false } };
