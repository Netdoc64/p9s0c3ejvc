import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function rpc(msg: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
  });
}

describe("MCP-Protokoll", () => {
  it("nimmt notifications/initialized an (202, kein Body) — jeder Client schickt sie nach initialize", async () => {
    const res = await rpc({ method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("beantwortet ping mit leerem Ergebnis", async () => {
    const res = await rpc({ id: 7, method: "ping" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("initialize nennt Protokollversion und Tools-Fähigkeit", async () => {
    const res = await rpc({ id: 1, method: "initialize", params: {} });
    const body = await res.json() as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.capabilities.tools).toBeDefined();
  });
});
