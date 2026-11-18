/**
 * Production-ready PDF-Generierung via pdf-lib.
 * - Tabellen-Layout für Positionen
 * - Pflichtangaben pro Country (DE/NL/CH)
 * - Reverse-Charge-/Export-Hinweise
 * - Branding-Slot (Tenant-Name als Header)
 *
 * Plan-Revision-Kandidat: Tenant-Logo aus R2 als Image embedden.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { OrderDoc } from "../schemas/order";

export interface InvoiceContext {
  /** Verkäufer: Name, Anschrift und USt-IdNr. sind Pflichtangaben (Art. 226 MwStSysRL). */
  tenant: { name: string; country: string; vat_id?: string; address_lines?: string[] };
  /** Empfänger: Name und Anschrift Pflicht, USt-IdNr. bei Reverse-Charge. */
  customer: { name: string; country: string; vat_id?: string | null; address_lines?: string[] };
  invoice_number: string;
  date: string;
  /** Leistungs-/Lieferdatum (Pflichtangabe). Fehlt es, steht „entspricht Rechnungsdatum“. */
  service_date?: string;
  /** Produktbezeichnung je SKU — die Art der Lieferung ist Pflichtangabe, die SKU-ID allein nicht. */
  product_names?: Record<string, string>;
  notes?: string;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const LINE_HEIGHT = 14;
const HEADER_FONT_SIZE = 18;
const BODY_FONT_SIZE = 10;
const SMALL_FONT_SIZE = 8;

interface DrawCtx {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
}

function newPage(ctx: DrawCtx): DrawCtx {
  const page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return { ...ctx, page, y: PAGE_HEIGHT - MARGIN };
}

function ensureRoom(ctx: DrawCtx, needed: number): DrawCtx {
  if (ctx.y - needed < MARGIN) return newPage(ctx);
  return ctx;
}

function drawLine(ctx: DrawCtx, text: string, opts: { bold?: boolean; size?: number; indent?: number } = {}): DrawCtx {
  const size = opts.size ?? BODY_FONT_SIZE;
  ctx = ensureRoom(ctx, size + 2);
  ctx.page.drawText(sanitizeForWinAnsi(text), {
    x: MARGIN + (opts.indent ?? 0),
    y: ctx.y,
    size,
    font: opts.bold ? ctx.bold : ctx.font,
    color: rgb(0, 0, 0),
  });
  return { ...ctx, y: ctx.y - (size + 4) };
}

function drawHr(ctx: DrawCtx): DrawCtx {
  ctx = ensureRoom(ctx, 6);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  return { ...ctx, y: ctx.y - 8 };
}

/**
 * WinAnsi-safe Sanitizer (#P-001).
 *
 * Helvetica-StandardFonts in pdf-lib unterstützen nur WinAnsi/cp1252-Glyphen.
 * Non-WinAnsi-Chars (Emoji, CJK, Kyrillisch, Arabisch) crashen das Encoding.
 *
 * Strategie: Best-Effort-Transliteration für gängige Sonderzeichen, Rest → "?".
 * Plan-Revision: Custom-Font (Inter/Noto) via embedFont(fontBytes).
 */
const WIN_ANSI_TRANSLATIONS: Record<string, string> = {
  "€": "EUR", "£": "GBP", "¥": "JPY",
  "—": "-", "–": "-", "…": "...",
  "“": "\"", "”": "\"", "‘": "'", "’": "'",
  " ": " ", // nbsp
};

