/// <reference types="vite/client" />

declare module "pdfjs-dist/build/pdf.worker.mjs?url" {
    const src: string;
    export default src;
}

interface Window {
    ReactNativeWebView?: {
        postMessage: (message: string) => void;
    };
}
