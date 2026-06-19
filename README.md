# PDF Editor

A standalone PDF editor that integrates with external apps. Receive a PDF via POST, let users edit it in the browser, then get the modified PDF back.

## Quick Start

```powershell
cd backend
npm run dev            # dev mode (ts-node, port 3000)
cd frontend && npm run dev   # frontend dev server (port 5173)
```

## Build Standalone .exe

```powershell
cd backend
npm run build:frontend   # build frontend → public/
npm run build            # compile TypeScript → dist/
npm run package          # create pdf-editor.exe
```

Copy `pdf-editor.exe` + `public/` folder to any Windows machine and run.

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
{
  "id": "uuid",
  "editUrl": "http://server:3000/?session=uuid"
}
```

Redirect the user to `editUrl` to open the editor.

**Examples:**

```powershell
# With explicit return URL
curl -X POST http://tocz-app4:3000/upload ^
  -F "file=@invoice.pdf" ^
  -F "returnUrl=http://my-app/callback"

# Return URL comes from Origin header
curl -X POST http://tocz-app4:3000/upload ^
  -F "file=@invoice.pdf" ^
  -H "Origin: http://my-app"
```

### GET /sessions/:id/info — Get session metadata

```
GET http://server:3000/sessions/{id}/info
```

Response:
```json
{
  "fileName": "invoice.pdf",
  "returnUrl": "http://my-app/callback"
}
```

### GET /sessions/:id/pdf — Download the original PDF

```
GET http://server:3000/sessions/{id}/pdf
```

Returns the original PDF file.

### POST /sessions/:id/save — Save and return edited PDF

```
POST http://server:3000/sessions/{id}/save
Content-Type: multipart/form-data

file: <modified-pdf>   (required)
```

**When a `returnUrl` was provided at upload:**
The server forwards the modified PDF to that URL as `POST` with `Content-Type: application/pdf`.
The response is the PDF itself (downloadable).

**When no `returnUrl` exists:**
The server returns the modified PDF directly in the response for download.

## Python (Flask) Integration Example

A complete Flask app that sends a PDF to the editor and receives the edited version back.

```python
import os
import requests
import uuid
from flask import Flask, request, redirect, send_file

app = Flask(__name__)
EDITOR_URL = "http://tocz-app4:3000"  # your PDF Editor server

# Temporary storage for incoming edited PDFs
SAVE_DIR = "edited_pdfs"
os.makedirs(SAVE_DIR, exist_ok=True)


@app.route("/send-document", methods=["GET"])
def send_document():
    """Example: generate or load a PDF, send to editor, redirect user."""
    pdf_path = "invoice.pdf"  # your PDF file

    with open(pdf_path, "rb") as f:
        resp = requests.post(
            f"{EDITOR_URL}/upload",
            files={"file": ("invoice.pdf", f, "application/pdf")},
            data={"returnUrl": request.host_url.rstrip("/") + "/receive-edited"},
        )

    if not resp.ok:
        return f"Upload failed: {resp.text}", 500

    data = resp.json()
    # Redirect the user to the editor
    return redirect(data["editUrl"])


@app.route("/receive-edited", methods=["POST"])
def receive_edited():
    """Callback: receives the edited PDF back from the editor."""
    # The PDF comes as raw body with Content-Type: application/pdf
    filename = f"edited_{uuid.uuid4().hex[:8]}.pdf"
    filepath = os.path.join(SAVE_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(request.get_data())

    print(f"Saved edited PDF to {filepath}")
    return "OK", 200


@app.route("/edit/<session_id>", methods=["GET"])
def edit_existing(session_id):
    """Alternative: directly open an existing session in the editor."""
    return redirect(f"{EDITOR_URL}/?session={session_id}")


@app.route("/download/<filename>", methods=["GET"])
def download(filename):
    """Download a received edited PDF."""
    filepath = os.path.join(SAVE_DIR, filename)
    return send_file(filepath, mimetype="application/pdf")


if __name__ == "__main__":
    app.run(port=5000)
```

**How it works:**

1. User visits `/send-document` on your Flask app
2. Flask POSTs the PDF to the editor's `/upload` with a `returnUrl`
3. Flask redirects the user to the editor URL
4. User edits the PDF in the browser
5. User clicks **Save & Return**
6. Editor saves — forwards the modified PDF to your `/receive-edited` endpoint
7. Flask stores the file in `edited_pdfs/`
8. User is redirected back to your app

## Integration Flow

```
┌──────────────┐         POST /upload          ┌──────────────┐
│  Your App    │ ──── file + returnUrl ──────→  │  PDF Editor  │
│  (origin)    │                                 │  (server)    │
└──────┬───────┘                                 └──────┬───────┘
       │                                                │
       │ ← { id, editUrl }                              │
       │                                                │
       │  redirect user to editUrl                       │
       │ ──────────────────────────────────────────────→ │
       │                                                │
       │                                    User edits PDF in browser
       │                                                │
       │  POST /sessions/{id}/save                       │
       │ ←────── modified PDF (Content-Type: pdf) ───── │
       │                                                │
       │  (or server forwards PDF to returnUrl)          │
```

## Environment Variables

| Variable       | Default   | Description                                   |
| -------------- | --------- | --------------------------------------------- |
| `PORT`         | `3000`    | Server port                                   |
| `HOST`         | `0.0.0.0` | Bind address (`127.0.0.1` for local-only)     |
| `FRONTEND_URL` | auto      | Override the editor URL returned by `/upload` |

## Testing

Open `test-upload.html` in the project root — pick a PDF, optionally set a return URL, and upload. You'll be redirected to the editor. After editing, click **Save & Return** to download the modified PDF (or have it forwarded to your return URL).
