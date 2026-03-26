# Lemon OTC Onboarding — Google Sheets + Drive

Formulario de onboarding corporativo. Cada envío genera:
- **Una fila** en un Google Sheet con todos los datos de la empresa.
- **Una subcarpeta** en Google Drive (nombrada `Empresa — YYYY-MM-DD`) con todos los archivos adjuntos.

---

## Arquitectura

```
public/index.html          ← form estático (Vercel CDN)
api/google.js              ← serverless function (Node 18)
  ?action=create           ← escribe fila en Sheets + crea carpeta en Drive
  ?action=upload           ← sube archivo a la carpeta de Drive
```

---

## Setup paso a paso

### 1. Crear Service Account en Google Cloud

1. Ir a https://console.cloud.google.com → APIs & Services → Credentials.
2. Create Credentials → Service Account → dale cualquier nombre (ej. `lemon-otc-sa`).
3. En el listado, click en la SA → pestaña Keys → Add Key → JSON.
4. Guardar el archivo `.json` descargado — lo vas a necesitar en el paso 3.

### 2. Habilitar APIs

En APIs & Services → Enable APIs, habilitar:
- Google Sheets API
- Google Drive API

### 3. Crear el Sheet y la carpeta de Drive

1. Crear un Google Sheet nuevo (puede estar vacío).
   Copiar el ID de la URL: https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit

2. Crear una carpeta en Drive donde van a vivir los adjuntos.
   Copiar el ID de la URL: https://drive.google.com/drive/folders/[FOLDER_ID]

3. En cada uno (Sheet y carpeta), hacer Share e invitar el email de la Service Account
   (algo como lemon-otc-sa@proyecto.iam.gserviceaccount.com) con rol Editor.

### 4. Variables de entorno en Vercel

En el dashboard de Vercel → proyecto → Settings → Environment Variables, agregar:

  GOOGLE_SERVICE_ACCOUNT_JSON   Contenido completo del .json de la SA (todo el JSON como string)
  GOOGLE_SHEET_ID               ID del Sheet del paso 3
  GOOGLE_DRIVE_FOLDER_ID        ID de la carpeta del paso 3

Tip: para pegar el JSON en Vercel, abrí el .json en un editor de texto,
seleccioná todo y pegalo como valor de la variable. Vercel lo acepta con saltos de línea.

### 5. Deploy

  vercel --prod

O hacer push a la rama conectada si ya tenés el deploy automático.

---

## Estructura del Sheet

La primera vez que se recibe un envío, se crean automáticamente los headers:

  A  Timestamp
  B  Corporate name
  C  Business activity
  D  Reporting entity (Law 25246)
  E  Website
  F  Registration date
  G  Registration number
  H  Bylaws amended
  I  Registered address
  J  Business address
  K  Tax ID (CUIT/CDI)
  L  Phone
  M  Email
  N  Bank account
  O  Wallet / network
  P  Board members
  Q  Legal representative
  R  Biometric notes
  S  PEP status
  T  UBO declaration
  U  More than one UBO
  V  Drive folder URL    ← link directo a la carpeta con los adjuntos

---

## Archivos adjuntos

Cada envío crea una subcarpeta dentro de la carpeta raíz:
  Nombre: {Empresa} — {YYYY-MM-DD}

Los 9 documentos solicitados se suben ahí con su nombre original.

---

## Cambios respecto a la versión Monday.com

- api/monday.js reemplazado por api/google.js (podés eliminar el anterior)
- public/index.html: API_BASE apunta a /api/google
- El payload del action=create envía los campos directamente (f1...f20)
  en lugar de boardId/itemName/note
- package.json: se eliminó form-data (ya no necesario)
- Variables de entorno: reemplazar MONDAY_TOKEN por las 3 variables de Google
