import worker, { StockDO, CronLockDO, InvoiceNumberDO, RateLimitDO } from "../../../src/index";
import { setEmailAdapter } from "../../../src/auth/email";
import { adjust } from "../../../src/services/stock";
import type { Env } from "../../../src/env";

export { StockDO, CronLockDO, InvoiceNumberDO, RateLimitDO };
// Test entry point used only by the localhost integration runner.
const inbox = new Map<string, string>();
setEmailAdapter({ async send(message) { inbox.set(message.to, message.text.match(/\b[2-9A-HJ-NP-Z]{8}\b/)?.[0] ?? ""); } });
export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.hostname === "127.0.0.1" && url.pathname === "/__test/mail") {
      return Response.json({ code: inbox.get(url.searchParams.get("email") ?? "") });
    }
    if (url.hostname === "127.0.0.1" && url.pathname === "/__test/stock" && request.method === "POST") {
      await adjust(env, { tenant_id: "t_mobile_local", warehouse_id: "wh_mobile_local", sku_id: "sku_mobile_rose", qty_delta: 100 });
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, env, ctx);
  },
};
