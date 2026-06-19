import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/upload": "http://localhost:3000",
            "/sessions": "http://localhost:3000",
            "/files": "http://localhost:3000",
            "/queue": "http://localhost:3000",
        },
    },
    build: {
        outDir: "../backend/public",
        emptyOutDir: true,
    },
});
