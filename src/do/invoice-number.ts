import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

interface InvoiceNumberState {
  next_number: number;
  prefix: string;
  year: number;
  schema_version: 1;
}

/**
 * Single-DO pro Tenant für lückenlose Rechnungsnummern unter Concurrency.
 * D1-Row-Update kann in Race-Condition Lücken produzieren — DO garantiert Single-Writer.
 */
export class InvoiceNumberDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/next") {
      // Atomare read-modify-write um Duplikat-Rechnungsnummern zu vermeiden (#S-001).
      // blockConcurrencyWhile pausiert alle anderen Events bis das storage.put durch ist.
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.loadOrInit();
        const currentYear = new Date().getUTCFullYear();
        if (state.year !== currentYear) {
          state.year = currentYear;
          state.next_number = 1;
        }
        const num = state.next_number;
        state.next_number = num + 1;
        await this.ctx.storage.put("state", state);
        return { num, year: state.year, prefix: state.prefix };
      });
      const formatted = `${result.prefix}-${result.year}-${String(result.num).padStart(6, "0")}`;
      return Response.json({ invoice_number: formatted, raw_number: result.num, year: result.year });
    }

    if (url.pathname === "/init") {
      const body = (await req.json()) as { prefix?: string; start_at?: number };
      const state: InvoiceNumberState = {
        next_number: body.start_at ?? 1,
        prefix: body.prefix ?? "INV",
        year: new Date().getUTCFullYear(),
        schema_version: 1,
      };
      await this.ctx.storage.put("state", state);
      return Response.json({ initialized: true, state });
    }

    if (url.pathname === "/state") {
      const s = await this.ctx.storage.get<InvoiceNumberState>("state");
      return Response.json(s ?? null);
    }

    return new Response("not found", { status: 404 });
  }

  private async loadOrInit(): Promise<InvoiceNumberState> {
    let s = await this.ctx.storage.get<InvoiceNumberState>("state");
    if (!s) {
      s = { next_number: 1, prefix: "INV", year: new Date().getUTCFullYear(), schema_version: 1 };
      await this.ctx.storage.put("state", s);
    }
    return s;
  }
}
