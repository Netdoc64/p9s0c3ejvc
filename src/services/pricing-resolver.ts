import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { DB } from "../db/client";
import { customer_price_list_assignments, customer_special_prices, price_list_items, price_lists, qty_breaks } from "../db/schema/pricing";
import { resolvePricing, type PricingInput, type PricingResult } from "../engines/pricing";
import { CodedError } from "../errors/catalog";

/**
 * Lädt die Preisdaten und ruft die reine Engine.
 *
 * ZWEI BATCHES STATT BIS ZU SECHS EINZELABFRAGEN. Jede D1-Runde kostet ~40 ms
 * (Lasttest 2026-11-17: Preisanfrage p50 268 ms). `db.batch` schickt mehrere
 * Abfragen in EINEM Roundtrip und belegt EINEN Platz in der Warteschlange der
 * Datenbank.
 *
 * NICHT `Promise.all` über Einzelabfragen: das wurde am selben Tag versucht und
 * vervielfachte die gleichzeitigen Anfragen an D1 — unter Last liefen 21 % ALLER
 * Anfragen (auch der Suche, die hier gar nicht beteiligt ist) in Fehler, weil
 * die Warteschlange der Datenbank überlief. D1 verarbeitet Abfragen je
 * Datenbank nacheinander; Parallelität im Worker macht sie nicht schneller.
 *
 * Batch 1: Zuweisung, Standardliste, Sonderpreise (voneinander unabhängig; die
 *          Standardliste wird auf Verdacht mitgeladen — sie gilt nur, wenn keine
 *          aktive zugewiesene Liste existiert, dieselbe Regel wie vorher).
 * Batch 2: zugewiesene Liste (falls nötig), Listeneintrag, Mengenstaffeln.
 */
export async function resolvePricingFromDb(db: DB, input: PricingInput): Promise<PricingResult> {
  // Batch 1 — Tenant-Filter überall (#Q-004)
  const [assignedRows, defaultRows, csps] = await db.batch([
    db.select().from(customer_price_list_assignments).where(and(
      eq(customer_price_list_assignments.tenant_id, input.tenant_id),
      eq(customer_price_list_assignments.customer_id, input.customer_id),
    )).limit(1),
    db.select().from(price_lists).where(and(
      eq(price_lists.tenant_id, input.tenant_id),
      eq(price_lists.is_default, 1),
      isNull(price_lists.archived_at),
      lte(price_lists.valid_from, input.on_date),
      or(isNull(price_lists.valid_to), gt(price_lists.valid_to, input.on_date)),
    )).limit(1),
    db.select().from(customer_special_prices).where(and(
      eq(customer_special_prices.tenant_id, input.tenant_id),
      eq(customer_special_prices.customer_id, input.customer_id),
      eq(customer_special_prices.sku_id, input.sku_id),
    )),
  ]);
  const assigned = assignedRows[0];

  let list = defaultRows[0];
  if (assigned) {
    const assignedList = (await db.select().from(price_lists)
      .where(and(eq(price_lists.id, assigned.price_list_id), isNull(price_lists.archived_at))).limit(1))[0];
    if (assignedList) list = assignedList;
  }
  if (!list) throw new CodedError("GH-PRICE-001", { reason: "no_default_price_list" });

  // Batch 2
  const [itemRows, breaks] = await db.batch([
    db.select().from(price_list_items).where(and(eq(price_list_items.price_list_id, list.id), eq(price_list_items.sku_id, input.sku_id))).limit(1),
    db.select().from(qty_breaks).where(eq(qty_breaks.price_list_id, list.id)),
  ]);

  return resolvePricing(input, {
    customer_special: csps,
    applicable_price_list: list,
    list_item: itemRows[0] ?? null,
    qty_breaks: breaks,
  });
}
