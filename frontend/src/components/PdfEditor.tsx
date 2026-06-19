import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { PDFDocument, rgb } from "pdf-lib";
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
} from "lucide-react";

// Use Vite's native asset URL query to bundle the worker file locally instead of using a CDN
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface AnnotationPayload {
    page: number;
    width: number;
    height: number;
    d: string;
    color: string;
    strokeWidth: number;
    opacity: number;
}

interface Point {
    x: number;
    y: number;
}

type ToolType = "pen" | "highlighter" | null;

type PageSizing = { mode: "fit"; targetWidth: number } | { mode: "scale"; scale: number };

interface PageProps {
    pageNum: number;
    pdfDocument: pdfjsLib.PDFDocumentProxy;
    sizing: PageSizing;
    isDrawMode: boolean;
    annotations: AnnotationPayload[];
    isDrawing: boolean;
    activePage: number | null;
    currentPathD: string;
    currentColor: string;
    currentStrokeWidth: number;
    currentTool: ToolType;
    handlePointerDown: (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => void;
    handlePointerMove: (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => void;
    handlePointerUp: (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => void;
    onDimensionsUpdate: (
        pageNum: number,
        width: number,
        height: number,
        nativeWidth: number,
        nativeHeight: number,
    ) => void;
}

function PdfPage({
    pageNum,
    pdfDocument,
    sizing,
    isDrawMode,
    annotations,
    isDrawing,
    activePage,
    currentPathD,
    currentColor,
    currentStrokeWidth,
    currentTool,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    onDimensionsUpdate,
}: PageProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 600, height: 800 });

    const sizingKey = sizing.mode === "fit" ? `fit:${Math.round(sizing.targetWidth)}` : `scale:${sizing.scale}`;

    useEffect(() => {
        let isMounted = true;

        const renderPage = async () => {
            try {
                const page = await pdfDocument.getPage(pageNum);
                const baseViewport = page.getViewport({ scale: 1 });
                // "fit" mode sizes the page to the available width (you can scroll vertically as needed).
                // "scale" mode (zoom) uses an explicit factor, where 1 means the page's true, original size
                // (1 PDF point per CSS pixel) — applied identically to width and height, so proportions
                // never change, only overall size.
                const scale =
                    sizing.mode === "scale" ?
                        sizing.scale
                    :   Math.min(3, Math.max(0.2, sizing.targetWidth / baseViewport.width));
                const viewport = page.getViewport({ scale });

                if (!isMounted) return;

                setDimensions({ width: viewport.width, height: viewport.height });
                onDimensionsUpdate(pageNum, viewport.width, viewport.height, baseViewport.width, baseViewport.height);

                const canvas = canvasRef.current;
                if (canvas) {
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    const context = canvas.getContext("2d");
                    if (context) {
                        await page.render({ canvasContext: context, viewport }).promise;
                    }
                }
            } catch (err) {
                console.error(`Error rendering page ${pageNum}:`, err);
            }
        };

        renderPage();

        return () => {
            isMounted = false;
        };
    }, [pdfDocument, pageNum, sizingKey]);

    return (
        <div
            className="sheet"
            style={{
                width: `${dimensions.width}px`,
                height: `${dimensions.height}px`,
            }}>
            <div className="sheet-label">Page {pageNum}</div>
            <canvas ref={canvasRef} className="sheet-canvas" />

            <svg
                className="sheet-overlay"
                style={{ pointerEvents: isDrawMode ? "auto" : "none" }}
                viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
                onPointerDown={(e) => handlePointerDown(e, pageNum)}
                onPointerMove={(e) => handlePointerMove(e, pageNum)}
                onPointerUp={(e) => handlePointerUp(e, pageNum)}>
                {annotations
                    .filter((item) => item.page === pageNum)
                    .map((item, index) => (
                        <path
                            key={index}
                            d={item.d}
                            stroke={item.color}
                            strokeWidth={item.strokeWidth}
                            strokeOpacity={item.opacity}
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
                        strokeOpacity={currentTool === "highlighter" ? 0.4 : 1.0}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                    />
                )}
            </svg>
        </div>
    );
}

export default function PdfEditor() {
    const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
    const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [fileName, setFileName] = useState<string>("document.pdf");
    const [documentId, setDocumentId] = useState<string | null>(null);
    const [numPages, setNumPages] = useState<number>(0);

    // tool === null means navigate / grab mode. Selecting a tool switches into draw mode.
    const [tool, setTool] = useState<ToolType>(null);
    const [color, setColor] = useState<string>("#f4511e");
    const [strokeWidth, setStrokeWidth] = useState<number>(3);

    // Annotation history, so Undo/Redo can step back and forward through edits.
    const [history, setHistory] = useState<AnnotationPayload[][]>([[]]);
    const [historyIndex, setHistoryIndex] = useState<number>(0);
    const annotations = history[historyIndex];

    const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
    const [isDrawing, setIsDrawing] = useState<boolean>(false);
    const [activePage, setActivePage] = useState<number | null>(null);
    const [statusMessage, setStatusMessage] = useState<string>("");

    // Touch devices need an explicit way back to panning; desktop never loses the ability to scroll.
    const [isTouchDevice, setIsTouchDevice] = useState<boolean>(false);

    // The viewport's real measured width drives "fit" sizing, so pages use all the room they actually have.
    const viewportRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState<number>(
        typeof window !== "undefined" ? window.innerWidth : 1024,
    );
    // null = fit to the viewport width. A number is an explicit zoom factor (1 = the page's true original size).
    const [manualScale, setManualScale] = useState<number | null>(null);

    const pageDimensionsRef = useRef<{
        [page: number]: { width: number; height: number; nativeWidth: number; nativeHeight: number };
    }>({});
    const isDrawMode = tool !== null;
    const canUndo = historyIndex > 0;
    const canRedo = historyIndex < history.length - 1;

    useEffect(() => {
        if (typeof window === "undefined") return;
        const mq = window.matchMedia("(pointer: coarse)");
        const update = () => setIsTouchDevice(mq.matches);
        update();
        mq.addEventListener("change", update);
        return () => mq.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        const el = viewportRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const sizing: PageSizing = useMemo(
        () =>
            manualScale === null ?
                { mode: "fit", targetWidth: Math.max(240, containerWidth) }
            :   { mode: "scale", scale: manualScale },
        [manualScale, containerWidth],
    );

    // Used so Zoom in/out starts from whatever the page is currently showing while in "fit" mode.
    const getEffectiveScale = useCallback(() => {
        const first = pageDimensionsRef.current[1];
        if (!first || !first.nativeWidth) return 1;
        return first.width / first.nativeWidth;
    }, []);

    const zoomIn = useCallback(() => {
        setManualScale((prev) => Math.min(4, Math.round(((prev ?? getEffectiveScale()) + 0.15) * 100) / 100));
    }, [getEffectiveScale]);

    const zoomOut = useCallback(() => {
        setManualScale((prev) => Math.max(0.2, Math.round(((prev ?? getEffectiveScale()) - 0.15) * 100) / 100));
    }, [getEffectiveScale]);

    const toggleActualSize = useCallback(() => {
        setManualScale((prev) => (prev === null ? 1 : null));
    }, []);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const pdfUrl = params.get("pdfUrl");
        const id = params.get("id");

        if (id) setDocumentId(id);

        if (pdfUrl) {
            setStatusMessage("Loading document from server…");
            fetch(pdfUrl)
                .then((res) => {
                    if (!res.ok) throw new Error("Network file validation error.");
                    return res.arrayBuffer();
                })
                .then(async (buffer) => {
                    setPdfBytes(buffer);
                    const parsedName = pdfUrl.split("/").pop() || "document.pdf";
                    setFileName(parsedName);

                    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
                    setPdfDocument(pdf);
                    setNumPages(pdf.numPages);
                    setHistory([[]]);
                    setHistoryIndex(0);
                    setManualScale(null);
                    setStatusMessage("Document loaded.");
                })
                .catch((err) => {
                    console.error(err);
                    setStatusMessage("Couldn't load that document.");
                });
        }
    }, []);

    const handleDimensionsUpdate = (
        pageNum: number,
        width: number,
        height: number,
        nativeWidth: number,
        nativeHeight: number,
    ) => {
        pageDimensionsRef.current[pageNum] = { width, height, nativeWidth, nativeHeight };
    };

    const getCoordinates = (event: React.PointerEvent<SVGSVGElement>, pageNum: number): Point => {
        const svgElement = event.currentTarget;
        const rect = svgElement.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const dimensions = pageDimensionsRef.current[pageNum] || { width: rect.width, height: rect.height };
        return {
            x: x * (dimensions.width / rect.width),
            y: y * (dimensions.height / rect.height),
        };
    };

    const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => {
        if (!isDrawMode) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDrawing(true);
        setActivePage(pageNum);

        const pt = getCoordinates(event, pageNum);
        setCurrentPoints([pt]);
    };

    const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => {
        if (!isDrawing || !isDrawMode || activePage !== pageNum) return;
        const pt = getCoordinates(event, pageNum);
        setCurrentPoints((prev) => [...prev, pt]);
    };

    // Pushes a new annotation snapshot onto the history stack, discarding any redo states beyond it.
    const commitAnnotations = useCallback(
        (next: AnnotationPayload[]) => {
            setHistory((prev) => {
                const trimmed = prev.slice(0, historyIndex + 1);
                return [...trimmed, next];
            });
            setHistoryIndex((idx) => idx + 1);
        },
        [historyIndex],
    );

    const handlePointerUp = (_event: React.PointerEvent<SVGSVGElement>, pageNum: number) => {
        if (!isDrawing || activePage !== pageNum) return;
        setIsDrawing(false);

        if (currentPoints.length > 1) {
            const dimensions = pageDimensionsRef.current[pageNum] || { width: 600, height: 800 };

            const dString = currentPoints.reduce((acc, pt, index) => {
                return index === 0 ? `M${pt.x},${pt.y}` : `${acc} L${pt.x},${pt.y}`;
            }, "");

            const newAnnotation: AnnotationPayload = {
                page: pageNum,
                width: dimensions.width,
                height: dimensions.height,
                d: dString,
                color,
                strokeWidth,
                opacity: tool === "highlighter" ? 0.4 : 1.0,
            };

            commitAnnotations([...annotations, newAnnotation]);
        }
        setCurrentPoints([]);
        setActivePage(null);
    };

    const currentPathD = useMemo(() => {
        return currentPoints.reduce((acc, pt, index) => {
            return index === 0 ? `M${pt.x},${pt.y}` : `${acc} L${pt.x},${pt.y}`;
        }, "");
    }, [currentPoints]);

    const undo = useCallback(() => setHistoryIndex((idx) => Math.max(0, idx - 1)), []);
    const redo = useCallback(() => setHistoryIndex((idx) => Math.min(history.length - 1, idx + 1)), [history.length]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (!pdfDocument) return;
            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;
            const key = e.key.toLowerCase();
            if (key === "z" && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if ((key === "z" && e.shiftKey) || key === "y") {
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [pdfDocument, undo, redo]);

    // Selecting an active tool a second time deselects it and drops back into navigate/grab mode.
    const handleToolSelect = (selectedTool: "pen" | "highlighter") => {
        if (tool === selectedTool) {
            setTool(null);
            return;
        }
        setTool(selectedTool);
        if (selectedTool === "highlighter") {
            setColor("#ffd60a");
            setStrokeWidth(16);
        } else {
            setColor("#f4511e");
            setStrokeWidth(3);
        }
    };

    const handleClearAll = () => {
        if (annotations.length === 0) return;
        commitAnnotations([]);
    };

    // Helper utility to safely convert standard hex representations to structural pdf-lib RGB fractions
    const hexToRgbColor = (hexString: string) => {
        const cleanHex = hexString.replace("#", "");
        const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
        const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
        const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
        return rgb(isNaN(r) ? 1 : r, isNaN(g) ? 0.317 : g, isNaN(b) ? 0 : b);
    };

    const handleSaveAndUpload = async () => {
        if (!pdfBytes) return;
        setStatusMessage("Applying your markup to the PDF…");

        try {
            const doc = await PDFDocument.load(new Uint8Array(pdfBytes));
            const pages = doc.getPages();

            annotations.forEach((ann) => {
                const index = ann.page - 1;
                if (index < 0 || index >= pages.length) return;

                const page = pages[index];
                const { width: pdfWidth, height: pdfHeight } = page.getSize();
                const commands = ann.d.split(/(?=[ML])/);
                let currentPos: Point | null = null;

                commands.forEach((cmd) => {
                    const type = cmd[0];
                    const coords = cmd.slice(1).split(",").map(Number);
                    if (coords.length < 2 || isNaN(coords[0]) || isNaN(coords[1])) return;

                    const screenPt: Point = { x: coords[0], y: coords[1] };
                    const pdfPt: Point = {
                        x: (screenPt.x / ann.width) * pdfWidth,
                        y: (1 - screenPt.y / ann.height) * pdfHeight,
                    };

                    if (type === "M") {
                        currentPos = pdfPt;
                    } else if (type === "L" && currentPos) {
                        page.drawLine({
                            start: { x: currentPos.x, y: currentPos.y },
                            end: { x: pdfPt.x, y: pdfPt.y },
                            thickness: ann.strokeWidth,
                            color: hexToRgbColor(ann.color),
                            opacity: ann.opacity,
                        });
                        currentPos = pdfPt;
                    }
                });
            });

            const modifiedBytes = await doc.save();
            const blob = new Blob([modifiedBytes], { type: "application/pdf" });
            const localUrl = URL.createObjectURL(blob);

            const link = document.createElement("a");
            link.href = localUrl;
            link.download = `revised_${fileName}`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            setTimeout(() => {
                URL.revokeObjectURL(localUrl);
            }, 250);

            if (documentId) {
                setStatusMessage("Syncing changes back to the server…");
                const formData = new FormData();
                formData.append("file", blob, fileName);
                formData.append("annotations", JSON.stringify(annotations));

                const response = await fetch(`http://localhost:3000/files/${documentId}/revise`, {
                    method: "POST",
                    body: formData,
                });

                if (response.ok) {
                    setStatusMessage("Changes saved.");
                } else {
                    throw new Error("Failed to synchronize file revisions.");
                }
            } else {
                setStatusMessage("Document exported.");
            }
        } catch (err) {
            console.error("Save processing failed details:", err);
            setStatusMessage("Something went wrong while saving. Please try again.");
        }
    };

    const handleLocalFileLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setFileName(file.name);
        setHistory([[]]);
        setHistoryIndex(0);
        setTool(null);
        setManualScale(null);
        const buffer = await file.arrayBuffer();
        setPdfBytes(buffer);

        try {
            const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
            setPdfDocument(pdf);
            setNumPages(pdf.numPages);
            setStatusMessage("Document loaded.");
        } catch (err) {
            console.error("Error loading PDF binary container layout:", err);
            setStatusMessage("That file couldn't be opened. Please try a different PDF.");
        }
    };

    const hasDocument = Boolean(pdfBytes && pdfDocument);

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
                            {hasDocument && (
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
                                onChange={handleLocalFileLoad}
                                className="file-input"
                            />
                        </label>

                        {hasDocument && (
                            <>
                                <div className="seg-group" role="group" aria-label="Tools">
                                    {isTouchDevice && (
                                        <button
                                            type="button"
                                            onClick={() => setTool(null)}
                                            className={`seg-btn ${!isDrawMode ? "seg-btn-active" : ""}`}
                                            title="Pan and scroll">
                                            <Hand size={16} />
                                            <span className="btn-label">Pan</span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => handleToolSelect("pen")}
                                        className={`seg-btn ${tool === "pen" ? "seg-btn-active" : ""}`}
                                        title="Pen">
                                        <PenLine size={16} />
                                        <span className="btn-label">Pen</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleToolSelect("highlighter")}
                                        className={`seg-btn ${tool === "highlighter" ? "seg-btn-active" : ""}`}
                                        title="Highlighter">
                                        <Highlighter size={16} />
                                        <span className="btn-label">Highlight</span>
                                    </button>
                                </div>

                                <div className="icon-cluster">
                                    <button
                                        type="button"
                                        onClick={undo}
                                        disabled={!canUndo}
                                        className="icon-btn"
                                        title="Undo (Ctrl+Z)"
                                        aria-label="Undo">
                                        <Undo2 size={17} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={redo}
                                        disabled={!canRedo}
                                        className="icon-btn"
                                        title="Redo (Ctrl+Shift+Z)"
                                        aria-label="Redo">
                                        <Redo2 size={17} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleClearAll}
                                        disabled={annotations.length === 0}
                                        className="icon-btn icon-btn-danger"
                                        title="Clear all markup"
                                        aria-label="Clear all markup">
                                        <Trash2 size={17} />
                                    </button>
                                </div>

                                <div className="icon-cluster">
                                    <button
                                        type="button"
                                        onClick={zoomOut}
                                        className="icon-btn"
                                        title="Zoom out"
                                        aria-label="Zoom out">
                                        <ZoomOut size={17} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={toggleActualSize}
                                        className="zoom-label"
                                        title={
                                            manualScale === null ?
                                                "Showing fit width — click for true original size"
                                            :   "Click to fit the page to your screen"
                                        }>
                                        {manualScale === null ? "Fit" : `${Math.round(manualScale * 100)}%`}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={zoomIn}
                                        className="icon-btn"
                                        title="Zoom in"
                                        aria-label="Zoom in">
                                        <ZoomIn size={17} />
                                    </button>
                                </div>

                                <button type="button" onClick={handleSaveAndUpload} className="btn btn-primary">
                                    <Download size={16} />
                                    <span className="btn-label">Export PDF</span>
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {hasDocument && isDrawMode && (
                    <div className="config-bar">
                        <div className="config-item">
                            <span className="config-label">Color</span>
                            <input
                                type="color"
                                value={color}
                                onChange={(e) => setColor(e.target.value)}
                                className="swatch-input"
                                aria-label="Stroke color"
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
                                aria-label="Stroke thickness"
                            />
                            <span className="config-value">{strokeWidth}px</span>
                        </div>

                        <span className="badge">{tool === "pen" ? "Pen" : "Highlighter"} active</span>
                    </div>
                )}
            </header>

            {statusMessage && <div className="status-bar">{statusMessage}</div>}

            <div className="viewport" ref={viewportRef}>
                {!hasDocument ?
                    <div className="empty-state">
                        <div className="empty-icon">
                            <FileText size={28} strokeWidth={1.5} />
                        </div>
                        <p className="empty-title">No PDF open yet</p>
                        <p className="empty-copy">
                            Open a local file above, or load one with a <code>?pdfUrl=</code> link parameter.
                        </p>
                    </div>
                :   Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNum) => (
                        <PdfPage
                            key={pageNum}
                            pageNum={pageNum}
                            pdfDocument={pdfDocument!}
                            sizing={sizing}
                            isDrawMode={isDrawMode}
                            annotations={annotations}
                            isDrawing={isDrawing}
                            activePage={activePage}
                            currentPathD={currentPathD}
                            currentColor={color}
                            currentStrokeWidth={strokeWidth}
                            currentTool={tool}
                            handlePointerDown={handlePointerDown}
                            handlePointerMove={handlePointerMove}
                            handlePointerUp={handlePointerUp}
                            onDimensionsUpdate={handleDimensionsUpdate}
                        />
                    ))
                }
            </div>
        </div>
    );
}

const STYLES = `
:root {
    --bg: #f1f2f6;
    --surface: #ffffff;
    --border: #e3e4ea;
    --text: #16171c;
    --text-soft: #6b6e76;
    --accent: #f4511e;
    --accent-soft: #fff1ec;
    --danger: #d7263d;
    --radius: 12px;
}

* { box-sizing: border-box; }

.app-shell {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
}

.toolbar {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    box-shadow: 0 1px 0 rgba(16, 17, 22, 0.02);
    z-index: 10;
}

.toolbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 20px;
    flex-wrap: wrap;
}

.brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

.brand-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    flex-shrink: 0;
}

.brand-text {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
    min-width: 0;
}

.brand-title {
    font-weight: 700;
    font-size: 14.5px;
    color: var(--text);
}

.brand-file {
    font-size: 12px;
    color: var(--text-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
}

.toolbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}

.btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 14px;
    border-radius: 9px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
    white-space: nowrap;
}

.btn:active { transform: scale(0.97); }

.btn-ghost {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
}

.btn-ghost:hover { background: #f7f7f9; }

.btn-primary {
    background: var(--accent);
    color: #fff;
}

.btn-primary:hover { background: #e0440f; }

.file-btn { position: relative; }

.file-input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
}

.seg-group {
    display: flex;
    background: #eeeef2;
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
}

.seg-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text-soft);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
}

.seg-btn:hover { color: var(--text); }

.seg-btn-active {
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 1px 3px rgba(16, 17, 22, 0.12);
}

.icon-cluster {
    display: flex;
    align-items: center;
    gap: 2px;
    background: #f7f7f9;
    border-radius: 10px;
    padding: 3px;
}

.icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    transition: background-color 0.15s ease, opacity 0.15s ease;
}

.icon-btn:hover:not(:disabled) { background: #e9e9ed; }

.icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}

.icon-btn-danger:hover:not(:disabled) {
    background: #fdeaec;
    color: var(--danger);
}

.zoom-label {
    min-width: 44px;
    height: 32px;
    padding: 0 6px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.zoom-label:hover { background: #e9e9ed; }

.config-bar {
    display: flex;
    align-items: center;
    gap: 22px;
    padding: 10px 20px;
    background: #fafafc;
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
}

.config-item {
    display: flex;
    align-items: center;
    gap: 9px;
}

.config-item-grow {
    flex: 1;
    min-width: 160px;
}

.config-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-soft);
    flex-shrink: 0;
}

.config-value {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-soft);
    flex-shrink: 0;
    min-width: 34px;
}

.swatch-input {
    border: 1px solid var(--border);
    border-radius: 7px;
    width: 30px;
    height: 26px;
    padding: 0;
    cursor: pointer;
    background: transparent;
}

.slider-input {
    cursor: pointer;
    flex: 1;
    accent-color: var(--accent);
}

.badge {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 5px 10px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.02em;
}

.status-bar {
    padding: 8px 20px;
    background: #fff8e8;
    color: #8a6300;
    font-size: 12.5px;
    font-weight: 500;
    border-bottom: 1px solid #f3e7c4;
}

.viewport {
    flex: 1;
    overflow-y: auto;
    overflow-x: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 28px 12px 60px;
    gap: 24px;
}

.empty-state {
    margin-top: 14vh;
    max-width: 360px;
    text-align: center;
    color: var(--text-soft);
}

.empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--accent);
    margin-bottom: 14px;
}

.empty-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 6px;
}

.empty-copy {
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
}

.empty-copy code {
    background: #e9e9ed;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
}

.sheet {
    position: relative;
    background: var(--surface);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    box-shadow: 0 12px 28px rgba(16, 17, 22, 0.08);
    overflow: hidden;
    flex-shrink: 0;
}

.sheet-label {
    position: absolute;
    top: 10px;
    left: 10px;
    background: rgba(22, 23, 28, 0.78);
    color: #fff;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    z-index: 2;
    backdrop-filter: blur(2px);
}

.sheet-canvas {
    width: 100%;
    height: 100%;
    display: block;
}

.sheet-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    touch-action: none;
    z-index: 1;
}

@media (max-width: 720px) {
    .toolbar-row { padding: 10px 14px; }
    .btn-label { display: none; }
    .btn { padding: 8px 10px; }
    .brand-file { max-width: 120px; }
    .config-bar { padding: 10px 14px; gap: 14px; }
    .viewport { padding: 18px 8px 48px; gap: 16px; }
}
`;
