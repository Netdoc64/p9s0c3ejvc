/**
 * DSGVO-Pseudonymisierungs-Service.
 *
 * Realisiert das M04-OQ-Decision: "Soft-Delete als Default + Pseudonymisierung
 * für DSGVO-Anträge". 10-Jahre-Aufbewahrungspflicht für Bestelldaten vs. Recht
 * auf Vergessenwerden.
 *
 * Strategie:
 *  - PII-Felder (email, phone, name, addresses) werden durch deterministische
 *    Hash-Tags ersetzt (`<sha256:abc12345>`).
 *  - Customer-ID, tenant-Beziehungen und Bestellungen bleiben referenziert.
 *  - `pseudonymized_at` wird gesetzt — markiert den Customer als anonymisiert.
 *  - Audit-Log-Eintrag in customer.metadata.dsgvo[].
 */
import { eq, and } from "drizzle-orm";
import type { DB } from "../db/client";
import { customers } from "../db/schema/customers";
import { sha256Hex } from "../lib/crypto";
import { CodedError } from "../errors/catalog";

export interface PseudonymizeOptions {
  tenant_id: string;
  customer_id: string;
  /** Begründung (DSGVO-Antrag-ID, Datum, Bearbeiter). */
  reason: string;
  actor_id?: string;
}

export interface PseudonymizeResult {
  customer_id: string;
  pseudonymized_at: string;
  fields_replaced: string[];
}

async function tag(value: string): Promise<string> {
  const h = await sha256Hex(value);
  return `<sha256:${h.slice(0, 12)}>`;
}

/**
 * DSGVO Art. 15+20 — Datenexport (#P-009).
 * Liefert ein selbst-konsistentes JSON-Bundle: Customer + Orders + Invoices.
 * Keine Pseudonymisierung — explizit für Auskunfts-Anträge.
 */
export interface ExportOptions {
  tenant_id: string;
  customer_id: string;
}

export async function exportCustomerData(db: DB, opts: ExportOptions): Promise<Record<string, unknown>> {
  const { orders } = await import("../db/schema/orders");
  const { invoices } = await import("../db/schema/invoices");
  const { devices } = await import("../db/schema/devices");
  const cs = await db.select().from(customers).where(and(eq(customers.id, opts.customer_id), eq(customers.tenant_id, opts.tenant_id))).limit(1);
  const customer = cs[0];
  if (!customer) throw new CodedError("GH-CUST-001");

  const orderRows = await db.select().from(orders).where(and(eq(orders.tenant_id, opts.tenant_id), eq(orders.customer_id, opts.customer_id)));
  const invoiceRows = await db.select().from(invoices).where(eq(invoices.tenant_id, opts.tenant_id));
  // Filter Invoices über Order-IDs (kein customer_id auf invoices direkt)
  const orderIds = new Set(orderRows.map((o) => o.id));
  const customerInvoices = invoiceRows.filter((i) => orderIds.has(i.order_id));
  const deviceRows = await db.select().from(devices).where(and(eq(devices.tenant_id, opts.tenant_id), eq(devices.customer_id, opts.customer_id)));

  return {
    schema_version: "dsgvo-export/1.0",
    exported_at: new Date().toISOString(),
    customer: {
      ...customer,
      addresses: customer.addresses ? JSON.parse(customer.addresses) : {},
      metadata: customer.metadata ? JSON.parse(customer.metadata) : {},
    },
    orders: orderRows,
    invoices: customerInvoices,
    devices: deviceRows,
    notes: "Order/Invoice-Daten unterliegen 10-Jahre-Aufbewahrungspflicht (§147 AO) und werden bei Pseudonymisierung NICHT gelöscht.",
  };
}

export async function pseudonymizeCustomer(db: DB, opts: PseudonymizeOptions): Promise<PseudonymizeResult> {
  const rows = await db.select().from(customers).where(and(eq(customers.id, opts.customer_id), eq(customers.tenant_id, opts.tenant_id))).limit(1);
  const c = rows[0];
  if (!c) throw new CodedError("GH-CUST-001");

  const now = new Date().toISOString();
  const metadata = JSON.parse(c.metadata) as Record<string, unknown>;
  const dsgvoLog = (metadata.dsgvo as Array<Record<string, unknown>> | undefined) ?? [];
  dsgvoLog.push({
    pseudonymized_at: now,
    reason: opts.reason,
    actor_id: opts.actor_id,
  });

  const replaced: string[] = [];
  const newName = await tag(c.name);
  replaced.push("name");
  let newEmail: string | null = null;
  if (c.email) { newEmail = await tag(c.email); replaced.push("email"); }
  let newPhone: string | null = null;
  if (c.phone) { newPhone = await tag(c.phone); replaced.push("phone"); }

  // Adressen: alle Strings durch tag-Hashes ersetzen, country/postal_code beibehalten
  // (für Steuer-/Audit-Zwecke wichtig).
  const addresses = JSON.parse(c.addresses) as Record<string, unknown>;
  const pseudonymizedAddresses: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(addresses)) {
    if (val && typeof val === "object") {
      const a = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a)) {
        if (k === "country" || k === "postal_code") out[k] = v;
        else if (typeof v === "string") out[k] = await tag(v);
        else out[k] = v;
      }
      pseudonymizedAddresses[key] = out;
    } else {
      pseudonymizedAddresses[key] = val;
    }
  }
  replaced.push("addresses");

  // Defense-in-Depth: Tenant-Filter im UPDATE (#T-009).
  await db.update(customers).set({
    name: newName,
    email: newEmail,
    phone: newPhone,
    addresses: JSON.stringify(pseudonymizedAddresses),
    metadata: JSON.stringify({ ...metadata, dsgvo: dsgvoLog, pseudonymized_at: now }),
    updated_at: now,
    deleted_at: now, // soft-delete + pseudonymize gemeinsam
  }).where(and(eq(customers.id, opts.customer_id), eq(customers.tenant_id, opts.tenant_id)));

  return { customer_id: opts.customer_id, pseudonymized_at: now, fields_replaced: replaced };
}
