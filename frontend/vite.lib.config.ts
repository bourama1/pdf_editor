import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";

export default defineConfig({
    plugins: [react(), dts({ rollupTypes: true, tsconfigPath: "./tsconfig.json" })],
    build: {
        outDir: "dist-lib",
        emptyOutDir: true,
        lib: {
            entry: "src/index.ts",
            formats: ["es"],
            fileName: "pdf-editor",
        },
        rollupOptions: {
            // leave the pdf.worker.mjs?url asset import bundled; only externalize
            // the actual package imports so consumers supply them via node_modules
            external: ["react", "react/jsx-runtime", "react-dom", "pdf-lib", "pdfjs-dist", "lucide-react"],
        },
    },
});
