import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import {
    Hand,
    PenLine,
    Highlighter,
    Undo2,
    Redo2,
    Trash2,
    Download,
    UploadCloud,
    FileText,
    ZoomIn,
    ZoomOut,
    Type,
} from "lucide-react";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// ─── types ────────────────────────────────────────────────────────────────────

interface AnnotationPayload {
    page: number;
    width: number;
    height: number;
    d: string;
    color: string;
    strokeWidth: number;
    opacity: number;
}

interface TextBox {
    id: string;
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    fontSize: number;
    color: string;
    pageWidth: number;
    pageHeight: number;
}

interface Point {
    x: number;
    y: number;
}

type ToolType = "pen" | "highlighter" | "text" | null;
type PageSizing = { mode: "fit"; targetWidth: number } | { mode: "scale"; scale: number };
type HandlePos = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface DragState {
    kind: "move" | "resize";
    id: string;
    handle?: HandlePos;
    startMouseX: number;
    startMouseY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
}

// ─── constants ────────────────────────────────────────────────────────────────

const HS = 9; // handle size px
const MIN_W = 60;
const MIN_H = 30;

const HANDLE_DEFS: { pos: HandlePos; xRatio: number; yRatio: number; cursor: string }[] = [
    { pos: "nw", xRatio: 0, yRatio: 0, cursor: "nw-resize" },
    { pos: "n", xRatio: 0.5, yRatio: 0, cursor: "n-resize" },
    { pos: "ne", xRatio: 1, yRatio: 0, cursor: "ne-resize" },
    { pos: "e", xRatio: 1, yRatio: 0.5, cursor: "e-resize" },
    { pos: "se", xRatio: 1, yRatio: 1, cursor: "se-resize" },
    { pos: "s", xRatio: 0.5, yRatio: 1, cursor: "s-resize" },
    { pos: "sw", xRatio: 0, yRatio: 1, cursor: "sw-resize" },
    { pos: "w", xRatio: 0, yRatio: 0.5, cursor: "w-resize" },
];

function uid() {
    return Math.random().toString(36).slice(2, 10);
}

// ─── PdfPage ──────────────────────────────────────────────────────────────────

interface PageProps {
    pageNum: number;
    pdfDocument: pdfjsLib.PDFDocumentProxy;
    sizing: PageSizing;
    isDrawMode: boolean;
    isTextMode: boolean;
    annotations: AnnotationPayload[];
    textBoxes: TextBox[];
    isDrawing: boolean;
    activePage: number | null;
    currentPathD: string;
    currentColor: string;
    currentStrokeWidth: number;
    currentTool: ToolType;
    selectedId: string | null;
    editingId: string | null;
    onDimensionsUpdate: (p: number, w: number, h: number, nw: number, nh: number) => void;
    // text box callbacks
    onBoxPointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string) => void;
    onHandlePointerDown: (e: React.PointerEvent<HTMLDivElement>, id: string, handle: HandlePos) => void;
    onBoxClick: (e: React.MouseEvent, id: string) => void;
    onTextChange: (id: string, text: string) => void;
    // draw callbacks
    onSvgPointerDown: (e: React.PointerEvent<SVGSVGElement>, page: number) => void;
    onSvgPointerMove: (e: React.PointerEvent<SVGSVGElement>, page: number) => void;
    onSvgPointerUp: (e: React.PointerEvent<SVGSVGElement>, page: number) => void;
}

