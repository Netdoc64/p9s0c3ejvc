import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

interface BucketState {
  count: number;
  reset_at: number; // ms epoch
}

/**
 * Strict-Rate-Limit-DO: konsistenter Token-Bucket pro Identifier.
 * Single-Writer-Garantie verhindert eventual-consistency-Burst-Through, das KV
 * für Auth-Login (5/min) zulässt.
 */
export class RateLimitDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/check") {
      const { limit, window_sec } = (await req.json()) as { limit: number; window_sec: number };
      // Atomare Bucket-Updates (#S-004).
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        let state = await this.ctx.storage.get<BucketState>("bucket");
        if (!state || state.reset_at <= now) {
          state = { count: 0, reset_at: now + window_sec * 1000 };
        }
        state.count += 1;
        await this.ctx.storage.put("bucket", state);
        return { state, now };
      });
      const allowed = result.state.count <= limit;
      return Response.json({
        allowed,
        count: result.state.count,
        limit,
        remaining: Math.max(0, limit - result.state.count),
        reset_at: Math.floor(result.state.reset_at / 1000),
        retry_after: allowed ? 0 : Math.max(1, Math.floor((result.state.reset_at - result.now) / 1000)),
      });
    }
    return new Response("not found", { status: 404 });
  }
}
