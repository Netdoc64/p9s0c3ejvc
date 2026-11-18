import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { SupplierHandoff } from "../schemas/returns";

// This entrypoint is exposed to service bindings. The default HTTP router never mounts it.
export class ReturnsSupplierInbox extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/handoffs") {
      return new Response(null, { status: 404 });
    }
    const parsed = SupplierHandoff.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });

    const { handoff_id, supplier_tenant_id } = parsed.data;
    const payload = JSON.stringify(parsed.data);
    const stored = await this.env.DB.prepare(`INSERT INTO supplier_return_handoffs (handoff_id, supplier_tenant_id, payload, accepted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (handoff_id) DO UPDATE SET payload = excluded.payload WHERE payload = excluded.payload
      RETURNING handoff_id`)
      .bind(handoff_id, supplier_tenant_id, payload, new Date().toISOString()).first<string>("handoff_id");
    if (stored !== handoff_id) return new Response(null, { status: 409 });
    return Response.json({ handoff_id, accepted: true });
  }
}