function PdfPage({
    pageNum,
    pdfDocument,
    sizing,
    isDrawMode,
    isTextMode,
    annotations,
    textBoxes,
    isDrawing,
    activePage,
    currentPathD,
    currentColor,
    currentStrokeWidth,
    currentTool,
    selectedId,
    editingId,
    onDimensionsUpdate,
    onBoxPointerDown,
    onHandlePointerDown,
    onBoxClick,
    onTextChange,
    onSvgPointerDown,
    onSvgPointerMove,
    onSvgPointerUp,
}: PageProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [dim, setDim] = useState({ width: 600, height: 800 });

    const sizingKey = sizing.mode === "fit" ? `fit:${Math.round(sizing.targetWidth)}` : `scale:${sizing.scale}`;

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const page = await pdfDocument.getPage(pageNum);
                const base = page.getViewport({ scale: 1 });
                const scale =
                    sizing.mode === "scale" ?
                        sizing.scale
                    :   Math.min(3, Math.max(0.2, sizing.targetWidth / base.width));
                const vp = page.getViewport({ scale });
                if (!alive) return;
                setDim({ width: vp.width, height: vp.height });
                onDimensionsUpdate(pageNum, vp.width, vp.height, base.width, base.height);
                const canvas = canvasRef.current;
                if (canvas) {
                    canvas.width = vp.width;
                    canvas.height = vp.height;
                    const ctx = canvas.getContext("2d");
                    if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
                }
            } catch (err) {
                console.error(`Page ${pageNum}:`, err);
            }
        })();
        return () => {
            alive = false;
        };
    }, [pdfDocument, pageNum, sizingKey]);

    const pageTBs = textBoxes.filter((tb) => tb.page === pageNum);

    return (
        <div className="sheet" style={{ width: dim.width, height: dim.height }}>
            <div className="sheet-label">Page {pageNum}</div>
            <canvas ref={canvasRef} className="sheet-canvas" />

            {/* SVG for pen / highlight drawing — sits BELOW text boxes */}
            <svg
                className="sheet-overlay"
                style={{
                    pointerEvents: isDrawMode ? "auto" : "none",
                    cursor: isDrawMode ? "crosshair" : "default",
                    zIndex: 1,
                }}
                viewBox={`0 0 ${dim.width} ${dim.height}`}
                onPointerDown={(e) => onSvgPointerDown(e, pageNum)}
                onPointerMove={(e) => onSvgPointerMove(e, pageNum)}
                onPointerUp={(e) => onSvgPointerUp(e, pageNum)}>
                {annotations
                    .filter((a) => a.page === pageNum)
                    .map((a, i) => (
                        <path
                            key={i}
                            d={a.d}
                            stroke={a.color}
                            strokeWidth={a.strokeWidth}
                            strokeOpacity={a.opacity}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                        />
                    ))}
                {isDrawing && activePage === pageNum && currentPathD && (
                    <path
                        d={currentPathD}
                        stroke={currentColor}
                        strokeWidth={currentStrokeWidth}
                        strokeOpacity={currentTool === "highlighter" ? 0.4 : 1}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                    />
                )}
            </svg>

            {/* Text boxes — always on top, each manages its own pointer events */}
            {pageTBs.map((tb) => {
                const isSel = selectedId === tb.id;
                const isEd = editingId === tb.id;

                return (
                    <div
                        key={tb.id}
                        className={`tb${isSel ? " tb-selected" : ""}`}
                        style={{
                            left: tb.x,
                            top: tb.y,
                            width: tb.w,
                            height: tb.h,
                            fontSize: tb.fontSize,
                            color: tb.color,
                            cursor:
                                isEd ? "text"
                                : isSel ? "grab"
                                : isTextMode ? "pointer"
                                : "default",
                            zIndex: 4,
                            pointerEvents: isTextMode ? "auto" : "none",
                        }}
                        onPointerDown={(e) => {
                            if (!isTextMode || isEd) return;
                            e.stopPropagation();
                            onBoxPointerDown(e, tb.id);
                        }}
                        onClick={(e) => {
                            if (!isTextMode) return;
                            e.stopPropagation();
                            onBoxClick(e, tb.id);
                        }}>
                        {/* Resize handles — only when selected and not editing */}
                        {isSel &&
                            !isEd &&
                            HANDLE_DEFS.map(({ pos, xRatio, yRatio, cursor }) => (
                                <div
                                    key={pos}
                                    className="tb-handle"
                                    style={{
                                        left: tb.w * xRatio - HS / 2,
                                        top: tb.h * yRatio - HS / 2,
                                        width: HS,
                                        height: HS,
                                        cursor,
                                    }}
                                    onPointerDown={(e) => {
                                        e.stopPropagation();
                                        onHandlePointerDown(e, tb.id, pos);
                                    }}
                                />
                            ))}

                        {/* Text content or textarea */}
                        {isEd ?
                            <textarea
                                className="tb-textarea"
                                autoFocus
                                value={tb.text}
                                style={{ fontSize: tb.fontSize, color: tb.color }}
                                onChange={(e) => onTextChange(tb.id, e.target.value)}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                            />
                        :   <div className="tb-display">
                                {tb.text ? tb.text : <span className="tb-placeholder">Type here…</span>}
                            </div>
                        }
                    </div>
                );
            })}

            {/* Transparent click-catcher for text tool to place new boxes on blank areas */}
            {isTextMode && (
                <div
                    className="sheet-text-catcher"
                    style={{ zIndex: 3 }}
                    onPointerDown={(e) => onSvgPointerDown(e as unknown as React.PointerEvent<SVGSVGElement>, pageNum)}
                />
            )}
        </div>
    );
}

// ─── PdfEditor ────────────────────────────────────────────────────────────────

