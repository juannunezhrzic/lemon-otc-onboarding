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
  if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() !== 'Timestamp') {
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

  sheet.appendRow(row);
  const rowNumber = sheet.getLastRow();

  return jsonResponse({ itemId: folder.getId() + '::' + rowNumber });
}

// ── UPLOAD: sube un archivo a la carpeta de Drive ─────────────────────────────
function handleUpload(body) {
  const { itemId, filename, contentType, fileBase64 } = body;
  if (!itemId)     throw new Error('Missing itemId');
  if (!fileBase64) throw new Error('Missing fileBase64');

  const folderId = itemId.split('::')[0];
  const folder   = DriveApp.getFolderById(folderId);

  const bytes = Utilities.base64Decode(fileBase64);
  const blob  = Utilities.newBlob(bytes, contentType || 'application/octet-stream', filename || 'archivo');
  folder.createFile(blob);

  return jsonResponse({ success: true });
}

// ── Helper ────────────────────────────────────────────────────────────────────
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