function sanitizeForWinAnsi(s: string): string {
  if (!s) return s;
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (WIN_ANSI_TRANSLATIONS[ch]) {
      out += WIN_ANSI_TRANSLATIONS[ch];
    } else if (code <= 0xFF) {
      // Latin-1 + Latin-1-Supplement passt grob in WinAnsi
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/**
 * UTF-8/16 safe slice (#P-002): nutzt Array.from für Code-Point-Iteration.
 */
function safeSlice(s: string, n: number): string {
  const arr = Array.from(s);
  return arr.length > n ? arr.slice(0, n - 1).join("") + "…" : s;
}

/**
 * Betrag in deutscher Schreibweise: `1.234,50 €`. Die Rechnung ist deutsch
 * beschriftet („Netto“, „Brutto“), also auch die Zahlen. Ganzzahlig gerechnet,
 * kein Float. Nicht-EUR behält den ISO-Code (`12,00 CHF`).
 */
export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const rest = (abs % 100).toString().padStart(2, "0");
  const symbol = currency === "EUR" ? "€" : currency;
  return `${sign}${euros},${rest} ${symbol}`;
}

/** Adresse aus der JSON-Spalte in druckbare Zeilen; Unlesbares ergibt keine Zeile. */
export function addressLines(raw: unknown): string[] {
  let a: unknown = raw;
  if (typeof raw === "string") {
    try { a = JSON.parse(raw); } catch { return []; }
  }
  if (!a || typeof a !== "object") return [];
  const o = ((a as Record<string, unknown>).billing ?? a) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const city = [str(o.postal_code), str(o.city)].filter(Boolean).join(" ");
  return [str(o.line1), str(o.line2), city].filter(Boolean);
}

// Max Lines pro Invoice (#P-003): Worker 128MB Memory + 30s CPU. Über 500 Lines wird's eng.
const MAX_INVOICE_LINES = 500;

export async function generateInvoicePdf(doc: OrderDoc, ctx: InvoiceContext): Promise<Uint8Array> {
  if (doc.lines.length > MAX_INVOICE_LINES) {
    throw new Error(`invoice has ${doc.lines.length} lines, max ${MAX_INVOICE_LINES}`);
  }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let dctx: DrawCtx = {
    doc: pdf,
    page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    font,
    bold,
    y: PAGE_HEIGHT - MARGIN,
  };

  // ---- Header ----
  dctx.page.drawText(sanitizeForWinAnsi(ctx.tenant.name), {
    x: MARGIN, y: dctx.y, size: HEADER_FONT_SIZE, font: bold, color: rgb(0.15, 0.15, 0.15),
  });
  dctx.y -= HEADER_FONT_SIZE + 4;
  for (const l of ctx.tenant.address_lines ?? []) dctx = drawLine(dctx, l, { size: SMALL_FONT_SIZE });
  dctx = drawLine(dctx, `${ctx.tenant.country}${ctx.tenant.vat_id ? ` · USt-IdNr. ${ctx.tenant.vat_id}` : ""}`, { size: SMALL_FONT_SIZE });
  dctx.y -= 8;
  dctx = drawHr(dctx);

  // ---- Invoice Meta ----
  dctx = drawLine(dctx, `Rechnung Nr. ${ctx.invoice_number}`, { bold: true, size: 14 });
  dctx = drawLine(dctx, `Datum: ${ctx.date.slice(0, 10)}`, { size: BODY_FONT_SIZE });
  dctx = drawLine(dctx, ctx.service_date ? `Leistungsdatum: ${ctx.service_date.slice(0, 10)}` : "Leistungsdatum: entspricht Rechnungsdatum", { size: BODY_FONT_SIZE });
  dctx = drawLine(dctx, `Bestell-Nr.: ${doc.meta.id}`, { size: BODY_FONT_SIZE });
  dctx.y -= 8;

  // ---- Customer ----
  dctx = drawLine(dctx, "Rechnungsempfänger:", { bold: true });
  dctx = drawLine(dctx, ctx.customer.name);
  for (const l of ctx.customer.address_lines ?? []) dctx = drawLine(dctx, l);
  dctx = drawLine(dctx, ctx.customer.country);
  if (ctx.customer.vat_id) dctx = drawLine(dctx, `USt-IdNr.: ${ctx.customer.vat_id}`);
  dctx.y -= 8;
  dctx = drawHr(dctx);

  // ---- Lines Table Header ----
  const colX = { line: MARGIN, sku: MARGIN + 30, qty: MARGIN + 230, unit: MARGIN + 280, tax: MARGIN + 360, total: MARGIN + 430 };
  dctx = ensureRoom(dctx, 14);
  for (const [label, x] of [
    ["#", colX.line], ["SKU / Bezeichnung", colX.sku], ["Menge", colX.qty],
    ["Einzelpreis", colX.unit], ["USt", colX.tax], ["Position", colX.total],
  ] as Array<[string, number]>) {
    dctx.page.drawText(label, { x, y: dctx.y, size: 9, font: bold });
  }
  dctx.y -= 12;
  dctx = drawHr(dctx);

  // ---- Lines ----
  for (const l of doc.lines) {
    dctx = ensureRoom(dctx, 14);
    const skuLabel = sanitizeForWinAnsi(safeSlice(ctx.product_names?.[l.sku_id] ?? l.sku_id, 40));
    dctx.page.drawText(String(l.line_no).padStart(2, "0"), { x: colX.line, y: dctx.y, size: 9, font });
    dctx.page.drawText(skuLabel, { x: colX.sku, y: dctx.y, size: 9, font });
    dctx.page.drawText(String(l.qty), { x: colX.qty, y: dctx.y, size: 9, font });
    dctx.page.drawText(formatCents(l.unit_price_cents ?? 0, doc.totals.currency), { x: colX.unit, y: dctx.y, size: 9, font });
    dctx.page.drawText(`${l.tax_rate_pct ?? 0}%`, { x: colX.tax, y: dctx.y, size: 9, font });
    dctx.page.drawText(formatCents(l.line_total_cents ?? 0, doc.totals.currency), { x: colX.total, y: dctx.y, size: 9, font });
    dctx.y -= 12;
  }
  dctx = drawHr(dctx);

  // ---- Totals ----
  const totalCol = colX.total;
  dctx = ensureRoom(dctx, 50);
  dctx.page.drawText("Netto:", { x: totalCol - 80, y: dctx.y, size: 10, font });
  dctx.page.drawText(formatCents(doc.totals.subtotal_cents, doc.totals.currency), { x: totalCol, y: dctx.y, size: 10, font });
  dctx.y -= 14;
  dctx.page.drawText("USt:", { x: totalCol - 80, y: dctx.y, size: 10, font });
  dctx.page.drawText(formatCents(doc.totals.tax_cents, doc.totals.currency), { x: totalCol, y: dctx.y, size: 10, font });
  dctx.y -= 14;
  dctx.page.drawText("Brutto:", { x: totalCol - 80, y: dctx.y, size: 12, font: bold });
  dctx.page.drawText(formatCents(doc.totals.total_cents, doc.totals.currency), { x: totalCol, y: dctx.y, size: 12, font: bold });
  dctx.y -= 22;

  // ---- Country / Scheme Hinweise ----
  const schemes = new Set(doc.lines.map((l) => l.tax_scheme));
  dctx = drawHr(dctx);
  if (schemes.has("reverse_charge_eu")) {
    dctx = drawLine(dctx, "Reverse-Charge gem. Art. 196 MwStSysRL — Steuerschuldnerschaft des Leistungsempfängers.", { size: 9, bold: true });
  }
  if (schemes.has("export")) {
    dctx = drawLine(dctx, "Steuerfreie Ausfuhrlieferung gem. §6 UStG.", { size: 9, bold: true });
  }
  if (ctx.customer.country === "CH") {
    dctx = drawLine(dctx, "Lieferung in die Schweiz — keine deutsche/europäische USt anwendbar.", { size: 9 });
  }
  if (ctx.notes) {
    dctx.y -= 4;
    dctx = drawLine(dctx, `Hinweise: ${ctx.notes}`, { size: 9 });
  }

  // ---- Footer ----
  dctx.y -= 16;
  dctx = drawLine(dctx, `Generiert: ${ctx.date} · order-document/1.0`, { size: SMALL_FONT_SIZE });

  return await pdf.save();
}

