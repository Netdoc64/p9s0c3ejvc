import { ReturnsSupplierInbox as Inbox } from "../../src/index";
export { default } from "../../src/index";
export * from "../../src/index";

const lost = new Set<string>();

export class ReturnsSupplierInbox extends Inbox {
  override async fetch(request: Request): Promise<Response> {
    const body = await request.clone().json<{ handoff_id: string; purchase_line_ref: string }>();
    const response = await super.fetch(request);
    if (response.ok && body.purchase_line_ref === "lose-first-ack" && !lost.has(body.handoff_id)) {
      lost.add(body.handoff_id);
      await response.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return new Response(null, { status: 504 });
    }
    return response;
  }
}
