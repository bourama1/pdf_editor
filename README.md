# pdf-editor

A React PDF annotation/editor component (draw, highlight, text boxes, download).
Two ways to consume it:

1. **As an npm package**, installed straight from this GitHub repo — import `PdfEditor` into any React app.
2. **As a single self-contained HTML file** — for consumers that just embed a static page/iframe (e.g. WebView apps).

Both builds are independent; changing one doesn't affect the other.

## 1. Use as a library

Install directly from GitHub (no npm registry publish needed):

```bash
npm install github:bourama1/pdf_editor
```

`react` and `react-dom` (^18.3) are peer dependencies — install them in the
consuming app if not already present. Everything else (`pdf-lib`,
`pdfjs-dist`, `lucide-react`) installs automatically.

```tsx
import { PdfEditor } from "pdf-editor";

function App() {
    return <PdfEditor />;
}
```

The component takes no props today — it's a fully self-contained editor
(file picker, canvas, toolbar included). The bundle is a single ESM file
(~1.6 MB gzipped) with the PDF.js worker and a Unicode font (DejaVu Sans)
inlined, so there's no separate asset to configure or serve.

## Features

- **Pen and highlighter** with color and thickness. Hold **Shift** while drawing
  for a straight line; on touch devices use the **Přímka** toggle in the options bar.
- **Eraser** — drag across a stroke to remove it.
- **Text boxes** — click with the Text tool and type right away. The box widens
  as you type and wraps at the page's right edge. Move it with the bar above it,
  resize it with the handles, delete it with ×, finish with Esc or a click outside.
  Color and size can be changed at any time while the box is selected. Empty
  boxes are discarded when you finish.
- **Unicode text** (e.g. Czech diacritics) is embedded in the saved PDF; the
  on-screen text box uses the same font, so line breaks match the export.
- **Undo / redo** steps through all edits in the order they were made.

### Updating the published library build

The importable build (`frontend/dist-lib/`) is **committed to git**, not
built on install — a git dependency's `prepare` script isn't reliably run by
npm, so relying on it silently breaks the install. This means:

Whenever you change anything under `frontend/src/`, rebuild and commit the
result before pushing:

```bash
npm run build:lib   # from the repo root — rebuilds frontend/dist-lib
git add frontend/dist-lib
git commit -m "..."
```

Or use the **"build: frontend (lib)"** task in `.vscode/tasks.json`.

## 2. Use as a single HTML file

This is the original distribution path, unchanged:

- **"build: frontend"** task (or `npm run build` in `frontend/`) → produces
  `backend/public/index.html`, a single file with everything inlined.
- **"deploy: to consumers"** task copies that file into the sibling
  `paperless` and `orderdesk` projects.
- **"full build (frontend + tsc + exe)"** additionally packages the backend
  into a standalone `.exe` (via `pkg`), for the server-based standalone use case.

## Local development

- **"dev: frontend"** / **"dev: backend"** tasks run the dev servers
  (`vite` on :5173, proxying `/upload`, `/sessions`, `/files`, `/queue` to
  the backend on :3000).
