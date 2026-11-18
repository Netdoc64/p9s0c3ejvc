import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { webhook_subscriptions } from "../db/schema/webhooks";
import { newId } from "../lib/ids";
import { randomSecret } from "../lib/crypto";
import { validatePublicHttpsUrl } from "../lib/url-validation";

export const webhooksRoutes = new Hono<AppContext>();

// SSRF-Schutz: HTTPS + Block private/loopback (#T-005)
const CreateSchema = z.object({
  url: z.string().url().refine((u) => validatePublicHttpsUrl(u).ok, {
    message: "url must be https with public hostname (no localhost/private ranges)",
  }),
  topic_filter: z.string().default("*"),
  description: z.string().max(200).optional(),
}).strict();

webhooksRoutes.post("/", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const body = await c.req.json();
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const id = newId("webhook");
  const signing_secret = randomSecret(32);
  const now = new Date().toISOString();
  await db.insert(webhook_subscriptions).values({
    id,
    tenant_id,
    url: parsed.data.url,
    topic_filter: parsed.data.topic_filter,
    signing_secret,
    active: 1,
    description: parsed.data.description ?? null,
    created_at: now,
    updated_at: now,
  });
  return c.json({ id, url: parsed.data.url, topic_filter: parsed.data.topic_filter, signing_secret, active: true }, 201);
});

webhooksRoutes.get("/", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const db = getDb(c.env.DB);
  const rows = await db.select().from(webhook_subscriptions).where(and(eq(webhook_subscriptions.tenant_id, tenant_id), isNull(webhook_subscriptions.deleted_at)));
  return c.json({ items: rows.map((r) => ({ id: r.id, url: r.url, topic_filter: r.topic_filter, active: r.active === 1, description: r.description, created_at: r.created_at })) });
});

webhooksRoutes.delete("/:id", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const now = new Date().toISOString();
  await db.update(webhook_subscriptions).set({ active: 0, deleted_at: now }).where(and(eq(webhook_subscriptions.id, id), eq(webhook_subscriptions.tenant_id, tenant_id)));
  return c.body(null, 204);
});
