import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { invoices } from "../db/schema/invoices";
import { tenants } from "../db/schema/tenants";
import { customers } from "../db/schema/customers";
import { products } from "../db/schema/products";
import { newId } from "../lib/ids";
import { sha256Hex } from "../lib/crypto";
import { CodedError } from "../errors/catalog";
import * as ordersRepo from "../repos/orders";
import { addressLines, generateInvoicePdf } from "./invoice-pdf";

const SIGNED_URL_TTL_CUSTOMER_DAYS = 7;
const SIGNED_URL_TTL_TENANT_DAYS = 90;

export interface GenerateOptions {
  tenant_id: string;
  order_id: string;
}

export async function generateForOrder(env: Env, opts: GenerateOptions): Promise<{ id: string; r2_key: string; invoice_number: string }> {
  const db = getDb(env.DB);
  // Idempotenz: existierende Invoice für (tenant_id, order_id)? Tenant-Filter (#T-003).
  const existing = (await db.select().from(invoices).where(and(eq(invoices.order_id, opts.order_id), eq(invoices.tenant_id, opts.tenant_id))).limit(1))[0];
  if (existing) {
    return { id: existing.id, r2_key: existing.pdf_r2_key ?? "", invoice_number: existing.invoice_number };
  }

  const order = await ordersRepo.requireById(db, opts.tenant_id, opts.order_id);
  // Tenant-Filter inkl. deleted_at-Check (#T-010)
  const tenant = (await db.select().from(tenants).where(and(eq(tenants.id, opts.tenant_id), isNull(tenants.deleted_at))).limit(1))[0];
  if (!tenant) throw new CodedError("GH-TENANT-001");
  // Pflichtangaben des Verkäufers (Art. 226 MwStSysRL). Fehlen sie, wird KEINE
  // Rechnung ausgestellt: eine fehlerhafte Rechnung mit lückenloser Nummer lässt
  // sich nicht still zurückholen. Geprüft VOR der Nummernvergabe, damit keine
  // Nummer verbraucht wird.
  const sellerAddress = addressLines(tenant.address);
  const missing = [!tenant.vat_id && "vat_id", sellerAddress.length === 0 && "address"].filter(Boolean);
  if (missing.length > 0) throw new CodedError("GH-PDF-002", { missing });
  // Customer mit Tenant-Filter (#T-003)
  const customer = (await db.select().from(customers).where(and(eq(customers.id, order.doc.customer_id), eq(customers.tenant_id, opts.tenant_id))).limit(1))[0];
  if (!customer) throw new CodedError("GH-CUST-001");

  // Invoice-Number atomisch via Single-DO pro Tenant (lückenlos unter Concurrency)
  const now = new Date().toISOString();
  const stub = env.INVOICE_NUMBER_DO.get(env.INVOICE_NUMBER_DO.idFromName(opts.tenant_id));
  const numRes = await stub.fetch("https://invoice.local/next", { method: "POST" });
  if (!numRes.ok) throw new CodedError("GH-PDF-001", { reason: "invoice_number_do_unreachable" });
  const numBody = (await numRes.json()) as { invoice_number: string };
  const invoice_number = numBody.invoice_number;

  // Produktbezeichnungen (mandantengetrennt) — die Art der Lieferung ist Pflichtangabe.
  const skuIds = [...new Set(order.doc.lines.map((l) => l.sku_id))];
  const product_names: Record<string, string> = {};
  if (skuIds.length > 0) {
    const rows = await db.select({ id: products.id, name: products.name }).from(products)
      .where(and(eq(products.tenant_id, opts.tenant_id), inArray(products.id, skuIds)));
    for (const r of rows) product_names[r.id] = r.name;
  }

  const pdfBytes = await generateInvoicePdf(order.doc, {
    product_names,
    tenant: { name: tenant.name, country: tenant.country, vat_id: tenant.vat_id ?? undefined, address_lines: sellerAddress },
    customer: { name: customer.name, country: customer.country, vat_id: customer.vat_id, address_lines: addressLines(customer.addresses) },
    invoice_number,
    date: now,
  });
  const hash = await sha256Hex(pdfBytes);
  const r2_key = `${opts.tenant_id}/invoices/${invoice_number}.pdf`;
  await env.ASSETS.put(r2_key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { tenant_id: opts.tenant_id, order_id: opts.order_id, invoice_number, hash },
  });

  const id = newId("invoice");
  await db.insert(invoices).values({
    id,
    tenant_id: opts.tenant_id,
    order_id: opts.order_id,
    invoice_number,
    total_cents: order.doc.totals.total_cents,
    currency: order.doc.totals.currency,
    country: tenant.country,
    pdf_r2_key: r2_key,
    pdf_hash: hash,
    bytes: pdfBytes.byteLength,
    generated_at: now,
    created_at: now,
    updated_at: now,
  });

  return { id, r2_key, invoice_number };
}

export { SIGNED_URL_TTL_CUSTOMER_DAYS, SIGNED_URL_TTL_TENANT_DAYS };
