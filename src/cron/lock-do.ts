import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

interface LockState {
  holder_id: string;
  acquired_at: number;
  expires_at: number;
}

/**
 * Distributed Lock pro Cron-Job (eindeutiger Single-Writer dank DO-Garantie).
 * Lock-Holder schreibt eine ULID + TTL. Andere bekommen 423/Locked-Body, bis TTL abgelaufen ist.
 */
export class CronLockDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname;

    if (action === "/acquire") {
      const { holder_id, ttl_sec } = (await req.json()) as { holder_id: string; ttl_sec: number };
      // Atomares Acquire (#S-003).
      return await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const existing = await this.ctx.storage.get<LockState>("lock");
        if (existing && existing.expires_at > now && existing.holder_id !== holder_id) {
          return Response.json({ acquired: false, holder_id: existing.holder_id, expires_at: existing.expires_at }, { status: 423 });
        }
        const next: LockState = { holder_id, acquired_at: now, expires_at: now + ttl_sec * 1000 };
        await this.ctx.storage.put("lock", next);
        return Response.json({ acquired: true, ...next });
      });
    }

    if (action === "/release") {
      const { holder_id } = (await req.json()) as { holder_id: string };
      return await this.ctx.blockConcurrencyWhile(async () => {
        const existing = await this.ctx.storage.get<LockState>("lock");
        if (existing && existing.holder_id === holder_id) {
          await this.ctx.storage.delete("lock");
        }
        return Response.json({ released: true });
      });
    }

    if (action === "/state") {
      const existing = await this.ctx.storage.get<LockState>("lock");
      return Response.json(existing ?? null);
    }

    return new Response("not found", { status: 404 });
  }
}
