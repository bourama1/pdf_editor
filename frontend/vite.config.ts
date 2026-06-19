import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Explicitly assign configuration to resolve module compilation edge cases
const config = defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
    },
});

export default config;
