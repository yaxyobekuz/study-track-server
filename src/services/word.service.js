/**
 * WORD (.docx) QURUVCHI — `excel.service.js` ning ko'zgusi.
 *
 * ⚠️ NIMA UCHUN KUTUBXONA EMAS: `.docx` — bu ZIP ichidagi bir nechta XML
 * fayl (OOXML). Loyihada ZIP yozuvchi ALLAQACHON bor (`jszip`, ExcelJS
 * bilan birga keladi va endi to'g'ridan-to'g'ri e'lon qilingan), hujjatning
 * o'zi esa sarlavha + paragraf + jadvaldan iborat. Katta kutubxona qo'shish
 * shu uchta elementni yozish uchun butun bir API va uning versiya tarixini
 * loyihaga olib kirardi.
 *
 * ⚠️ HTML NI ".doc" QILIB YUBORISH EMAS: u ko'p joyda uchraydigan yo'l,
 * lekin Word 2013 dan boshlab "fayl formati kengaytmasiga mos emas,
 * shikastlangan bo'lishi mumkin" degan OGOHLANTIRISH bilan ochiladi.
 * Rahbarga boradigan hisobot shunday xabar bilan ochilmasligi kerak.
 *
 * Hujjat MODEL sifatida beriladi (`blocks`), XML ni esa faqat shu fayl
 * yozadi — chaqiruvchi service'larda birorta `<w:` belgisi bo'lmaydi.
 *
 *   buildDocx({ title, blocks: [
 *     { type: "heading", level: 1, text: "..." },
 *     { type: "paragraph", text: "...", bold: true, align: "center" },
 *     { type: "table", columns: [{ label, width, align }], rows: [[...]] },
 *     { type: "spacer" },
 *   ]})
 *
 * Yangi sahifadan boshlash — blokning o'zida: `pageBreakBefore: true`.
 */

const JSZip = require("jszip");
const { getTashkentDateUtc } = require("../helpers/date.helpers");

/** A4 portret, twip (1/1440 dyuym): 210×297 mm. */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
/** Chet — 20 mm. */
const MARGIN = 1134;
/** Matn uchun qoladigan kenglik — jadval ustunlari shunga bo'linadi. */
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Sarlavha darajalari: o'lcham yarim-punktda (28 = 14pt). */
const HEADING_SIZES = { 1: 32, 2: 26, 3: 23 };

const ALIGN = { left: "left", center: "center", right: "right", justify: "both" };

/**
 * XML dagi maxsus belgilar. ⚠️ Boshqaruv belgilari (masalan `\u0000`)
 * OLIB TASHLANADI: XML 1.0 ularni umuman qabul qilmaydi va bitta bunday
 * belgi butun faylni Word uchun yaroqsiz qilardi.
 */
const esc = (value) =>
  String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// ─────────────────────────────────────────────
// Elementlar
// ─────────────────────────────────────────────

/**
 * Matn bo'lagi (`run`). Yangi qator `\n` bilan beriladi va `<w:br/>` ga
 * aylanadi — aks holda u faylda bitta uzun qator bo'lib qolardi.
 */
const runXml = (text, style = {}) => {
  const props = [
    style.bold ? "<w:b/>" : "",
    style.italic ? "<w:i/>" : "",
    style.color ? `<w:color w:val="${esc(style.color)}"/>` : "",
    style.size ? `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>` : "",
  ].join("");

  const parts = String(text ?? "").split("\n");
  const body = parts
    .map((part, index) => `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(part)}</w:t>`)
    .join("");

  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
};

/**
 * ⚠️ SAHIFA UZILISHI — `pageBreakBefore`, ALOHIDA "break" paragrafi EMAS.
 *
 * Alohida paragraf ichidagi `<w:br w:type="page"/>` ning o'zi bir qator
 * joy egallaydi: oldingi sahifa to'lib qolgan bo'lsa, u YANGI sahifaga
 * tushadi va keyin uzilishni bajaradi — natijada o'rtada BO'SH sahifa
 * qoladi (sinovda aynan shunday bo'lgan). `pageBreakBefore` esa qoidani
 * paragrafning O'ZIGA bog'laydi: "shu sarlavha yangi sahifadan
 * boshlansin", qo'shimcha qatorsiz.
 */
