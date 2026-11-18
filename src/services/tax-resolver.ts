import { and, gt, isNull, lte, or, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { tax_rules } from "../db/schema/tax";
import { resolveTax, type TaxInput, type TaxResult } from "../engines/tax";

export async function resolveTaxFromDb(db: DB, tenant_id: string, input: TaxInput): Promise<TaxResult> {
  const rows = await db
    .select()
    .from(tax_rules)
    .where(and(
      or(eq(tax_rules.tenant_id, tenant_id), isNull(tax_rules.tenant_id)),
      lte(tax_rules.valid_from, input.on_date),
      or(isNull(tax_rules.valid_to), gt(tax_rules.valid_to, input.on_date)),
    ));
  return resolveTax(input, rows);
}
