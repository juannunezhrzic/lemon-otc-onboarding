const FormData = require('form-data');
const fetch = require('node-fetch');

const MONDAY_API      = 'https://api.monday.com/v2';
const MONDAY_FILE_API = 'https://api.monday.com/v2/file';
const TOKEN           = process.env.MONDAY_TOKEN;

// ── raw body ──────────────────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── multipart parser ──────────────────────────────────────────────
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

// ── Monday GraphQL (using variables — no string interpolation) ────
async function mondayGql(query, variables) {
  const body = variables ? { query, variables } : { query };
  const r = await fetch(MONDAY_API, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': TOKEN,
      'API-Version':   '2024-01',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (data.errors && data.errors.length) throw new Error(data.errors[0].message);
  return data;
}

// ── handler ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!TOKEN) {
    res.status(500).json({ error: 'MONDAY_TOKEN not set in Vercel environment variables.' });
    return;
  }

  const { action } = req.query;

  // ── CREATE item + update ─────────────────────────────────────────
  if (action === 'create') {
    try {
      const raw = await getRawBody(req);
      const { boardId, itemName, note } = JSON.parse(raw.toString());
      if (!boardId || !itemName) throw new Error('Missing boardId or itemName.');

      // 1. Create item using GraphQL variables (safe — no injection risk)
      const createData = await mondayGql(
        `mutation($boardId: ID!, $name: String!) {
           create_item(board_id: $boardId, item_name: $name, create_labels_if_missing: true) { id }
         }`,
        { boardId: String(boardId), name: itemName }
      );
      const itemId = createData.data.create_item.id;

      // 2. Add update/note with all field data (also using variables)
      if (note) {
        await mondayGql(
          `mutation($itemId: ID!, $body: String!) {
             create_update(item_id: $itemId, body: $body) { id }
           }`,
          { itemId: String(itemId), body: note }
        );
      }

      res.status(200).json({ itemId });
    } catch (e) {
      console.error('[create]', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  // ── UPLOAD file ──────────────────────────────────────────────────
  if (action === 'upload') {
    try {
      const ct       = req.headers['content-type'] || '';
      const boundary = getBoundary(ct);
      if (!boundary) throw new Error('No multipart boundary in Content-Type.');

      const raw   = await getRawBody(req);
      const parts = parseMultipart(raw, boundary);

      const { itemId, file } = parts;
      const columnId = parts.columnId || 'files';
      if (!itemId) throw new Error('Missing itemId.');
      if (!file)   throw new Error('Missing file.');

      const form  = new FormData();
      const query = `mutation ($file: File!) {
        add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) { id }
      }`;
      form.append('query', query);
      form.append('variables[file]', file.data, {
        filename:    file.filename,
        contentType: file.contentType,
      });

      const r = await fetch(MONDAY_FILE_API, {
        method:  'POST',
        headers: {
          'Authorization': TOKEN,
          'API-Version':  '2024-01',
          ...form.getHeaders(),
        },
        body: form,
      });
      const data = await r.json();
      if (data.errors && data.errors.length) throw new Error(data.errors[0].message);
      res.status(200).json({ success: true });
    } catch (e) {
      console.error('[upload]', e.message);
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(400).json({ error: `Unknown action "${action}". Valid: create, upload.` });
};

module.exports.config = { api: { bodyParser: false } };
