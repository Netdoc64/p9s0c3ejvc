import { ProductCreateSchema, type ProductCreate } from "../schemas/product";
import type { DB } from "../db/client";
import { products } from "../db/schema/products";
import { newId } from "../lib/ids";

export interface ImportReport {
  imported_ok: number;
  imported_failed: Array<{ line: number; field?: string; code: string; detail: string }>;
  duration_ms: number;
  header_warning?: string;
}

const BATCH_SIZE = 50;
const REQUIRED_HEADERS = ["sku_code", "name"] as const;
const KNOWN_HEADERS = new Set([
  "sku_code", "name", "description", "tax_class", "parent_sku_id",
  "is_perishable", "default_shelf_life_days", "min_order_qty",
  "packaging_units", "attributes",
]);

/**
 * Streaming CSV-Import. Erste Zeile = Header.
 * Erwartet Spalten: sku_code, name, tax_class, ggf. parent_sku_id, description,
 * packaging_units (JSON-encoded), attributes (JSON-encoded), is_perishable,
 * default_shelf_life_days, min_order_qty.
 */
export async function importCsvStream(db: DB, tenant_id: string, body: ReadableStream<Uint8Array>): Promise<ImportReport> {
  const t0 = performance.now();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lineNumber = 0;
  let header: string[] | null = null;
  const failed: ImportReport["imported_failed"] = [];
  let okCount = 0;
  let pending: ProductCreate[] = [];

  const reader = body.getReader();
  const flushBatch = async () => {
    if (pending.length === 0) return;
    const now = new Date().toISOString();
    const rows = pending.map((p) => ({
      id: newId("product"),
      tenant_id,
      sku_code: p.sku_code,
      parent_sku_id: p.parent_sku_id ?? null,
      name: p.name,
      description: p.description ?? null,
      tax_class: p.tax_class,
      is_perishable: p.is_perishable ? 1 : 0,
      default_shelf_life_days: p.default_shelf_life_days ?? null,
      min_order_qty: p.min_order_qty,
      packaging_units: JSON.stringify(p.packaging_units),
      attributes: JSON.stringify(p.attributes),
      status: "active",
      created_at: now,
      updated_at: now,
    }));
    try {
      // D1 insert returning rowsAffected
      await db.insert(products).values(rows).onConflictDoNothing();
      okCount += rows.length;
    } catch (err) {
      // batch failed → re-attempt as single inserts to isolate offender
      for (let i = 0; i < rows.length; i++) {
        try {
          await db.insert(products).values(rows[i] as typeof rows[number]).onConflictDoNothing();
          okCount += 1;
        } catch (e) {
          failed.push({
            line: -1,
            code: "GH-INFRA-002",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
      void err;
    }
    pending = [];
  };

  let headerWarning: string | undefined;
  const handleLine = (raw: string) => {
    lineNumber += 1;
    if (raw.trim().length === 0) return;
    const cells = parseCsvLine(raw);
    if (header === null) {
      header = cells.map((c) => c.toLowerCase().trim());
      // Schema-Drift-Detection: required headers prüfen, unknown headers melden
      const missing = REQUIRED_HEADERS.filter((h) => !header!.includes(h));
      if (missing.length > 0) {
        // Fatal: ohne required headers können wir nichts importieren
        failed.push({
          line: 1,
          field: "header",
          code: "GH-INPUT-001",
          detail: `CSV header missing required columns: ${missing.join(", ")}. Got: ${header.join(", ")}`,
        });
        // Setze header auf [], dann werden alle Datenzeilen rejected mit klarem Hinweis
        header = [];
        return;
      }
      const unknown = header.filter((h) => h && !KNOWN_HEADERS.has(h));
      if (unknown.length > 0) {
        headerWarning = `Unbekannte Spalten ignoriert: ${unknown.join(", ")}. Bekannt: ${[...KNOWN_HEADERS].join(", ")}`;
      }
      return;
    }
    if (header.length === 0) {
      // Header-Drift fatal: alle Datenzeilen abblocken
      failed.push({ line: lineNumber, code: "GH-INPUT-001", detail: "header invalid, see line 1" });
      return;
    }
    const obj: Record<string, string> = {};
    header.forEach((col, i) => { obj[col] = cells[i] ?? ""; });
    const candidate: Record<string, unknown> = {
      sku_code: obj.sku_code,
      name: obj.name,
      description: obj.description || undefined,
      tax_class: obj.tax_class || "standard",
      parent_sku_id: obj.parent_sku_id || undefined,
      is_perishable: obj.is_perishable === "true" || obj.is_perishable === "1",
      default_shelf_life_days: obj.default_shelf_life_days ? Number(obj.default_shelf_life_days) : undefined,
      min_order_qty: obj.min_order_qty ? Number(obj.min_order_qty) : 1,
    };
    try { candidate.packaging_units = obj.packaging_units ? JSON.parse(obj.packaging_units) : []; } catch { candidate.packaging_units = []; }
    try { candidate.attributes = obj.attributes ? JSON.parse(obj.attributes) : {}; } catch { candidate.attributes = {}; }

    const parsed = ProductCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      failed.push({
        line: lineNumber,
        field: issue?.path.join(".") ?? undefined,
        code: "GH-INPUT-001",
        detail: issue?.message ?? "validation failed",
      });
      return;
    }
    pending.push(parsed.data);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      handleLine(line);
      if (pending.length >= BATCH_SIZE) await flushBatch();
    }
    if (done) {
      if (buffer.length > 0) handleLine(buffer);
      buffer = "";
      break;
    }
  }
  await flushBatch();

  const report: ImportReport = {
    imported_ok: okCount,
    imported_failed: failed,
    duration_ms: Math.round(performance.now() - t0),
  };
  if (headerWarning) report.header_warning = headerWarning;
  return report;
}

/** Minimaler CSV-Parser. Unterstützt double-quoted fields mit `""`-Escape und Komma als Delimiter. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === ",") {
      out.push(cur); cur = "";
    } else if (ch === '"') {
      inQuotes = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
