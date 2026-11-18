/**
 * MCP-Smoke gegen einen laufenden Worker — spricht /mcp so an, wie ein
 * MCP-Client (Claude Desktop u. a.) es tut: initialize, initialized-
 * Notification, tools/list, dann Suche → Entwurf → Bestätigung.
 *
 * Erfordert:
 *   GROSSHANDEL_BASE_URL  Worker-URL
 *   GROSSHANDEL_MCP_TOKEN Kunden-Access-Token (Bearer-JWT aus /v1/oauth/token)
 *   GROSSHANDEL_CUSTOMER_ID  der Kunde hinter dem Token (Vorgabe cust_floraly_de)
 */
const baseUrl = process.env.GROSSHANDEL_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.GROSSHANDEL_MCP_TOKEN;
const customerId = process.env.GROSSHANDEL_CUSTOMER_ID ?? "cust_floraly_de";
if (!token) {
  console.error("Bitte GROSSHANDEL_MCP_TOKEN setzen (Kunden-Access-Token).");
  process.exit(1);
}

let nextId = 1;
async function rpc(method: string, params?: unknown, notification = false): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!notification) msg.id = nextId++;
  if (params !== undefined) msg.params = params;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

/** MCP-Spec: tools/call liefert { content: [{ type: "text", text }], structuredContent? }. */
function toolPayload(body: Record<string, unknown> | null, what: string): Record<string, unknown> {
  if (!body || body.error) throw new Error(`${what}: ${JSON.stringify(body?.error ?? body)}`);
  const result = body.result as { content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  if (!Array.isArray(result?.content)) throw new Error(`${what}: Ergebnis ohne content[] (MCP-Spec verletzt): ${JSON.stringify(result).slice(0, 200)}`);
  if (result.isError) throw new Error(`${what}: isError ${result.content[0]?.text}`);
  return result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "{}");
}

async function main(): Promise<void> {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-mcp", version: "1" } });
  if (init.status !== 200) throw new Error(`initialize ${init.status}`);
  console.log("✓ initialize");

  const note = await rpc("notifications/initialized", undefined, true);
  if (note.status !== 202 && note.status !== 200 && note.status !== 204) throw new Error(`notifications/initialized ${note.status}: ${JSON.stringify(note.body)}`);
  console.log(`✓ notifications/initialized (${note.status})`);

  const list = await rpc("tools/list");
  const tools = ((list.body?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
  if (!tools.includes("create_order_draft")) throw new Error(`tools/list: ${JSON.stringify(list.body)}`);
  console.log(`✓ tools/list (${tools.length} Werkzeuge)`);

  const search = toolPayload((await rpc("tools/call", { name: "search_products", arguments: { q: "rose" } })).body, "search_products");
  const skuId = (search.items as Array<{ id: string }>)[0]?.id;
  if (!skuId) throw new Error("search_products: keine Treffer");
  console.log(`✓ search_products → ${skuId}`);

  const draft = toolPayload((await rpc("tools/call", { name: "create_order_draft", arguments: { customer_id: customerId, lines: [{ sku_id: skuId, qty: 5 }] } })).body, "create_order_draft");
  // Kundenansicht (G3): id/state/invoice — kein internes Dokument.
  const doc = draft.doc as { id: string; state: string; blocking: unknown; plan?: unknown; audit?: unknown };
  if (doc.state !== "awaiting_confirmation") throw new Error(`create_order_draft: state=${doc.state} ${JSON.stringify(doc.blocking)}`);
  if (doc.plan !== undefined || doc.audit !== undefined) throw new Error("create_order_draft: internes Dokument nach außen gegeben (plan/audit)");
  console.log(`✓ create_order_draft → ${doc.id} (${doc.state}), nur Kundenansicht`);

  const conf = toolPayload((await rpc("tools/call", { name: "confirm_order", arguments: { order_id: doc.id } })).body, "confirm_order");
  const cdoc = conf.doc as { state: string; invoice: { number: string } | null };
  if (cdoc.state !== "confirmed" || !cdoc.invoice) throw new Error(`confirm_order: ${cdoc.state}, Rechnung ${JSON.stringify(cdoc.invoice)}`);
  console.log(`✓ confirm_order → confirmed, Rechnung ${cdoc.invoice.number}`);

  console.log("\n✓ MCP-Smoke OK");
}

main().catch((err) => {
  console.error("✗ MCP-Smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

export {};
