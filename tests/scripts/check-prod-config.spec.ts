import { describe, expect, it } from "vitest";
// @ts-expect-error reines ESM-Skript ohne Typen
import { pruefeProdConfig } from "../../scripts/check-prod-config.mjs";

const raw = import.meta.glob("/wrangler.toml", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const aktuell = Object.values(raw)[0]!;
const pf = pruefeProdConfig as (t: string) => string[];

const gut = `
[env.production]
vars = { ENVIRONMENT = "production", WORKER_VERSION = "0.1.0" }
[[env.production.d1_databases]]
binding = "DB"
database_name = "x"
database_id = "11111111-1111-1111-1111-111111111111"
migrations_dir = "migrations"
[[env.production.kv_namespaces]]
binding = "KV"
id = "11111111111111111111111111111111"
[[env.production.send_email]]
name = "EMAIL"
[[env.production.r2_buckets]]
binding = "ASSETS"
bucket_name = "b"
[[env.production.queues.producers]]
binding = "OUTBOX_QUEUE"
queue = "q"
[[env.production.queues.consumers]]
queue = "q"
dead_letter_queue = "q-dlq"
[[env.production.durable_objects.bindings]]
name = "STOCK_DO"
[[env.production.durable_objects.bindings]]
name = "CRON_LOCK_DO"
[[env.production.durable_objects.bindings]]
name = "INVOICE_NUMBER_DO"
[[env.production.durable_objects.bindings]]
name = "RATE_LIMIT_DO"
[[env.production.durable_objects.bindings]]
name = "RETURNS_DO"
`;

describe("check-prod-config", () => {
  it("aktuelle wrangler.toml: Befunde zu DB- und KV-Platzhalter", () => {
    const b = pf(aktuell);
    expect(b.some((x) => x.includes("d1 DB") && x.includes("Platzhalter"))).toBe(true);
    expect(b.some((x) => x.includes("kv KV") && x.includes("Platzhalter"))).toBe(true);
    expect(b).toHaveLength(2);
  });
  it("Fixture mit echten (erfundenen) IDs: keine Befunde", () => {
    expect(pf(gut)).toEqual([]);
  });
  it("ohne RETURNS_DO: Befund", () => {
    const t = gut.replace('[[env.production.durable_objects.bindings]]\nname = "RETURNS_DO"\n', "");
    expect(pf(t)).toEqual(["durable_objects: RETURNS_DO fehlt"]);
  });
  it("ohne send_email: Befund", () => {
    const t = gut.replace('[[env.production.send_email]]\nname = "EMAIL"\n', "");
    expect(pf(t)).toEqual(["send_email-Binding EMAIL fehlt"]);
  });
  it("ohne dead_letter_queue und ENVIRONMENT: Befunde", () => {
    const t = gut.replace('dead_letter_queue = "q-dlq"\n', "").replace('ENVIRONMENT = "production", ', "");
    expect(pf(t)).toHaveLength(2);
  });
});
