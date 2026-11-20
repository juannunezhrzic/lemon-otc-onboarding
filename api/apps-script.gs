/**
 * Google Apps Script — Lemon OTC Onboarding
 *
 * Instrucciones de deploy:
 *   1. Ir a https://script.google.com y crear un nuevo proyecto
 *   2. Pegar este código (reemplazar TODO el contenido del archivo Code.gs)
 *   3. Cambiar SHEET_ID y FOLDER_ID con los valores reales
 *   4. Hacer clic en "Implementar" → "Nueva implementación"
 *      - Tipo: Aplicación web
 *      - Ejecutar como: Yo (tu cuenta de Google)
 *      - Quién tiene acceso: Cualquier persona
 *   5. Copiar la URL de la implementación
 *   6. Pegar esa URL en la variable de entorno APPS_SCRIPT_URL en Vercel
 */

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const SHEET_ID  = 'TU_SHEET_ID_AQUI';   // ID del Google Sheet (de la URL)
const FOLDER_ID = 'TU_FOLDER_ID_AQUI';  // ID de la carpeta raíz en Google Drive
const MAX_BYTES = 4 * 1024 * 1024;       // mismo límite que el formulario
// ─────────────────────────────────────────────────────────────────────────────

const HEADERS = [
  'Reference ID',
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
  'Drive folder URL',
];

function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action;

    if (action === 'create') return handleCreate(body);
    if (action === 'upload') return handleUpload(body);

    return jsonResponse({ error: 'Acción desconocida: ' + action }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ── CREATE: agrega fila en Sheets + crea carpeta en Drive ─────────────────────
function handleCreate(body) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();

  // Asegurar headers en la primera fila
  // La fila 1 empieza con 'Reference ID' (HEADERS[0]); antes se comparaba con 'Timestamp'
  // y se insertaba otra fila de títulos en cada envío.
  if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() !== HEADERS[0]) {
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }

  // Crear carpeta de la empresa dentro de la carpeta raíz
  const parentFolder = DriveApp.getFolderById(FOLDER_ID);
  const safe         = (body.f1 || 'Sin nombre').replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 100);
  const folderName   = safe + ' — ' + new Date().toISOString().slice(0, 10);
  const folder       = parentFolder.createFolder(folderName);
  const folderUrl    = 'https://drive.google.com/drive/folders/' + folder.getId();

  // Construir fila
  const row = [
    body.refId || '',
    new Date().toISOString(),
    body.f1  || '', body.f2  || '', body.f3  || '', body.f4  || '',
    body.f5  || '', body.f6  || '', body.f7  || '', body.f8  || '',
    body.f9  || '', body.f10 || '', body.f11 || '', body.f12 || '',
    body.f13 || '', body.f14 || '', body.f15 || '', body.f16 || '',
    body.f17 || '', body.f18 || '', body.f19 || '', body.f20 || '',
    folderUrl,
  ];

  // Todo lo que carga el cliente va como texto: lo que empieza con + = - @ Sheets lo toma
  // como fórmula (el teléfono "+54 11..." llegaba como #ERROR!) y lo que empieza con un
  // número lo convierte en número (un CBU de 22 dígitos que empieza con 0 perdía el cero
  // y se redondeaba). El apóstrofo lo guarda tal cual y evita inyectar fórmulas.
  sheet.appendRow(row.map(v => (typeof v === 'string' && /^[=+\-@0-9]/.test(v)) ? "'" + v : v));
  const rowNumber = sheet.getLastRow();

  // Notificación por mail
  const refId = body.refId || rowNumber;
  MailApp.sendEmail({
    to:       'otc@lemon.me,compliance@lemon.me,juan.nunez@lemon.me',
    subject:  'Solicitud de alta cliente OTC iniciada - ID: ' + refId,
    body:     'Se cargó una solicitud de alta de cliente OTC: ' + (body.f1 || 'Sin nombre') + '.\nValidar documentación: ' + folderUrl,
    htmlBody: 'Se cargó una solicitud de alta de cliente OTC: ' + (body.f1 || 'Sin nombre') + '.<br>Validar <a href="' + folderUrl + '">documentación</a>.',
  });

  return jsonResponse({ itemId: folder.getId() + '::' + rowNumber });
}

// ── UPLOAD: sube un archivo a la carpeta de Drive ─────────────────────────────
function handleUpload(body) {
  const { itemId, filename, contentType, fileBase64 } = body;
  if (!itemId)     throw new Error('Missing itemId');
  if (!fileBase64) throw new Error('Missing fileBase64');

  const folderId = itemId.split('::')[0];
  const folder   = DriveApp.getFolderById(folderId);

  // Sólo se puede subir a carpetas de empresa creadas por handleCreate (hijas de
  // FOLDER_ID). Sin este control, quien llame al endpoint podría escribir en
  // cualquier carpeta de Drive a la que tenga acceso la cuenta dueña del script.
  if (!esHijaDeRaiz_(folder)) throw new Error('Carpeta no permitida');
  if (bytesDeBase64_(fileBase64) > MAX_BYTES) throw new Error('Archivo demasiado grande');

  const bytes = Utilities.base64Decode(fileBase64);
  const blob  = Utilities.newBlob(bytes, contentType || 'application/octet-stream', filename || 'archivo');
  folder.createFile(blob);

  return jsonResponse({ success: true });
}

function esHijaDeRaiz_(folder) {
  const parents = folder.getParents();
  while (parents.hasNext()) if (parents.next().getId() === FOLDER_ID) return true;
  return false;
}

function bytesDeBase64_(b64) {
  return Math.floor(b64.length * 3 / 4);
}

// ── Helper ────────────────────────────────────────────────────────────────────
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
