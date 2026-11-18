import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { CodedError, isCodedError, lookup } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";
import type { DeliveryInput, ReturnCommand, SupplierHandoff } from "../schemas/returns";
import { sendSupplierHandoff, type ReturnActor, type ReturnRequest } from "../services/returns";
import { restockReturn, validateReturnStock } from "../services/stock";

type RequestData = ReturnRequest & { tenant_id: string; order_id: string };
type DeliveryPosition = DeliveryInput["positions"][number] & { sku_id: string };
type Supplier = NonNullable<DeliveryPosition["suppliers"]>[number];
type Decision = Pick<Extract<ReturnCommand, { type: "decide" }>, "outcome" | "return_qty" | "warehouse_id">;
type Inspection = { restock_qty: number; stock_ref?: string };
type Receipt = { receipt_ref: string; qty: number; inspection?: Inspection };
type Work = {
  decision?: Decision;
  receipts: Receipt[];
  settlement?: { booking_ref: string; document_ref: string; doc_type: "credit_note" | "replacement" };
};
type SupplierWork = Work & { handoff_id: string; supplier_note?: string };

interface Line {
  id: string;
  delivery_line_id: string;
  order_line_no: number;
  sku_id: string;
  qty: number;
  suppliers?: Supplier[];
  current_hop: number;
  pending?: { command_key: string; handoff?: SupplierHandoff };
  customer: Work;
  supplier_work: SupplierWork[];
}

interface ReturnCase {
  id: string;
  order_id: string;
  customer_id: string;
  version: number;
  kind: "return" | "complaint";
  reason: string;
  evidence_refs: string[];
  created_at: string;
  lines: Line[];
}

type Result = { id: string; version: number };
type CommandRecord = { fingerprint: string; result?: unknown };

const unavailable = () => new CodedError("GH-RET-001");
const conflict = (reason: string) => new CodedError("GH-RET-002", { reason });
const storageKey = (...parts: string[]) => JSON.stringify(parts);