const paragraphXml = (text, style = {}) => {
  const props = [
    style.pageBreakBefore ? "<w:pageBreakBefore/>" : "",
    style.align && ALIGN[style.align] ? `<w:jc w:val="${ALIGN[style.align]}"/>` : "",
    `<w:spacing w:before="${style.before ?? 0}" w:after="${style.after ?? 80}" w:line="260" w:lineRule="auto"/>`,
  ].join("");

  const content =
    text === "" || text == null ? "" : runXml(text, style);

  return `<w:p><w:pPr>${props}</w:pPr>${content}</w:p>`;
};

const headingXml = (text, level = 1, style = {}) =>
  paragraphXml(text, {
    bold: true,
    size: HEADING_SIZES[level] ?? HEADING_SIZES[3],
    before: level === 1 ? 0 : 240,
    after: 120,
    align: style.align ?? (level === 1 ? "center" : "left"),
    color: style.color ?? "111827",
    pageBreakBefore: style.pageBreakBefore,
  });

/**
 * Ustun kengliklari — NISBIY og'irliklardan sahifa kengligiga keltiriladi.
 *
 * ⚠️ Yig'indi AYNAN `CONTENT_WIDTH` ga tenglashtiriladi (oxirgi ustunga
 * qoldiq beriladi): yaxlitlash tufayli bir-ikki twip kam bo'lsa, Word
 * jadvalni sahifa chetidan surib chizadi va o'ng chegara "qiyshiq"
 * ko'rinadi.
 */
const resolveWidths = (columns) => {
  const weights = columns.map((col) => Number(col.width) || 1);
  const sum = weights.reduce((acc, w) => acc + w, 0);

  const widths = weights.map((w) => Math.floor((w / sum) * CONTENT_WIDTH));
  const used = widths.reduce((acc, w) => acc + w, 0);
  widths[widths.length - 1] += CONTENT_WIDTH - used;

  return widths;
};

const cellXml = (cell, width, column) => {
  const value = cell && typeof cell === "object" ? cell : { text: cell };
  const align = value.align ?? column.align ?? "left";

  const shade = value.fill
    ? `<w:shd w:val="clear" w:color="auto" w:fill="${esc(value.fill)}"/>`
    : "";

  return (
    "<w:tc>" +
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}` +
    '<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>' +
    '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar>' +
    '<w:vAlign w:val="center"/></w:tcPr>' +
    paragraphXml(value.text, {
      align,
      bold: value.bold,
      italic: value.italic,
      color: value.color,
      size: value.size ?? 19,
      after: 0,
    }) +
    "</w:tc>"
  );
};

const BORDER = (color) =>
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${color}"/>`)
    .join("");

/**
 * Jadval.
 *
 * ⚠️ Sarlavha qatorida `<w:tblHeader/>` bor — jadval ikkinchi sahifaga
 * o'tsa, Word ustun nomlarini QAYTA chizadi. Busiz uzun ro'yxatning
 * ikkinchi sahifasi nomsiz ustunlar bo'lib qolardi.
 */
const tableXml = ({ columns, rows, headerFill = "F3F4F6" }) => {
  const widths = resolveWidths(columns);

  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");

  const headerCells = columns
    .map((col, index) =>
      cellXml(
        { text: col.label, bold: true, fill: headerFill, align: col.headerAlign ?? col.align ?? "left" },
        widths[index],
        col,
      ),
    )
    .join("");

  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((col, index) => cellXml(row[index], widths[index], col))
        .join("");
      return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
    })
    .join("");

  return (
    "<w:tbl><w:tblPr>" +
    `<w:tblW w:w="${CONTENT_WIDTH}" w:type="dxa"/>` +
    `<w:tblBorders>${BORDER("D1D5DB")}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    "</w:tblPr>" +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headerCells}</w:tr>` +
    bodyRows +
    "</w:tbl>" +
    // ⚠️ Jadvaldan keyin BO'SH PARAGRAF shart: ikki jadval yonma-yon
    // tursa Word ularni BITTA jadvalga qo'shib yuboradi.
    '<w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>'
  );
};