export default function PdfEditor() {
    const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
    const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [fileName, setFileName] = useState("document.pdf");
    const [documentId, setDocumentId] = useState<string | null>(null);
    const [returnUrl, setReturnUrl] = useState<string | null>(null);
    const [numPages, setNumPages] = useState(0);

    const [tool, setTool] = useState<ToolType>(null);
    const [color, setColor] = useState("#f4511e");
    const [strokeWidth, setStrokeWidth] = useState(3);
    const [textFontSize, setTextFontSize] = useState(16);
    const [textColor, setTextColor] = useState("#16171c");

    // Annotation undo stack
    const [history, setHistory] = useState<AnnotationPayload[][]>([[]]);
    const [hIdx, setHIdx] = useState(0);
    const annotations = history[hIdx];

    // TextBox undo stack
    const [tbHistory, setTbHistory] = useState<TextBox[][]>([[]]);
    const [tbIdx, setTbIdx] = useState(0);
    const textBoxes = tbHistory[tbIdx];

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);

    // Active drag (move or resize)
    const dragRef = useRef<DragState | null>(null);
    // We keep a "live" copy of boxes during drag in a ref so mousemove doesn't cause re-renders per frame
    const liveTbRef = useRef<TextBox[]>([]);
    const [, forceRender] = useState(0);

    // Draw state
    const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
    const [isDrawing, setIsDrawing] = useState(false);
    const [activePage, setActivePage] = useState<number | null>(null);
    // Refs for draw handlers — avoids stale-closure bugs when pointerDown and
    // pointerUp fire in the same synchronous React batch (a quick click with no drag).
    const isDrawingRef = useRef(false);
    const activePageRef = useRef<number | null>(null);
    const currentPointsRef = useRef<Point[]>([]);
    const [statusMessage, setStatusMessage] = useState("");

    const [isTouchDevice, setIsTouchDevice] = useState(false);
    const viewportRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
    const [manualScale, setManualScale] = useState<number | null>(null);
    const pageDimRef = useRef<
        Record<number, { width: number; height: number; nativeWidth: number; nativeHeight: number }>
    >({});

    const isDrawMode = tool === "pen" || tool === "highlighter";
    const isTextMode = tool === "text";
    const canUndo = hIdx > 0 || tbIdx > 0;
    const canRedo = hIdx < history.length - 1 || tbIdx < tbHistory.length - 1;

    // Keep liveTbRef in sync with committed textBoxes
    useEffect(() => {
        liveTbRef.current = textBoxes;
    }, [textBoxes]);

    // ── resize observer ───────────────────────────────────────────────
    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const e of entries) setContainerWidth(e.contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const mq = window.matchMedia("(pointer: coarse)");
        const upd = () => setIsTouchDevice(mq.matches);
        upd();
        mq.addEventListener("change", upd);
        return () => mq.removeEventListener("change", upd);
    }, []);

    const sizing: PageSizing = useMemo(
        () =>
            manualScale === null ?
                { mode: "fit", targetWidth: Math.max(240, containerWidth) }
            :   { mode: "scale", scale: manualScale },
        [manualScale, containerWidth],
    );

    const getEffectiveScale = useCallback(() => {
        const f = pageDimRef.current[1];
        return f?.nativeWidth ? f.width / f.nativeWidth : 1;
    }, []);

    const zoomIn = useCallback(
        () => setManualScale((p) => Math.min(4, Math.round(((p ?? getEffectiveScale()) + 0.15) * 100) / 100)),
        [getEffectiveScale],
    );
    const zoomOut = useCallback(
        () => setManualScale((p) => Math.max(0.2, Math.round(((p ?? getEffectiveScale()) - 0.15) * 100) / 100)),
        [getEffectiveScale],
    );
    const toggleFit = useCallback(() => setManualScale((p) => (p === null ? 1 : null)), []);

    // ── initial URL load ──────────────────────────────────────────────
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const pdfUrl = params.get("pdfUrl");
        const id = params.get("id");
        const sessionId = params.get("session");
        if (id) setDocumentId(id);

        if (sessionId) {
            setDocumentId(sessionId);
            setStatusMessage("Loading document…");
            fetch(`/sessions/${sessionId}/info`)
                .then((r) => {
                    if (!r.ok) throw new Error();
                    return r.json();
                })
                .then((info) => {
                    setReturnUrl(info.returnUrl);
                    setFileName(info.fileName);
                    return fetch(`/sessions/${sessionId}/pdf`);
                })
                .then((r) => {
                    if (!r.ok) throw new Error();
                    return r.arrayBuffer();
                })
                .then(async (buf) => {
                    setPdfBytes(buf);
                    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
                    setPdfDocument(pdf);
                    setNumPages(pdf.numPages);
                    setHistory([[]]);
                    setHIdx(0);
                    setTbHistory([[]]);
                    setTbIdx(0);
                    setManualScale(null);
                    setStatusMessage("Document loaded.");
                })
                .catch(() => setStatusMessage("Couldn't load that document."));
            return;
        }

        if (!pdfUrl) return;
        setStatusMessage("Loading document…");
        fetch(pdfUrl)
            .then((r) => {
                if (!r.ok) throw new Error();
                return r.arrayBuffer();
            })
            .then(async (buf) => {
                setPdfBytes(buf);
                setFileName(pdfUrl.split("/").pop() || "document.pdf");
                const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
                setPdfDocument(pdf);
                setNumPages(pdf.numPages);
                setHistory([[]]);
                setHIdx(0);
                setTbHistory([[]]);
                setTbIdx(0);
                setManualScale(null);
                setStatusMessage("Document loaded.");
            })
            .catch(() => setStatusMessage("Couldn't load that document."));
    }, []);

    // ── commit helpers ────────────────────────────────────────────────
    // Use refs so callbacks never capture stale index values
    const hIdxRef = useRef(0);
    const tbIdxRef = useRef(0);
    // Keep refs in sync
    useEffect(() => {
        hIdxRef.current = hIdx;
    }, [hIdx]);
    useEffect(() => {
        tbIdxRef.current = tbIdx;
    }, [tbIdx]);

    // Also keep a ref to current annotations so pointerUp never reads stale closure
    const annotationsRef = useRef<AnnotationPayload[]>([]);
    useEffect(() => {
        annotationsRef.current = annotations;
    }, [annotations]);

    const commitAnnotations = useCallback((next: AnnotationPayload[]) => {
        const idx = hIdxRef.current;
        setHistory((prev) => [...prev.slice(0, idx + 1), next]);
        hIdxRef.current = idx + 1;
        setHIdx(idx + 1);
    }, []);

    const commitTextBoxes = useCallback((next: TextBox[]) => {
        const idx = tbIdxRef.current;
        setTbHistory((prev) => [...prev.slice(0, idx + 1), next]);
        tbIdxRef.current = idx + 1;
        setTbIdx(idx + 1);
        liveTbRef.current = next;
    }, []);

    // ── undo / redo ───────────────────────────────────────────────────
    const undo = useCallback(() => {
        if (tbIdx > 0) setTbIdx((i) => i - 1);
        else if (hIdx > 0) setHIdx((i) => i - 1);
    }, [tbIdx, hIdx]);

    const redo = useCallback(() => {
        if (tbIdx < tbHistory.length - 1) setTbIdx((i) => i + 1);
        else if (hIdx < history.length - 1) setHIdx((i) => i + 1);
    }, [tbIdx, tbHistory.length, hIdx, history.length]);

    // ── keyboard ──────────────────────────────────────────────────────
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (!pdfDocument) return;
            const mod = e.ctrlKey || e.metaKey;
            if (editingId) return; // don't steal keys while typing
            if (mod) {
                const k = e.key.toLowerCase();
                if (k === "z" && !e.shiftKey) {
                    e.preventDefault();
                    undo();
                } else if ((k === "z" && e.shiftKey) || k === "y") {
                    e.preventDefault();
                    redo();
                }
            } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
                e.preventDefault();
                commitTextBoxes(liveTbRef.current.filter((t) => t.id !== selectedId));
                setSelectedId(null);
            } else if (e.key === "Escape") {
                setSelectedId(null);
                setEditingId(null);
            }
        };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [pdfDocument, undo, redo, selectedId, editingId, commitTextBoxes]);

    // ── global pointermove / pointerup for drag ───────────────────────
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const ds = dragRef.current;
            if (!ds) return;
            const dx = e.clientX - ds.startMouseX;
            const dy = e.clientY - ds.startMouseY;

            liveTbRef.current = liveTbRef.current.map((tb) => {
                if (tb.id !== ds.id) return tb;
                if (ds.kind === "move") {
                    return { ...tb, x: ds.origX + dx, y: ds.origY + dy };
                }
                // resize
                let { x, y, w, h } = tb;
                const h_ = ds.handle!;
                if (h_.includes("e")) w = Math.max(MIN_W, ds.origW + dx);
                if (h_.includes("s")) h = Math.max(MIN_H, ds.origH + dy);
                if (h_.includes("w")) {
                    x = ds.origX + dx;
                    w = Math.max(MIN_W, ds.origW - dx);
                }
                if (h_.includes("n")) {
                    y = ds.origY + dy;
                    h = Math.max(MIN_H, ds.origH - dy);
                }
                return { ...tb, x, y, w, h };
            });
            forceRender((n) => n + 1); // trigger re-render without going through state
        };

        const onUp = () => {
            if (!dragRef.current) return;
            dragRef.current = null;
            // Commit the live state as a new history entry
            commitTextBoxes([...liveTbRef.current]);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
    }, [commitTextBoxes]);

    // ── drawing coordinates ───────────────────────────────────────────
    const getSvgCoords = (e: React.PointerEvent<SVGSVGElement>, page: number): Point => {
        const rect = e.currentTarget.getBoundingClientRect();
        const dim = pageDimRef.current[page] || { width: rect.width, height: rect.height };
        return {
            x: (e.clientX - rect.left) * (dim.width / rect.width),
            y: (e.clientY - rect.top) * (dim.height / rect.height),
        };
    };

    // For click-catcher divs (text mode), compute coords from a div pointer event
    const getDivCoords = (e: React.PointerEvent<HTMLDivElement>, page: number): Point => {
        const rect = e.currentTarget.getBoundingClientRect();
        const dim = pageDimRef.current[page] || { width: rect.width, height: rect.height };
        return {
            x: (e.clientX - rect.left) * (dim.width / rect.width),
            y: (e.clientY - rect.top) * (dim.height / rect.height),
        };
    };

    // ── SVG pointer handlers (draw mode) ─────────────────────────────
    const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>, page: number) => {
        if (isTextMode) {
            // Create new text box
            const pt = getSvgCoords(e, page);
            const dim = pageDimRef.current[page] || { width: 600, height: 800 };
            const nb: TextBox = {
                id: uid(),
                page,
                x: pt.x,
                y: pt.y,
                w: 220,
                h: 80,
                text: "",
                fontSize: textFontSize,
                color: textColor,
                pageWidth: dim.width,
                pageHeight: dim.height,
            };
            const next = [...liveTbRef.current, nb];
            commitTextBoxes(next);
            setSelectedId(nb.id);
            setEditingId(nb.id);
            return;
        }
        if (!isDrawMode) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const pt = getSvgCoords(e, page);
        // Update refs synchronously so pointerUp sees them even when both
        // events fire inside the same React batch (quick click, no drag).
        isDrawingRef.current = true;
        activePageRef.current = page;
        currentPointsRef.current = [pt];
        setIsDrawing(true);
        setActivePage(page);
        setCurrentPoints([pt]);
    };

    const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>, page: number) => {
        if (!isDrawingRef.current || activePageRef.current !== page) return;
        const pt = getSvgCoords(e, page);
        const next = [...currentPointsRef.current, pt];
        currentPointsRef.current = next;
        setCurrentPoints(next);
    };

    const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>, page: number) => {
        // Use refs instead of state so this guard works even when pointerDown and
        // pointerUp fire in the same React batch (stale-closure would make the
        // state values appear unchanged).
        if (!isDrawingRef.current || activePageRef.current !== page) return;

        const pts = currentPointsRef.current;
        isDrawingRef.current = false;
        activePageRef.current = null;
        currentPointsRef.current = [];

        setIsDrawing(false);
        setActivePage(null);
        setCurrentPoints([]);

        // Commit the completed stroke outside any state updater so it is never
        // called twice (React Strict Mode double-invokes updater functions, which
        // would corrupt hIdxRef and produce duplicate history entries).
        if (pts.length > 1) {
            const dim = pageDimRef.current[page] || { width: 600, height: 800 };
            const d = pts.reduce((acc, p, i) => (i === 0 ? `M${p.x},${p.y}` : `${acc} L${p.x},${p.y}`), "");
            commitAnnotations([
                ...annotationsRef.current,
                {
                    page,
                    width: dim.width,
                    height: dim.height,
                    d,
                    color,
                    strokeWidth,
                    opacity: tool === "highlighter" ? 0.4 : 1,
                },
            ]);
        }
    };

    // ── text-tool click catcher (blank page area) ─────────────────────
    // We reuse handleSvgPointerDown by casting — the coords logic works the same
    const handleCatcherPointerDown = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
        if (!isTextMode) return;
        const pt = getDivCoords(e, page);
        const dim = pageDimRef.current[page] || { width: 600, height: 800 };
        const nb: TextBox = {
            id: uid(),
            page,
            x: pt.x,
            y: pt.y,
            w: 220,
            h: 80,
            text: "",
            fontSize: textFontSize,
            color: textColor,
            pageWidth: dim.width,
            pageHeight: dim.height,
        };
        const next = [...liveTbRef.current, nb];
        commitTextBoxes(next);
        setSelectedId(nb.id);
        setEditingId(nb.id);
    };

    // ── text box interaction ──────────────────────────────────────────
    const handleBoxPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
        if (editingId === id) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const tb = liveTbRef.current.find((t) => t.id === id);
        if (!tb) return;
        dragRef.current = {
            kind: "move",
            id,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            origX: tb.x,
            origY: tb.y,
            origW: tb.w,
            origH: tb.h,
        };
    };

    const handleHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string, handle: HandlePos) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const tb = liveTbRef.current.find((t) => t.id === id);
        if (!tb) return;
        dragRef.current = {
            kind: "resize",
            id,
            handle,
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            origX: tb.x,
            origY: tb.y,
            origW: tb.w,
            origH: tb.h,
        };
    };

    const handleBoxClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        // If already selected → enter edit mode on click
        if (selectedId === id) {
            setEditingId(id);
        } else {
            setSelectedId(id);
            setEditingId(null);
        }
    };

    const handleTextChange = (id: string, text: string) => {
        // Update live without pushing history on every keystroke
        liveTbRef.current = liveTbRef.current.map((tb) => (tb.id === id ? { ...tb, text } : tb));
        forceRender((n) => n + 1);
    };

    // Deselect text boxes when clicking blank area — but never interfere with draw mode
    const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        // In draw mode the SVG handles everything — don't touch text box state
        if (isDrawMode) return;
        // Ignore clicks that landed on a text box element
        if ((e.target as HTMLElement).closest(".tb")) return;
        // Ignore clicks that landed on the SVG overlay or canvas (sheet internals)
        if ((e.target as HTMLElement).closest(".sheet-overlay")) return;
        if ((e.target as HTMLElement).tagName === "CANVAS") return;
        // Commit any in-progress text edit and deselect
        if (editingId) {
            commitTextBoxes([...liveTbRef.current]);
        }
        setSelectedId(null);
        setEditingId(null);
    };

    // ── tool select ───────────────────────────────────────────────────
    const handleToolSelect = (t: "pen" | "highlighter" | "text") => {
        if (tool === t) {
            setTool(null);
            return;
        }
        setTool(t);
        if (t === "highlighter") {
            setColor("#ffd60a");
            setStrokeWidth(16);
        } else if (t === "pen") {
            setColor("#f4511e");
            setStrokeWidth(3);
        }
    };

    const handleSaveReturn = async () => {
        if (!pdfBytes || !documentId) return;
        setStatusMessage("Saving…");
        try {
            const doc = await PDFDocument.load(new Uint8Array(pdfBytes));
            const pages = doc.getPages();
            const font = await doc.embedFont(StandardFonts.Helvetica);

            annotations.forEach((ann) => {
                const pg = pages[ann.page - 1];
                if (!pg) return;
                const { width: pw, height: ph } = pg.getSize();
                let cur: Point | null = null;
                ann.d.split(/(?=[ML])/).forEach((cmd) => {
                    const t = cmd[0];
                    const ns = cmd.slice(1).split(",").map(Number);
                    if (ns.length < 2 || isNaN(ns[0])) return;
                    const pt = { x: (ns[0] / ann.width) * pw, y: (1 - ns[1] / ann.height) * ph };
                    if (t === "M") {
                        cur = pt;
                    } else if (t === "L" && cur) {
                        pg.drawLine({
                            start: cur,
                            end: pt,
                            thickness: ann.strokeWidth,
                            color: hexToRgb(ann.color),
                            opacity: ann.opacity,
                        });
                        cur = pt;
                    }
                });
            });

            liveTbRef.current.forEach((tb) => {
                if (!tb.text.trim()) return;
                const pg = pages[tb.page - 1];
                if (!pg) return;
                const { width: pw, height: ph } = pg.getSize();
                const sx = pw / tb.pageWidth,
                    sy = ph / tb.pageHeight;
                pg.drawText(tb.text, {
                    x: tb.x * sx + 4,
                    y: ph - (tb.y + tb.h) * sy + 4,
                    size: tb.fontSize * Math.min(sx, sy),
                    font,
                    color: hexToRgb(tb.color),
                    maxWidth: tb.w * sx - 8,
                    lineHeight: tb.fontSize * Math.min(sx, sy) * 1.4,
                });
            });

            const bytes = await doc.save();
            const blob = new Blob([bytes as any], { type: "application/pdf" });
            const fd = new FormData();
            fd.append("file", blob, fileName);

            const res = await fetch(`/sessions/${documentId}/save`, {
                method: "POST",
                body: fd,
            });

            if (!res.ok) {
                setStatusMessage("Save failed.");
                return;
            }

            const ct = res.headers.get("Content-Type") || "";
            if (ct.includes("application/pdf")) {
                // PDF returned – download it
                const pdfBlob = await res.blob();
                const url = URL.createObjectURL(pdfBlob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `edited_${fileName}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 250);
                setStatusMessage("PDF saved.");
            }

            if (returnUrl) {
                setStatusMessage("Saved! Redirecting…");
                setTimeout(() => {
                    window.location.href = returnUrl;
                }, 1000);
            }
        } catch (err) {
            console.error(err);
            setStatusMessage("Save failed. Please try again.");
        }
    };

    const handleClearAll = () => {
        if (!annotations.length && !textBoxes.length) return;
        commitAnnotations([]);
        commitTextBoxes([]);
        setSelectedId(null);
        setEditingId(null);
    };

    // ── export ────────────────────────────────────────────────────────
    const hexToRgb = (hex: string) => {
        const c = hex.replace("#", "");
        const r = parseInt(c.slice(0, 2), 16) / 255;
        const g = parseInt(c.slice(2, 4), 16) / 255;
        const b = parseInt(c.slice(4, 6), 16) / 255;
        return rgb(isNaN(r) ? 1 : r, isNaN(g) ? 0.317 : g, isNaN(b) ? 0 : b);
    };

    const handleExport = async () => {
        if (!pdfBytes) return;
        setStatusMessage("Exporting PDF…");
        try {
            const doc = await PDFDocument.load(new Uint8Array(pdfBytes));
            const pages = doc.getPages();
            const font = await doc.embedFont(StandardFonts.Helvetica);

            annotations.forEach((ann) => {
                const pg = pages[ann.page - 1];
                if (!pg) return;
                const { width: pw, height: ph } = pg.getSize();
                let cur: Point | null = null;
                ann.d.split(/(?=[ML])/).forEach((cmd) => {
                    const t = cmd[0];
                    const ns = cmd.slice(1).split(",").map(Number);
                    if (ns.length < 2 || isNaN(ns[0])) return;
                    const pt = { x: (ns[0] / ann.width) * pw, y: (1 - ns[1] / ann.height) * ph };
                    if (t === "M") {
                        cur = pt;
                    } else if (t === "L" && cur) {
                        pg.drawLine({
                            start: cur,
                            end: pt,
                            thickness: ann.strokeWidth,
                            color: hexToRgb(ann.color),
                            opacity: ann.opacity,
                        });
                        cur = pt;
                    }
                });
            });

            liveTbRef.current.forEach((tb) => {
                if (!tb.text.trim()) return;
                const pg = pages[tb.page - 1];
                if (!pg) return;
                const { width: pw, height: ph } = pg.getSize();
                const sx = pw / tb.pageWidth,
                    sy = ph / tb.pageHeight;
                pg.drawText(tb.text, {
                    x: tb.x * sx + 4,
                    y: ph - (tb.y + tb.h) * sy + 4,
                    size: tb.fontSize * Math.min(sx, sy),
                    font,
                    color: hexToRgb(tb.color),
                    maxWidth: tb.w * sx - 8,
                    lineHeight: tb.fontSize * Math.min(sx, sy) * 1.4,
                });
            });

            const bytes = await doc.save();
            const blob = new Blob([bytes as any], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `revised_${fileName}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 250);

            if (documentId) {
                const fd = new FormData();
                fd.append("file", blob, fileName);
                fd.append("annotations", JSON.stringify(annotations));
                const res = await fetch(`/files/${documentId}/revise`, {
                    method: "POST",
                    body: fd,
                });
                setStatusMessage(res.ok ? "Changes saved." : "Save failed.");
            } else {
                setStatusMessage("Document exported.");
            }
        } catch (err) {
            console.error(err);
            setStatusMessage("Export failed. Please try again.");
        }
    };

    const handleFileLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setFileName(file.name);
        setReturnUrl(null);
        setHistory([[]]);
        setHIdx(0);
        setTbHistory([[]]);
        setTbIdx(0);
        setTool(null);
        setManualScale(null);
        setSelectedId(null);
        setEditingId(null);
        const buf = await file.arrayBuffer();
        setPdfBytes(buf);
        try {
            const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
            setPdfDocument(pdf);
            setNumPages(pdf.numPages);
            setStatusMessage("Document loaded.");
        } catch {
            setStatusMessage("That file couldn't be opened.");
        }
    };

    const hasDoc = Boolean(pdfBytes && pdfDocument);
    const currentPathD = useMemo(
        () => currentPoints.reduce((acc, p, i) => (i === 0 ? `M${p.x},${p.y}` : `${acc} L${p.x},${p.y}`), ""),
        [currentPoints],
    );

    // Use liveTbRef for rendering so drag feels instant
    const renderBoxes = dragRef.current || editingId ? liveTbRef.current : textBoxes;

    return (
        <div className="app-shell">
            <style>{STYLES}</style>

            <header className="toolbar">
                <div className="toolbar-row">
                    <div className="brand">
                        <span className="brand-mark">
                            <FileText size={18} strokeWidth={2.25} />
                        </span>
                        <span className="brand-text">
                            <span className="brand-title">PDF Studio</span>
                            {hasDoc && (
                                <span className="brand-file" title={fileName}>
                                    {fileName}
                                </span>
                            )}
                        </span>
                    </div>
                    <div className="toolbar-actions">
                        <label className="btn btn-ghost file-btn">
                            <UploadCloud size={16} />
                            <span className="btn-label">Open PDF</span>
                            <input
                                type="file"
                                accept="application/pdf"
                                onChange={handleFileLoad}
                                className="file-input"
                            />
                        </label>

                        {hasDoc && (
                            <>
                                <div className="seg-group" role="group">
                                    {isTouchDevice && (
                                        <button
                                            type="button"
                                            onClick={() => setTool(null)}
                                            className={`seg-btn ${!tool ? "seg-btn-active" : ""}`}>
                                            <Hand size={16} />
                                            <span className="btn-label">Pan</span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => handleToolSelect("pen")}
                                        className={`seg-btn ${tool === "pen" ? "seg-btn-active" : ""}`}>
                                        <PenLine size={16} />
                                        <span className="btn-label">Pen</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleToolSelect("highlighter")}
                                        className={`seg-btn ${tool === "highlighter" ? "seg-btn-active" : ""}`}>
                                        <Highlighter size={16} />
                                        <span className="btn-label">Highlight</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleToolSelect("text")}
                                        className={`seg-btn ${tool === "text" ? "seg-btn-active" : ""}`}>
                                        <Type size={16} />
                                        <span className="btn-label">Text</span>
                                    </button>
                                </div>

                                <div className="icon-cluster">
                                    <button
                                        type="button"
                                        onClick={undo}
                                        disabled={!canUndo}
                                        className="icon-btn"
                                        title="Undo (Ctrl+Z)">
                                        <Undo2 size={17} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={redo}
                                        disabled={!canRedo}
                                        className="icon-btn"
                                        title="Redo (Ctrl+Shift+Z)">
                                        <Redo2 size={17} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleClearAll}
                                        disabled={!annotations.length && !textBoxes.length}
                                        className="icon-btn icon-btn-danger"
                                        title="Clear all">
                                        <Trash2 size={17} />
                                    </button>
                                </div>

                                <div className="icon-cluster">
                                    <button type="button" onClick={zoomOut} className="icon-btn">
                                        <ZoomOut size={17} />
                                    </button>
                                    <button type="button" onClick={toggleFit} className="zoom-label">
                                        {manualScale === null ? "Fit" : `${Math.round(manualScale * 100)}%`}
                                    </button>
                                    <button type="button" onClick={zoomIn} className="icon-btn">
                                        <ZoomIn size={17} />
                                    </button>
                                </div>

                                {returnUrl ?
                                    <button type="button" onClick={handleSaveReturn} className="btn btn-primary">
                                        <Download size={16} />
                                        <span className="btn-label">Save &amp; Return</span>
                                    </button>
                                :   <button type="button" onClick={handleExport} className="btn btn-primary">
                                        <Download size={16} />
                                        <span className="btn-label">Export PDF</span>
                                    </button>
                                }
                            </>
                        )}
                    </div>
                </div>

                {hasDoc && isDrawMode && (
                    <div className="config-bar">
                        <div className="config-item">
                            <span className="config-label">Color</span>
                            <input
                                type="color"
                                value={color}
                                onChange={(e) => setColor(e.target.value)}
                                className="swatch-input"
                            />
                        </div>
                        <div className="config-item config-item-grow">
                            <span className="config-label">Thickness</span>
                            <input
                                type="range"
                                min="1"
                                max="50"
                                value={strokeWidth}
                                onChange={(e) => setStrokeWidth(Number(e.target.value))}
                                className="slider-input"
                            />
                            <span className="config-value">{strokeWidth}px</span>
                        </div>
                        <span className="badge">{tool === "pen" ? "Pen" : "Highlighter"} active</span>
                    </div>
                )}

                {hasDoc && isTextMode && (
                    <div className="config-bar">
                        <div className="config-item">
                            <span className="config-label">Color</span>
                            <input
                                type="color"
                                value={textColor}
                                onChange={(e) => setTextColor(e.target.value)}
                                className="swatch-input"
                            />
                        </div>
                        <div className="config-item config-item-grow">
                            <span className="config-label">Font size</span>
                            <input
                                type="range"
                                min="8"
                                max="72"
                                value={textFontSize}
                                onChange={(e) => setTextFontSize(Number(e.target.value))}
                                className="slider-input"
                            />
                            <span className="config-value">{textFontSize}px</span>
                        </div>
                        <span className="badge">
                            {editingId ?
                                "Editing — click outside to finish"
                            : selectedId ?
                                "Selected — click to edit · drag to move · Delete to remove"
                            :   "Click on page to add text"}
                        </span>
                    </div>
                )}
            </header>

            {statusMessage && <div className="status-bar">{statusMessage}</div>}

            <div className="viewport" ref={viewportRef} onPointerDown={handleViewportPointerDown}>
                {!hasDoc ?
                    <div className="empty-state">
                        <div className="empty-icon">
                            <FileText size={28} strokeWidth={1.5} />
                        </div>
                        <p className="empty-title">No PDF open yet</p>
                        <p className="empty-copy">
                            Open a local file above, or load one with a <code>?pdfUrl=</code> link parameter.
                        </p>
                    </div>
                :   Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                        <PdfPage
                            key={pageNum}
                            pageNum={pageNum}
                            pdfDocument={pdfDocument!}
                            sizing={sizing}
                            isDrawMode={isDrawMode}
                            isTextMode={isTextMode}
                            annotations={annotations}
                            textBoxes={renderBoxes}
                            isDrawing={isDrawing}
                            activePage={activePage}
                            currentPathD={currentPathD}
                            currentColor={color}
                            currentStrokeWidth={strokeWidth}
                            currentTool={tool}
                            selectedId={selectedId}
                            editingId={editingId}
                            onDimensionsUpdate={(p, w, h, nw, nh) => {
                                pageDimRef.current[p] = { width: w, height: h, nativeWidth: nw, nativeHeight: nh };
                            }}
                            onBoxPointerDown={handleBoxPointerDown}
                            onHandlePointerDown={handleHandlePointerDown}
                            onBoxClick={handleBoxClick}
                            onTextChange={handleTextChange}
                            onSvgPointerDown={handleSvgPointerDown}
                            onSvgPointerMove={handleSvgPointerMove}
                            onSvgPointerUp={handleSvgPointerUp}
                        />
                    ))
                }
            </div>
        </div>
    );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const STYLES = `
:root {
    --bg: #f1f2f6; --surface: #fff; --border: #e3e4ea;
    --text: #16171c; --text-soft: #6b6e76;
    --accent: #f4511e; --accent-soft: #fff1ec;
    --danger: #d7263d; --radius: 12px;
}
* { box-sizing: border-box; }
.app-shell { display:flex; flex-direction:column; width:100vw; height:100vh;
    font-family: -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;
    background:var(--bg); color:var(--text); }

.toolbar { background:var(--surface); border-bottom:1px solid var(--border);
    box-shadow:0 1px 0 rgba(16,17,22,.02); z-index:10; }
.toolbar-row { display:flex; align-items:center; justify-content:space-between;
    gap:16px; padding:12px 20px; flex-wrap:wrap; }

.brand { display:flex; align-items:center; gap:10px; min-width:0; }
.brand-mark { display:flex; align-items:center; justify-content:center;
    width:34px; height:34px; border-radius:9px; background:var(--accent); color:#fff; flex-shrink:0; }
.brand-text { display:flex; flex-direction:column; line-height:1.2; min-width:0; }
.brand-title { font-weight:700; font-size:14.5px; }
.brand-file { font-size:12px; color:var(--text-soft); overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; max-width:220px; }

.toolbar-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.btn { display:inline-flex; align-items:center; gap:7px; padding:8px 14px;
    border-radius:9px; border:1px solid transparent; font-size:13px; font-weight:600;
    cursor:pointer; transition:background .15s,border-color .15s,transform .05s; white-space:nowrap; }
.btn:active { transform:scale(.97); }
.btn-ghost { background:var(--surface); border-color:var(--border); color:var(--text); }
.btn-ghost:hover { background:#f7f7f9; }
.btn-primary { background:var(--accent); color:#fff; }
.btn-primary:hover { background:#e0440f; }
.file-btn { position:relative; }
.file-input { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; }

.seg-group { display:flex; background:#eeeef2; border-radius:10px; padding:3px; gap:2px; }
.seg-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 12px;
    border:none; border-radius:8px; background:transparent; color:var(--text-soft);
    font-size:13px; font-weight:600; cursor:pointer; transition:background .15s,color .15s; }
.seg-btn:hover { color:var(--text); }
.seg-btn-active { background:var(--surface); color:var(--text); box-shadow:0 1px 3px rgba(16,17,22,.12); }

.icon-cluster { display:flex; align-items:center; gap:2px;
    background:#f7f7f9; border-radius:10px; padding:3px; }
.icon-btn { display:flex; align-items:center; justify-content:center;
    width:32px; height:32px; border:none; border-radius:7px; background:transparent;
    color:var(--text); cursor:pointer; transition:background .15s,opacity .15s; }
.icon-btn:hover:not(:disabled) { background:#e9e9ed; }
.icon-btn:disabled { opacity:.35; cursor:not-allowed; }
.icon-btn-danger:hover:not(:disabled) { background:#fdeaec; color:var(--danger); }
.zoom-label { min-width:44px; height:32px; padding:0 6px; border:none; border-radius:7px;
    background:transparent; color:var(--text); font-size:12.5px; font-weight:700;
    cursor:pointer; transition:background .15s; }
.zoom-label:hover { background:#e9e9ed; }

.config-bar { display:flex; align-items:center; gap:22px; padding:10px 20px;
    background:#fafafc; border-top:1px solid var(--border); flex-wrap:wrap; }
.config-item { display:flex; align-items:center; gap:9px; }
.config-item-grow { flex:1; min-width:160px; }
.config-label { font-size:12px; font-weight:600; color:var(--text-soft); flex-shrink:0; }
.config-value { font-size:12px; font-weight:600; color:var(--text-soft); flex-shrink:0; min-width:34px; }
.swatch-input { border:1px solid var(--border); border-radius:7px;
    width:30px; height:26px; padding:0; cursor:pointer; background:transparent; }
.slider-input { cursor:pointer; flex:1; accent-color:var(--accent); }
.badge { font-size:11px; font-weight:700; color:var(--accent); background:var(--accent-soft);
    padding:5px 10px; border-radius:999px; text-transform:uppercase; letter-spacing:.02em; }

.status-bar { padding:8px 20px; background:#fff8e8; color:#8a6300;
    font-size:12.5px; font-weight:500; border-bottom:1px solid #f3e7c4; }

.viewport { flex:1; overflow-y:auto; overflow-x:auto; display:flex;
    flex-direction:column; align-items:center; padding:28px 12px 60px; gap:24px; }

.empty-state { margin-top:14vh; max-width:360px; text-align:center; color:var(--text-soft); }
.empty-icon { display:inline-flex; align-items:center; justify-content:center;
    width:56px; height:56px; border-radius:16px; background:var(--surface);
    border:1px solid var(--border); color:var(--accent); margin-bottom:14px; }
.empty-title { font-size:15px; font-weight:700; color:var(--text); margin:0 0 6px; }
.empty-copy { font-size:13px; line-height:1.5; margin:0; }
.empty-copy code { background:#e9e9ed; padding:1px 5px; border-radius:4px; font-size:12px; }

.sheet { position:relative; background:var(--surface); border-radius:var(--radius);
    border:1px solid var(--border); box-shadow:0 12px 28px rgba(16,17,22,.08);
    overflow:hidden; flex-shrink:0; }
.sheet-label { position:absolute; top:10px; left:10px;
    background:rgba(22,23,28,.78); color:#fff; padding:3px 9px; border-radius:999px;
    font-size:10.5px; font-weight:600; letter-spacing:.02em; z-index:5; backdrop-filter:blur(2px); }
.sheet-canvas { width:100%; height:100%; display:block; }
.sheet-overlay { position:absolute; inset:0; width:100%; height:100%;
    background:transparent; touch-action:none; }

/* click-catcher layer for text tool on blank page areas */
.sheet-text-catcher { position:absolute; inset:0; width:100%; height:100%;
    background:transparent; cursor:text; }

/* ── text boxes ── */
.tb {
    position: absolute;
    border: 1.5px dashed #adb1ba;
    border-radius: 4px;
    background: transparent;
    overflow: visible;
    user-select: none;
    transition: border-color .12s;
    touch-action: none;
}
.tb:hover { border-color: #4f7ef8; }
.tb-selected {
    border: 1.5px solid #4f7ef8 !important;
    background: rgba(79,126,248,.04);
}

.tb-handle {
    position: absolute;
    background: #fff;
    border: 1.5px solid #4f7ef8;
    border-radius: 2px;
    touch-action: none;
    z-index: 10;
}
.tb-handle:hover { background: #e8effe; }

.tb-display {
    width: 100%; height: 100%;
    padding: 4px 6px;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
    pointer-events: none;
}
.tb-placeholder { color: #adb1ba; font-style: italic; }

.tb-textarea {
    display: block;
    width: 100%; height: 100%;
    padding: 4px 6px;
    border: none; outline: none;
    background: rgba(255,255,255,.93);
    resize: none;
    font-family: inherit;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    border-radius: 3px;
}

@media (max-width:720px) {
    .toolbar-row { padding:10px 14px; }
    .btn-label { display:none; }
    .btn { padding:8px 10px; }
    .brand-file { max-width:120px; }
    .config-bar { padding:10px 14px; gap:14px; }
    .viewport { padding:18px 8px 48px; gap:16px; }
}
`;
