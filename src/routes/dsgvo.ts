import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { pseudonymizeCustomer, exportCustomerData } from "../services/dsgvo";
import { rateLimit } from "../middleware/rate-limit";

export const dsgvoRoutes = new Hono<AppContext>();

// #P-010: Rate-Limit auf DSGVO-Mutations.
dsgvoRoutes.use("/pseudonymize-customer", rateLimit({ class: "write_critical" }));

const PseudonymizeSchema = z.object({
  customer_id: z.string().startsWith("cust_"),
  // #V-011: längere reason für DSGVO-Audit-Compliance.
  reason: z.string().min(20).max(500),
}).strict();

dsgvoRoutes.post("/pseudonymize-customer", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const body = await c.req.json();
  const parsed = PseudonymizeSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const result = await pseudonymizeCustomer(db, {
    tenant_id,
    customer_id: parsed.data.customer_id,
    reason: parsed.data.reason,
    actor_id: c.var.api_key_id,
  });
  return c.json(result, 200);
});

/**
 * DSGVO Art. 15+20: Customer-Datenexport (#P-009).
 */
dsgvoRoutes.get("/customer-export/:id", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const id = c.req.param("id");
  if (!id.startsWith("cust_")) throw new CodedError("GH-INPUT-001", { reason: "id must start with cust_" });
  const db = getDb(c.env.DB);
  const result = await exportCustomerData(db, { tenant_id, customer_id: id });
  return c.json(result, 200, {
    "Content-Disposition": `attachment; filename="customer-export-${id}.json"`,
  });
});
