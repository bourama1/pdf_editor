// Regression check: pdf-lib's StandardFonts only support WinAnsi encoding,
// which is missing Czech caron letters (č, ř, š, ž, ě, ď, ť, ň) and made
// text-box saves throw. Run with: node scripts/verify-unicode-font.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const fontBytes = readFileSync(
    new URL("../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf", import.meta.url),
);
const font = await doc.embedFont(fontBytes, { subset: true });

const page = doc.addPage();
page.drawText("čřšžěáýíé ĎŤŇ", { x: 50, y: 700, size: 20, font });

const bytes = await doc.save();
assert(bytes.length > 0, "expected non-empty PDF output");

console.log("OK: Czech diacritics embedded and saved,", bytes.length, "bytes");
