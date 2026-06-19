import React, { useState, useRef, useEffect, useMemo } from "react";
import { PDFDocument, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";

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

interface PageProps {
    pageNum: number;
    pdfDocument: pdfjsLib.PDFDocumentProxy;
    mode: "navigate" | "draw";
    annotations: AnnotationPayload[];
    isDrawing: boolean;
    activePage: number | null;
    currentPathD: string;
    currentColor: string;
    currentStrokeWidth: number;
    currentTool: "pen" | "highlighter";
    handlePointerDown: (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => void;
    handlePointerMove: (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => void;
    handlePointerUp: (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => void;
    onDimensionsUpdate: (pageNum: number, width: number, height: number) => void;
}

function PdfPage({
    pageNum,
    pdfDocument,
    mode,
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

    useEffect(() => {
        let isMounted = true;

        const renderPage = async () => {
            try {
                const page = await pdfDocument.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.25 });

                if (!isMounted) return;

                setDimensions({ width: viewport.width, height: viewport.height });
                onDimensionsUpdate(pageNum, viewport.width, viewport.height);

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
    }, [pdfDocument, pageNum]);

    return (
        <div
            style={{
                ...styles.sheetContainer,
                width: `${dimensions.width}px`,
                height: `${dimensions.height}px`,
            }}>
            <div style={styles.labelIndicator}>Sheet {pageNum}</div>
            <canvas ref={canvasRef} style={styles.nativeDisplayCanvas} />

            <svg
                style={{ ...styles.drawVectorOverlay, pointerEvents: mode === "draw" ? "auto" : "none" }}
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
    const [mode, setMode] = useState<"navigate" | "draw">("navigate");

    // Dynamic configuration studio state parameters
    const [tool, setTool] = useState<"pen" | "highlighter">("pen");
    const [color, setColor] = useState<string>("#ff5100");
    const [strokeWidth, setStrokeWidth] = useState<number>(3);

    const [annotations, setAnnotations] = useState<AnnotationPayload[]>([]);
    const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
    const [isDrawing, setIsDrawing] = useState<boolean>(false);
    const [activePage, setActivePage] = useState<number | null>(null);
    const [statusMessage, setStatusMessage] = useState<string>("");

    const pageDimensionsRef = useRef<{ [page: number]: { width: number; height: number } }>({});

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const pdfUrl = params.get("pdfUrl");
        const id = params.get("id");

        if (id) setDocumentId(id);

        if (pdfUrl) {
            setStatusMessage("Streaming targeted file contents from remote server...");
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
                    setStatusMessage("Document binary loaded successfully.");
                })
                .catch((err) => {
                    console.error(err);
                    setStatusMessage("Failed to parse external document stream.");
                });
        }
    }, []);

    const handleDimensionsUpdate = (pageNum: number, width: number, height: number) => {
        pageDimensionsRef.current[pageNum] = { width, height };
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
        if (mode !== "draw") return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDrawing(true);
        setActivePage(pageNum);

        const pt = getCoordinates(event, pageNum);
        setCurrentPoints([pt]);
    };

    const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>, pageNum: number) => {
        if (!isDrawing || mode !== "draw" || activePage !== pageNum) return;
        const pt = getCoordinates(event, pageNum);
        setCurrentPoints((prev) => [...prev, pt]);
    };

    const handlePointerUp = (_event: React.PointerEvent<SVGSVGElement>, pageNum: number) => {
        if (!isDrawing || activePage !== pageNum) return;
        setIsDrawing(false);

        if (currentPoints.length > 0) {
            const dimensions = pageDimensionsRef.current[pageNum] || { width: 600, height: 800 };

            const dString = currentPoints.reduce((acc, pt, index) => {
                return index === 0 ? `M${pt.x},${pt.y}` : `${acc} L${pt.x},${pt.y}`;
            }, "");

            const newAnnotation: AnnotationPayload = {
                page: pageNum,
                width: dimensions.width,
                height: dimensions.height,
                d: dString,
                color: color,
                strokeWidth: strokeWidth,
                opacity: tool === "highlighter" ? 0.4 : 1.0,
            };

            setAnnotations((prev) => [...prev, newAnnotation]);
        }
        setCurrentPoints([]);
        setActivePage(null);
    };

    const currentPathD = useMemo(() => {
        return currentPoints.reduce((acc, pt, index) => {
            return index === 0 ? `M${pt.x},${pt.y}` : `${acc} L${pt.x},${pt.y}`;
        }, "");
    }, [currentPoints]);

    // Dynamic layout context tool modification switch
    const handleToolSelect = (selectedTool: "pen" | "highlighter") => {
        setTool(selectedTool);
        setMode("draw");
        if (selectedTool === "highlighter") {
            setColor("#ffff00");
            setStrokeWidth(16);
        } else {
            setColor("#ff5100");
            setStrokeWidth(3);
        }
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
        setStatusMessage("Baking drawings into PDF binary layer...");

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
                setStatusMessage("Syncing changes back to the server database...");
                const formData = new FormData();
                formData.append("file", blob, fileName);
                formData.append("annotations", JSON.stringify(annotations));

                const response = await fetch(`http://localhost:3000/files/${documentId}/revise`, {
                    method: "POST",
                    body: formData,
                });

                if (response.ok) {
                    setStatusMessage("Changes successfully recorded to backend pipeline.");
                } else {
                    throw new Error("Failed to synchronize file revisions.");
                }
            } else {
                setStatusMessage("Document exported locally.");
            }
        } catch (err) {
            console.error("Save processing failed details:", err);
            setStatusMessage("An error occurred while saving the file updates.");
        }
    };

    const handleLocalFileLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setFileName(file.name);
        setAnnotations([]);
        const buffer = await file.arrayBuffer();
        setPdfBytes(buffer);

        try {
            const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
            setPdfDocument(pdf);
            setNumPages(pdf.numPages);
            setStatusMessage("Local file loaded successfully.");
        } catch (err) {
            console.error("Error loading PDF binary container layout:", err);
            setStatusMessage("Failed to initialize local PDF structure.");
        }
    };

    return (
        <div style={styles.appContainer}>
            <div style={styles.topRibbon}>
                <div style={styles.brandTitle}>Web PDF Studio Editor</div>

                <input
                    type="file"
                    accept="application/pdf"
                    onChange={handleLocalFileLoad}
                    style={styles.nativeFileInput}
                />

                {pdfBytes && pdfDocument && (
                    <div style={styles.actionButtonGroup}>
                        <button
                            onClick={() => setMode("navigate")}
                            style={{
                                ...styles.controlBtn,
                                backgroundColor: mode === "navigate" ? "#4a4a4a" : "#e0e0e0",
                                color: mode === "navigate" ? "#fff" : "#000",
                            }}>
                            Hand Navigate
                        </button>

                        <button
                            onClick={() => handleToolSelect("pen")}
                            style={{
                                ...styles.controlBtn,
                                backgroundColor: mode === "draw" && tool === "pen" ? "#ff5100" : "#e0e0e0",
                                color: mode === "draw" && tool === "pen" ? "#fff" : "#000",
                            }}>
                            Pen
                        </button>

                        <button
                            onClick={() => handleToolSelect("highlighter")}
                            style={{
                                ...styles.controlBtn,
                                backgroundColor: mode === "draw" && tool === "highlighter" ? "#e6b800" : "#e0e0e0",
                                color: mode === "draw" && tool === "highlighter" ? "#fff" : "#000",
                            }}>
                            Highlighter
                        </button>

                        <button onClick={() => setAnnotations([])} style={styles.controlBtn}>
                            Clear All
                        </button>

                        <button
                            onClick={handleSaveAndUpload}
                            style={{ ...styles.controlBtn, backgroundColor: "#ff5100", color: "#fff" }}>
                            Save & Export Workflow
                        </button>
                    </div>
                )}
            </div>

            {/* Dynamic Interactive Studio Sub-Toolbar Configurator */}
            {pdfBytes && pdfDocument && mode === "draw" && (
                <div style={styles.brushConfigToolbar}>
                    <div style={styles.configItem}>
                        <label style={styles.configLabel}>Color Picker:</label>
                        <input
                            type="color"
                            value={color}
                            onChange={(e) => setColor(e.target.value)}
                            style={styles.colorWidgetInput}
                        />
                    </div>

                    <div style={styles.configItem}>
                        <label style={styles.configLabel}>Thickness ({strokeWidth}px):</label>
                        <input
                            type="range"
                            min="1"
                            max="50"
                            value={strokeWidth}
                            onChange={(e) => setStrokeWidth(Number(e.target.value))}
                            style={styles.sliderWidgetInput}
                        />
                    </div>

                    <div style={styles.configItem}>
                        <span style={styles.badgeLabel}>Active: {tool.toUpperCase()} Mode</span>
                    </div>
                </div>
            )}

            {statusMessage && <div style={styles.statusBar}>{statusMessage}</div>}

            <div style={styles.viewerViewport}>
                {!pdfBytes || !pdfDocument ?
                    <div style={styles.fallbackNotice}>
                        No target PDF loaded. Stream file using port parameters (?pdfUrl=...) or browse a local file.
                    </div>
                :   Array.from({ length: numPages }, (_, idx) => idx + 1).map((pageNum) => (
                        <PdfPage
                            key={pageNum}
                            pageNum={pageNum}
                            pdfDocument={pdfDocument}
                            mode={mode}
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

const styles: { [key: string]: React.CSSProperties } = {
    appContainer: {
        display: "flex",
        flexDirection: "column",
        width: "100vw",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        backgroundColor: "#f4f4f6",
    },
    topRibbon: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 28px",
        backgroundColor: "#ffffff",
        borderBottom: "1px solid #dcdce0",
        boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
        zIndex: 10,
    },
    brushConfigToolbar: {
        display: "flex",
        alignItems: "center",
        gap: "24px",
        padding: "10px 28px",
        backgroundColor: "#f9f9fb",
        borderBottom: "1px solid #e5e5ea",
        zIndex: 9,
    },
    configItem: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
    },
    configLabel: {
        fontSize: "13px",
        fontWeight: 600,
        color: "#48484a",
    },
    colorWidgetInput: {
        border: "1px solid #d1d1d6",
        borderRadius: "4px",
        width: "32px",
        height: "28px",
        padding: 0,
        cursor: "pointer",
        backgroundColor: "transparent",
    },
    sliderWidgetInput: {
        cursor: "pointer",
        width: "140px",
    },
    badgeLabel: {
        fontSize: "11px",
        fontWeight: 700,
        color: "#555",
        backgroundColor: "#e5e5ea",
        padding: "4px 8px",
        borderRadius: "12px",
    },
    brandTitle: { fontWeight: 700, fontSize: "16px", color: "#1c1c1e" },
    nativeFileInput: { fontSize: "13px" },
    actionButtonGroup: { display: "flex", gap: "10px" },
    controlBtn: {
        padding: "8px 16px",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        fontWeight: 600,
        fontSize: "13px",
        transition: "all 0.15s ease",
    },
    statusBar: {
        padding: "6px 28px",
        backgroundColor: "#ffefe6",
        color: "#ff5100",
        fontSize: "12px",
        fontWeight: 500,
        borderBottom: "1px solid #ffe0cc",
    },
    viewerViewport: {
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "24px 0",
        gap: "24px",
    },
    fallbackNotice: {
        marginTop: "120px",
        color: "#8e8e93",
        fontSize: "14px",
        maxWidth: "400px",
        textAlign: "center",
        lineHeight: "1.5",
    },
    sheetContainer: {
        position: "relative",
        boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
        backgroundColor: "#ffffff",
        borderRadius: "4px",
    },
    labelIndicator: {
        position: "absolute",
        top: "12px",
        left: "12px",
        backgroundColor: "rgba(28,28,30,0.8)",
        color: "#ffffff",
        padding: "4px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        zIndex: 2,
    },
    nativeDisplayCanvas: { width: "100%", height: "100%", display: "block" },
    drawVectorOverlay: {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        background: "transparent",
        touchAction: "none",
        zIndex: 1,
    },
};
