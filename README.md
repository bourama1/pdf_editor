# PDF Studio Editor

A standalone PDF annotation server with a browser-based editor. Upload a PDF, annotate it with pen / highlighter / text tools in the browser, then save — either downloaded directly or forwarded to your app via `returnUrl`.

Built with React + pdfjs-dist + pdf-lib (frontend) and Express + Socket.io (backend).

## Quick Start

```powershell
cd backend
npm run dev            # backend (port 3000)
cd frontend && npm run dev   # frontend dev server (port 5173, proxies API to :3000)
```

## Build Standalone .exe

```powershell
cd backend
npm run build:frontend   # build frontend → public/
npm run build            # compile TypeScript → dist/
npm run package          # create pdf-editor.exe
```

Copy `pdf-editor.exe` to any Windows machine (frontend is embedded).

## API Endpoints

### POST /upload — Submit a PDF for editing

```
POST http://server:3000/upload
Content-Type: multipart/form-data

file:      <pdf-file>        (required)
returnUrl: <url>             (optional – defaults to request Origin header)
```

Response:

```json
{ "id": "uuid", "editUrl": "http://server:3000/?session=uuid" }
```

Redirect the user to `editUrl` to open the editor.

---

### POST /edit-from-docmgr — Download PDF from a URL, create session, save result to a network share

```
POST http://server:3000/edit-from-docmgr
Content-Type: application/json

{
  "docmgrUrl":   "http://doc-manager/files/123.pdf",
  "filename":    "invoice.pdf",
  "saveDir":     "\\\\nas\\shared\\pdfs",
  "saveFilename":"invoice_annotated.pdf"
}
```

Downloads the PDF from `docmgrUrl`, creates a session. When the user saves, the modified PDF is also copied to `saveDir/saveFilename`.

Response: `{ "id": "uuid", "editUrl": "http://server:3000/?session=uuid" }`

---

### GET /sessions/:id/info — Session metadata

```json
{ "fileName": "invoice.pdf", "returnUrl": "http://my-app/callback" }
```

### GET /sessions/:id/pdf — Download original PDF

Returns the uploaded PDF file.

### POST /sessions/:id/save — Save edited PDF

```
POST http://server:3000/sessions/{id}/save
Content-Type: multipart/form-data

file: <modified-pdf>   (required)
```

- If `returnUrl` was provided at upload: forwards the PDF as `POST application/pdf` to that URL. Also returns the PDF to the caller.
- If `savePath` was set (via `/edit-from-docmgr`): copies the edited PDF to the network share.
- If no `returnUrl`: returns the PDF directly.

---

### GET /queue — List document queue

Returns an in-memory array of documents with revisions.

### POST /queue/upload — Add file to document queue

Same shape as `/upload`. Emits a `queue-new-item` socket event.

### POST /files/:id/revise — Add a revision to a queued document

```
POST http://server:3000/files/{id}/revise
Content-Type: multipart/form-data

file:        <pdf>          (required)
annotations: <json string>  (optional, stored as revision metadata)
```

Emits a `queue-item-updated` socket event.

---

## Frontend (Browser Editor)

The editor is a React SPA. You can open it in several ways:

| URL              | Behaviour                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `/?session=UUID` | Loads PDF from an existing session (created via `/upload`). Shows **Save & Return** button. |
| `/?pdfUrl=URL`   | Fetches a PDF from a remote URL. Shows **Export PDF** button.                               |
| Open directly    | Empty state — use the **Open PDF** button to load a local file.                             |

**Tools:** Pen (freehand), Highlighter, Text box (place, resize, edit). Undo/redo, zoom, clear all.

**Save flow:** The frontend rebuilds the PDF server-side by re-rendering annotations onto the original PDF using `pdf-lib`, then POSTs to `/sessions/:id/save`.

**Integration with host app:** If the editor was opened via `window.open`, it posts `{ type: "SAVED" }` to the opener before closing. React Native WebView is also supported via `window.ReactNativeWebView.postMessage`.

## Socket.io Events

| Event                | Direction       | Payload        |
| -------------------- | --------------- | -------------- |
| `queue-new-item`     | Server → Client | `DocumentItem` |
| `queue-item-updated` | Server → Client | `DocumentItem` |

## Environment Variables

| Variable       | Default   | Description                                   |
| -------------- | --------- | --------------------------------------------- |
| `PORT`         | `3000`    | Server port                                   |
| `HOST`         | `0.0.0.0` | Bind address (`127.0.0.1` for local-only)     |
| `FRONTEND_URL` | auto      | Override the editor URL returned by `/upload` |

## Testing

Open `test-upload.html` — pick a PDF, optionally set a return URL, and upload. You'll be redirected to the editor.

## Python (Flask) Integration Example

```python
import os
import requests
import uuid
from flask import Flask, request, redirect, send_file

app = Flask(__name__)
EDITOR_URL = "http://tocz-app4:3000"
SAVE_DIR = "edited_pdfs"
os.makedirs(SAVE_DIR, exist_ok=True)

@app.route("/send-document", methods=["GET"])
def send_document():
    pdf_path = "invoice.pdf"
    with open(pdf_path, "rb") as f:
        resp = requests.post(
            f"{EDITOR_URL}/upload",
            files={"file": ("invoice.pdf", f, "application/pdf")},
            data={"returnUrl": request.host_url.rstrip("/") + "/receive-edited"},
        )
    if not resp.ok:
        return f"Upload failed: {resp.text}", 500
    data = resp.json()
    return redirect(data["editUrl"])

@app.route("/receive-edited", methods=["POST"])
def receive_edited():
    filename = f"edited_{uuid.uuid4().hex[:8]}.pdf"
    filepath = os.path.join(SAVE_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(request.get_data())
    print(f"Saved edited PDF to {filepath}")
    return "OK", 200

@app.route("/edit/<session_id>", methods=["GET"])
def edit_existing(session_id):
    return redirect(f"{EDITOR_URL}/?session={session_id}")

@app.route("/download/<filename>", methods=["GET"])
def download(filename):
    filepath = os.path.join(SAVE_DIR, filename)
    return send_file(filepath, mimetype="application/pdf")

if __name__ == "__main__":
    app.run(port=5000)
```

**Flow:**

1. User visits `/send-document` — Flask POSTs the PDF to `/upload` with a `returnUrl`
2. Flask redirects the user to the editor URL
3. User annotates in the browser, clicks **Save & Return**
4. Editor forwards the modified PDF to `/receive-edited`
5. Flask stores it in `edited_pdfs/`
