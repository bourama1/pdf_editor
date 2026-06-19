import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);

// Enable CORS – allow all origins including null (file://) for testing
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Request logger – visible in the console when running the exe
app.use((req, _res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

// Resolve public/ directory (check for index.html inside to work with pkg virtual FS)
const publicCandidates = [
    path.join(__dirname, "public"),
    path.join(__dirname, "..", "public"),
    path.join(process.cwd(), "public"),
    path.join(path.dirname(process.execPath), "public"),
];
console.log("public/ candidates:");
publicCandidates.forEach((d) => console.log(`  ${d}/index.html  → ${fs.existsSync(path.join(d, "index.html"))}`));
const publicDir = publicCandidates.find((dir) => fs.existsSync(path.join(dir, "index.html")));
if (publicDir) {
    console.log(`Serving frontend from: ${publicDir}`);
    app.use(express.static(publicDir));
} else {
    console.log("No public/ found – frontend not served. Build frontend first: cd frontend && npx vite build");
}

// Socket.io initialization matching client configuration rules
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

// Helper: resolve paths for both dev (ts-node) and production (pkg / node)
const DATA_DIR = process.cwd();

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Session management ──────────────────────────────────────────────

interface Session {
    id: string;
    fileName: string;
    originalPath: string;
    returnUrl: string;
    createdAt: Date;
}

const sessions = new Map<string, Session>();

// Multer storage – write uploads to the real filesystem (works with both dev and pkg)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(DATA_DIR, "uploads");
        ensureDir(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});
const upload = multer({ storage });

// POST /upload – receive PDF from external service, return edit URL
app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No PDF file provided" });
    }

    const origin = req.headers.origin;
    const returnUrl = req.body.returnUrl || (origin && origin !== "null" ? origin : "");

    console.log(`Session returnUrl: ${returnUrl}`);

    const id = crypto.randomUUID();
    sessions.set(id, {
        id,
        fileName: req.file.originalname,
        originalPath: req.file.path,
        returnUrl,
        createdAt: new Date(),
    });

    const editUrl =
        process.env.FRONTEND_URL ?
            `${process.env.FRONTEND_URL.replace(/\/+$/, "")}/?session=${id}`
        :   `${req.protocol}://${req.get("host")}/?session=${id}`;
    res.json({ id, editUrl });
});

// GET /sessions/:id/info – get session metadata (fileName, returnUrl)
app.get("/sessions/:id/info", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json({ fileName: session.fileName, returnUrl: session.returnUrl });
});

// GET /sessions/:id/pdf – serve the original PDF
app.get("/sessions/:id/pdf", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.sendFile(session.originalPath);
});

// POST /sessions/:id/save – receive modified PDF, forward to returnUrl or return directly
app.post("/sessions/:id/save", upload.single("file"), async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!req.file) {
        return res.status(400).json({ error: "No PDF file provided" });
    }

    // Try to forward to returnUrl if one exists
    let forwarded = false;
    if (session.returnUrl && session.returnUrl !== "null") {
        console.log(`[save] Forwarding ${req.file.filename} to ${session.returnUrl}`);
        try {
            const pdfBuffer = fs.readFileSync(req.file.path);
            const response = await fetch(session.returnUrl, {
                method: "POST",
                body: pdfBuffer,
                headers: { "Content-Type": "application/pdf" },
            });
            console.log(`[save] Origin responded ${response.status}`);
            forwarded = response.ok;
        } catch (err: any) {
            console.log(`[save] Forward error: ${err.message}`);
        }
    } else {
        console.log(`[save] No returnUrl – returning PDF directly`);
    }

    // Always return the PDF to the caller (frontend downloads it)
    res.set("X-Forward-Status", forwarded ? "ok" : "none");
    res.contentType("application/pdf");
    res.attachment(`edited_${session.fileName}`);
    res.sendFile(req.file.path);
});

// Expose internal document database architecture arrays
interface Revision {
    id: number;
    document_id: number;
    filename: string;
    version: number;
    annotations?: string;
    created_at: string;
}

interface DocumentItem {
    id: number;
    name: string;
    created_at: string;
    updated_at: string;
    revisions: Revision[];
}

// In-memory array cache mimicking a persistent database context instance
let documentQueue: DocumentItem[] = [];

// Static folder delivery access configuration for download operations
app.use("/files", express.static(path.join(DATA_DIR, "uploads")));

// GET Endpoint matching your mobile app's data requirement
app.get("/queue", (req, res) => {
    res.json(documentQueue);
});

// POST Endpoint accepting initial file updates or creation tasks
app.post("/queue/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No PDF file attached to the current request payload context" });
    }

    const docId = documentQueue.length + 1;
    const newDoc: DocumentItem = {
        id: docId,
        name: req.file.originalname,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        revisions: [
            {
                id: 1,
                document_id: docId,
                filename: req.file.filename,
                version: 1,
                created_at: new Date().toISOString(),
            },
        ],
    };

    documentQueue.unshift(newDoc);

    // Inform live socket tracking handlers of queue state mutations
    io.emit("queue-new-item", newDoc);
    res.status(201).json(newDoc);
});

// POST revision handler executing file data updates across active target workflows
app.post("/files/:id/revise", upload.single("file"), (req, res) => {
    const docId = parseInt(req.params.id, 10);
    const targetDoc = documentQueue.find((d) => d.id === docId);

    if (!targetDoc) {
        return res.status(404).json({ error: "The requested tracking document entry identifier is absent" });
    }

    if (!req.file) {
        return res.status(400).json({ error: "Missing binary payload attachment data execution" });
    }

    const nextVersionNum = targetDoc.revisions.length + 1;
    const newRevision: Revision = {
        id: Date.now(),
        document_id: docId,
        filename: req.file.filename,
        version: nextVersionNum,
        annotations: req.body.annotations || "[]",
        created_at: new Date().toISOString(),
    };

    targetDoc.revisions.unshift(newRevision);
    targetDoc.updated_at = new Date().toISOString();

    // Transmit modern update frame payloads down live connection pipes
    io.emit("queue-item-updated", targetDoc);
    res.status(200).json(newRevision);
});

io.on("connection", (socket) => {
    console.log(`Connection established dynamically for socket client context: ${socket.id}`);
});

// SPA fallback – serve index.html for any unhandled route
if (publicDir) {
    app.get("*", (req, res) => {
        res.sendFile(path.join(publicDir, "index.html"));
    });
}

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0"; // set to "127.0.0.1" for local-only
server.listen(PORT, HOST, () => {
    console.log(`PDF Engine running on http://${HOST}:${PORT}`);
});