const blockXml = (block) => {
  switch (block?.type) {
    case "heading":
      return headingXml(block.text, block.level ?? 2, block);
    case "paragraph":
      return paragraphXml(block.text, block);
    case "table":
      return tableXml(block);
    case "spacer":
      return '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>';
    default:
      return "";
  }
};

// ─────────────────────────────────────────────
// Paket
// ─────────────────────────────────────────────

const documentXml = (blocks) =>
  `${XML_HEAD}<w:document ${W_NS}><w:body>` +
  blocks.map(blockXml).join("") +
  `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>` +
  `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}"` +
  ' w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>' +
  "</w:body></w:document>";

/**
 * ⚠️ SHRIFT — Times New Roman: hujjat rasmiy hisobot sifatida chop
 * etiladi. O'lcham 11pt (22 yarim-punkt), jadvalda 9.5pt.
 */
const stylesXml = () =>
  `${XML_HEAD}<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr>` +
  '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/>' +
  "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>" +
  '<w:spacing w:after="80" w:line="260" w:lineRule="auto"/>' +
  "</w:pPr></w:pPrDefault></w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
  '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/></w:tblPr></w:style>' +
  "</w:styles>";

const CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const DOC_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const corePropsXml = ({ title, author }) => {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `${XML_HEAD}<cp:coreProperties ` +
    'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dc:creator>${esc(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
};

const APP_PROPS = `${XML_HEAD}<Properties ` +
  'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>MBSI</Application><DocSecurity>0</DocSecurity>" +
  "</Properties>";

/**
 * Hujjat modelidan `.docx` baytlarini quradi.
 *
 * @param {{title: string, author?: string, blocks: Array<object>}} doc
 * @returns {Promise<Buffer>}
 */
const buildDocx = async ({ title = "Hisobot", author = "MBSI", blocks = [] }) => {
  const zip = new JSZip();

  // ⚠️ `[Content_Types].xml` BIRINCHI yoziladi: ba'zi o'quvchilar (Word
  // ning eski versiyalari ham) uni paketning birinchi yozuvi deb kutadi.
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("docProps/core.xml", corePropsXml({ title, author }));
  zip.file("docProps/app.xml", APP_PROPS);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  zip.file("word/document.xml", documentXml(blocks));
  zip.file("word/styles.xml", stylesXml());

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
};

/**
 * Faylni yuborish — nomi `<baseName>_<Toshkent kuni>.docx`.
 *
 * `Content-Disposition` — ASCII zaxira nom + UTF-8 asl nom (RFC 5987),
 * `excel.service.js` → `sendWorkbookAs` bilan AYNI qoida: nomda
 * apostrof va kirill bo'lishi mumkin, Node esa sarlavhada 255 dan katta
 * belgini rad etadi.
 *
 * @param {import("express").Response} res
 * @param {Buffer} buffer
 * @param {string} baseName
 * @param {{fallbackName?: string}} [options]
 */
const sendDocx = (res, buffer, baseName, { fallbackName = "hisobot" } = {}) => {
  const day = getTashkentDateUtc().toISOString().slice(0, 10);
  const utf8Name = `${baseName}_${day}.docx`;
  const asciiName = `${
    baseName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/_-+|-+_/g, "_")
      .replace(/^-+|-+$/g, "") || fallbackName
  }_${day}.docx`;
  const encoded = encodeURIComponent(utf8Name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
  );
  res.setHeader("Content-Length", buffer.length);

  res.end(buffer);
};

module.exports = { buildDocx, sendDocx };
