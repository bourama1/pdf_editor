import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";

const app = express();
const server = http.createServer(app);

// Enable Cross-Origin Resource Sharing for both mobile and web frontends
app.use(cors());
app.use(express.json());

// Socket.io initialization matching client configuration rules
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

// Configure local disc storage for tracking incoming files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, "uploads");
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});
const upload = multer({ storage });

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
app.use("/files", express.static(path.join(__dirname, "uploads")));

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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`PDF Engine service node operational inside interface framework runtime on port ${PORT}`);
});
