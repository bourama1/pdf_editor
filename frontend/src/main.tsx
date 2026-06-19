import React from "react";
import ReactDOM from "react-dom/client";
import PdfEditor from "./components/PdfEditor";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <div>
            <PdfEditor />
        </div>
    </React.StrictMode>,
);