export class ReturnsDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const data = await request.json<RequestData>();
    try {
      return await this.ctx.blockConcurrencyWhile(async () => {
        try {
          return Response.json(await this.handle(data));
        } catch (error) {
          if (!isCodedError(error)) throw error;
          return Response.json({ code: error.code, details: error.detail }, { status: lookup(error.code).http_status });
        }
      });
    } catch (error) {
      console.error("returns.operation_failed", { action: data.action, error });
      return Response.json({ code: "GH-INFRA-001" }, { status: 503 });
    }
  }

  private async handle(data: RequestData): Promise<unknown> {
    switch (data.action) {
      case "delivery": return this.recordDelivery(data);
      case "create": return this.create(data);
      case "command": return this.apply(data);
      case "get": return this.view(await this.requireCase(data.case_id), data.actor);
      case "deliveries": {
        const deliveries = await this.ctx.storage.list<DeliveryPosition>({
          prefix: "delivery:", limit: 51, ...(data.after && { startAfter: `delivery:${data.after}` }),
        });
        const values = [...deliveries.values()];
        return {
          items: values.slice(0, 50).map(({ delivery_line_id, order_line_no, qty }) => ({ delivery_line_id, order_line_no, qty })),
          next: values.length > 50 ? values[49]?.delivery_line_id : null,
        };
      }
      case "list": {
        const cases = await this.ctx.storage.list<ReturnCase>({
          prefix: "case:", limit: 21, ...(data.after && { startAfter: `case:${data.after}` }),
        });
        const values = [...cases.values()];
        return {
          items: values.slice(0, 20).map((item) => this.view(item, data.actor)),
          next: values.length > 20 ? values[19]?.id : null,
        };
      }
    }
  }

  private async requireCase(id: string): Promise<ReturnCase> {
    const item = await this.ctx.storage.get<ReturnCase>(`case:${id}`);
    if (!item) throw unavailable();
    return item;
  }

  private async commandRecord(data: Extract<RequestData, { input: unknown }>, caseId = "") {
    const key = storageKey("command", data.actor.role, data.actor.id, data.action, caseId, data.input.command_id);
    const fingerprint = await sha256Hex(JSON.stringify(data.input));
    const stored = await this.ctx.storage.get<CommandRecord>(key);
    if (stored && stored.fingerprint !== fingerprint) throw new CodedError("GH-IDEMP-001");
    return { key, fingerprint, stored };
  }

  private async recordDelivery(data: Extract<RequestData, { action: "delivery" }>) {
    const command = await this.commandRecord(data);
    if (command.stored) return command.stored.result;
    const writes: Record<string, unknown> = {};
    const orderLines = new Map(data.lines.map((line) => [line.line_no, line]));
    const totals = new Map<number, number>();
    for (const position of data.input.positions) {
      const key = `delivery:${position.delivery_line_id}`;
      const line = orderLines.get(position.order_line_no);
      if (!line) throw conflict("unknown_order_line");
      if (writes[key] || await this.ctx.storage.get(key)) throw conflict("delivery_line_exists");
      this.checkRoute(data.tenant_id, position.suppliers);
      const totalKey = storageKey("delivered", String(line.line_no));
      const total = (totals.get(line.line_no) ?? await this.ctx.storage.get<number>(totalKey) ?? 0) + position.qty;
      if (total > line.qty) throw conflict("delivery_exceeds_order");
      totals.set(line.line_no, total);
      writes[totalKey] = total;
      writes[key] = { ...position, sku_id: line.sku_id } satisfies DeliveryPosition;
    }
    const result = { positions: data.input.positions.map(({ delivery_line_id }) => delivery_line_id) };
    writes[command.key] = { fingerprint: command.fingerprint, result };
    await this.ctx.storage.put(writes);
    return result;
  }

  private async create(data: Extract<RequestData, { action: "create" }>): Promise<unknown> {
    const command = await this.commandRecord(data);
    if (command.stored) return command.stored.result;
    const item: ReturnCase = {
      id: newId("return_case"), order_id: data.order_id, customer_id: data.customer_id, version: 1,
      kind: data.input.kind, reason: data.input.reason, evidence_refs: data.input.evidence_refs,
      created_at: new Date().toISOString(), lines: [],
    };
    const writes: Record<string, unknown> = {};
    for (const requested of data.input.positions) {
      const delivery = await this.ctx.storage.get<DeliveryPosition>(`delivery:${requested.delivery_line_id}`);
      if (!delivery) throw conflict("delivery_line_unknown");
      const key = storageKey("claimed", requested.delivery_line_id);
      if (key in writes) throw conflict("duplicate_delivery_line");
      const claimed = (await this.ctx.storage.get<number>(key) ?? 0) + requested.qty;
      if (claimed > delivery.qty) throw conflict("return_exceeds_delivery");
      writes[key] = claimed;
      item.lines.push({
        id: newId("return_line"), delivery_line_id: delivery.delivery_line_id, order_line_no: delivery.order_line_no,
        sku_id: delivery.sku_id, qty: requested.qty, suppliers: delivery.suppliers, current_hop: -1,
        customer: { receipts: [] }, supplier_work: [],
      });
    }
    const result: Result = { id: item.id, version: item.version };
    writes[`case:${item.id}`] = item;
    writes[command.key] = { fingerprint: command.fingerprint, result };
    await this.ctx.storage.put(writes);
    return result;
  }

  private async apply(data: Extract<RequestData, { action: "command" }>): Promise<unknown> {
    const item = await this.requireCase(data.case_id);
    const { input, actor } = data;
    const line = item.lines.find(({ id }) => id === input.line_id);
    if (!line) throw unavailable();
    const command = await this.commandRecord(data, item.id);
    this.authorizeCommand(actor, line, input, !!command.stored?.result);
    if (command.stored?.result) return command.stored.result;
    // An external operation can be retried after unrelated positions moved the case version.
    if (!command.stored && item.version !== input.version) {
      throw new CodedError("GH-RET-002", { reason: "case_version_changed", version: item.version });
    }
    if (line.pending && line.pending.command_key !== command.key) throw conflict("line_operation_pending");

    const writes: Record<string, unknown> = {};
    switch (input.type) {
      case "route": {
        if (line.suppliers) throw conflict("supplier_route_already_set");
        this.checkRoute(data.tenant_id, input.suppliers);
        const deliveryKey = `delivery:${line.delivery_line_id}`;
        const delivery = await this.ctx.storage.get<DeliveryPosition>(deliveryKey);
        if (!delivery) throw conflict("delivery_line_unknown");
        if (delivery.suppliers && JSON.stringify(delivery.suppliers) !== JSON.stringify(input.suppliers)) {
          throw conflict("supplier_route_already_set");
        }
        writes[deliveryKey] = { ...delivery, suppliers: input.suppliers } satisfies DeliveryPosition;
        line.suppliers = input.suppliers;
        break;
      }
      case "handoff":
        await this.handoff(data, item, line, command, input.supplier_note);
        break;
      case "decide": {
        const work = this.workFor(line, input.side, actor);
        if (work.decision) throw conflict("already_decided");
        if (input.return_qty > line.qty || !!input.return_qty !== !!input.warehouse_id ||
          (input.outcome === "rejected" && input.return_qty > 0)) throw conflict("invalid_return_decision");
        work.decision = { outcome: input.outcome, return_qty: input.return_qty, warehouse_id: input.warehouse_id };
        break;
      }
      case "receive": {
        const work = this.workFor(line, input.side, actor);
        const allowed = work.decision?.return_qty ?? 0;
        const received = work.receipts.reduce((sum, receipt) => sum + receipt.qty, 0);
        if (received + input.qty > allowed) throw conflict("receipt_exceeds_authorization");
        await this.markBusinessRef(writes, input.side, "receipt", actor, input.receipt_ref, line);
        work.receipts.push({ receipt_ref: input.receipt_ref, qty: input.qty });
        break;
      }
      case "inspect": {
        const work = this.workFor(line, input.side, actor);
        const receipt = work.receipts.find(({ receipt_ref }) => receipt_ref === input.receipt_ref);
        if (!receipt || receipt.inspection || input.restock_qty > receipt.qty) throw conflict("invalid_inspection");
        const restocked = [line.customer, ...line.supplier_work].flatMap(({ receipts }) => receipts)
          .reduce((sum, entry) => sum + (entry.inspection?.restock_qty ?? 0), 0);
        if (restocked + input.restock_qty > line.qty) throw conflict("stock_release_exceeds_claim");
        const remoteStock = input.side === "supplier" && input.restock_qty > 0;
        if (remoteStock !== !!input.stock_ref) throw conflict("invalid_stock_reference");
        if (input.best_before && (input.side !== "customer" || !input.restock_qty)) throw conflict("unexpected_best_before");
        if (input.stock_ref) await this.markBusinessRef(writes, input.side, "stock", actor, input.stock_ref, line);
        if (input.restock_qty && input.side === "customer") {
          const warehouse = work.decision?.warehouse_id;
          if (!warehouse) throw conflict("receiving_warehouse_missing");
          const movementId = await sha256Hex(JSON.stringify([item.id, line.id, receipt.receipt_ref]));
          if (!command.stored) await validateReturnStock(this.env, data.tenant_id, line.sku_id, input.best_before);
          await this.prepare(item, line, command);
          await restockReturn(this.env, {
            tenant_id: data.tenant_id, warehouse_id: warehouse, sku_id: line.sku_id, qty: input.restock_qty,
            movement_id: movementId, best_before: input.best_before,
          });
          receipt.inspection = { restock_qty: input.restock_qty, stock_ref: `return-stock:${movementId}` };
        } else {
          receipt.inspection = { restock_qty: input.restock_qty, stock_ref: input.stock_ref };
        }
        break;
      }
      case "settle": {
        const work = this.workFor(line, input.side, actor);
        const outcome = work.decision?.outcome;
        if (!outcome || outcome === "rejected" || work.settlement) throw conflict("settlement_not_allowed");
        await this.markBusinessRef(writes, input.side, "settlement", actor, input.booking_ref, line);
        work.settlement = { booking_ref: input.booking_ref, document_ref: input.document_ref, doc_type: outcome };
        break;
      }
    }

    delete line.pending;
    item.version++;
    const result: Result = { id: item.id, version: item.version };
    writes[`case:${item.id}`] = item;
    writes[command.key] = { fingerprint: command.fingerprint, result };
    await this.ctx.storage.put(writes);
    return result;
  }

  private checkRoute(owner: string, suppliers: Supplier[] | undefined) {
    if (suppliers?.some(({ tenant_id }) => tenant_id === owner)) throw conflict("supplier_route_cycle");
  }

  private authorizeCommand(actor: ReturnActor, line: Line, command: ReturnCommand, replay: boolean) {
    if (actor.role === "b2b" && (command.type === "handoff" || command.type === "route" || command.side === "customer")) return;
    if (actor.role === "supplier" && (command.type === "handoff" || (command.type !== "route" && command.side === "supplier"))) {
      const assigned = line.suppliers?.findIndex(({ tenant_id }) => tenant_id === actor.id) ?? -1;
      if (assigned >= 0 && assigned <= line.current_hop &&
        (command.type !== "handoff" || assigned === line.current_hop || replay)) return;
    }
    throw unavailable();
  }

  private workFor(line: Line, side: "customer" | "supplier", actor: ReturnActor): Work {
    if (side === "customer") return line.customer;
    const assigned = line.suppliers?.findIndex(({ tenant_id }) => tenant_id === actor.id) ?? -1;
    const work = line.supplier_work[assigned];
    if (!work) throw unavailable();
    return work;
  }

  private async handoff(
    data: RequestData, item: ReturnCase, line: Line, command: { key: string; fingerprint: string }, supplierNote?: string,
  ) {
    const next = line.suppliers?.[line.current_hop + 1];
    if (!next || line.supplier_work[line.current_hop]?.decision || (line.current_hop >= 0 && data.actor.role === "b2b")) {
      throw conflict("handoff_not_allowed");
    }
    const payload: SupplierHandoff = line.pending?.handoff ?? {
      handoff_id: newId("return_handoff"),
      owner_tenant_id: data.tenant_id, supplier_tenant_id: next.tenant_id, purchase_line_ref: next.purchase_line_ref,
      order_id: item.order_id, case_id: item.id, line_id: line.id, qty: line.qty, kind: item.kind, supplier_note: supplierNote,
    };
    await this.prepare(item, line, command, payload);
    await sendSupplierHandoff(this.env, payload);
    line.current_hop++;
    line.supplier_work.push({ receipts: [], handoff_id: payload.handoff_id, supplier_note: payload.supplier_note });
  }

  private async prepare(
    item: ReturnCase, line: Line, command: { key: string; fingerprint: string }, handoff?: SupplierHandoff,
  ) {
    if (line.pending) return;
    line.pending = { command_key: command.key, handoff };
    await this.ctx.storage.put({
      [`case:${item.id}`]: item,
      [command.key]: { fingerprint: command.fingerprint },
    });
  }

  private async markBusinessRef(
    writes: Record<string, unknown>, side: string, type: string, actor: ReturnActor, ref: string, line: Line,
  ) {
    // B2B API keys can rotate or be replaced. The booking belongs to the owner's business.
    const issuer = actor.role === "b2b" ? "owner" : actor.id;
    const key = storageKey("business", side, type, issuer, ref, line.delivery_line_id);
    if (await this.ctx.storage.get(key)) throw conflict("business_reference_already_used");
    writes[key] = line.id;
  }

  private view(item: ReturnCase, actor: ReturnActor) {
    const base = { id: item.id, order_id: item.order_id, kind: item.kind, version: item.version, created_at: item.created_at };
    if (actor.role === "supplier") {
      const lines = item.lines.flatMap((line) => {
        const assigned = line.suppliers?.findIndex(({ tenant_id }) => tenant_id === actor.id) ?? -1;
        const work = line.supplier_work[assigned];
        if (!work) return [];
        return [{
          id: line.id, qty: line.qty, purchase_line_ref: line.suppliers?.[assigned]?.purchase_line_ref,
          state: assigned < line.current_hop ? "forwarded" : line.pending?.handoff ? "handoff_pending" : "assigned",
          work: this.workView(work),
        }];
      });
      if (!lines.length) throw unavailable();
      return { ...base, lines };
    }
    if (actor.role === "customer" && actor.id !== item.customer_id) throw unavailable();
    const lines = item.lines.map((line) => {
      const common = {
        id: line.id, delivery_line_id: line.delivery_line_id, order_line_no: line.order_line_no, qty: line.qty,
        customer: this.workView(line.customer),
      };
      if (actor.role === "customer") return common;
      return {
        ...common,
        sku_id: line.sku_id, suppliers: line.suppliers,
        current_supplier: line.suppliers?.[line.current_hop]?.tenant_id,
        routing: line.pending?.handoff ? "handoff_pending" : line.current_hop >= 0 ? "assigned" : line.suppliers ? "ready" : "manual_review",
        supplier: this.workView(line.supplier_work[line.current_hop] ?? { receipts: [] }),
        supplier_work: line.supplier_work.map((work, index) => ({
          tenant_id: line.suppliers?.[index]?.tenant_id, ...this.workView(work),
        })),
        stock_release_pending: !!line.pending && !line.pending.handoff,
      };
    });
    return {
      ...base, reason: item.reason, evidence_refs: item.evidence_refs, lines,
      ...(actor.role === "b2b" && { customer_id: item.customer_id }),
    };
  }

  private workView(work: Work) {
    const decision = work.decision;
    const receiptComplete = !decision?.return_qty || (
      work.receipts.every(({ inspection }) => !!inspection) &&
      work.receipts.reduce((sum, { qty }) => sum + qty, 0) === decision.return_qty
    );
    const status = !decision ? "pending" : decision.outcome === "rejected" ? "rejected" :
      receiptComplete && work.settlement ? "closed" : "approved";
    return { ...work, status };
  }
}
