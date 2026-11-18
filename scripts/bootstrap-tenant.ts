/**
 * M03 — Bootstrap-CLI: Erzeugt einen neuen Tenant + ersten API-Key.
 *
 * Verwendung:
 *   pnpm bootstrap-tenant -- --slug pilot --name "Pilot Blumen-Grosshandel" \
 *                            --country NL --currency EUR [--remote] [--env staging]
 *
 * Ohne --remote läuft gegen die lokale miniflare-D1 (`wrangler dev`-State).
 * Mit --remote wird `wrangler d1 execute --remote` verwendet.
 *
 * Die Klartext-Werte für api_key + hmac_secret werden GENAU EINMAL ausgegeben.
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash, randomBytes } from "node:crypto";

interface ParsedArgs {
  slug: string;
  name: string;
  country: string;
  currency: string;
  vatId?: string;
  address?: string;
  remote: boolean;
  env?: string;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      name: { type: "string" },
      country: { type: "string" },
      currency: { type: "string" },
      "vat-id": { type: "string" },
      address: { type: "string" },
      remote: { type: "boolean", default: false },
      env: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printHelpAndExit(0);
  }

  const missing: string[] = [];
  for (const k of ["slug", "name", "country", "currency"] as const) {
    if (!values[k]) missing.push(`--${k}`);
  }
  if (missing.length > 0) {
    console.error(`Fehlende Argumente: ${missing.join(", ")}`);
    printHelpAndExit(1);
  }

  return {
    slug: values.slug as string,
    name: values.name as string,
    country: (values.country as string).toUpperCase(),
    currency: (values.currency as string).toUpperCase(),
    vatId: values["vat-id"] as string | undefined,
    address: values.address as string | undefined,
    remote: Boolean(values.remote),
    env: values.env as string | undefined,
  };
}

function printHelpAndExit(code: number): never {
  console.log(`bootstrap-tenant — erzeugt Tenant + ersten API-Key

Required:
  --slug <id>         Slug, z.B. "pilot" (lowercase, kein Whitespace)
  --name <text>       Anzeigename
  --country <iso2>    Ländercode (z.B. NL)
  --currency <iso4217> Währung (z.B. EUR)

Optional:
  --vat-id <id>       USt-IdNr. des Tenants (Pflicht für Rechnungen, sonst GH-PDF-002)
  --address <json>    Anschrift als JSON, z.B. '{"line1":"…","postal_code":"…","city":"…","country":"NL"}'
                      (Pflicht für Rechnungen, sonst GH-PDF-002)
  --remote            Schreibe in Remote-D1 statt lokaler miniflare-DB
  --env <name>        Wrangler-Environment (z.B. staging, production)
  --help              diese Hilfe`);
  process.exit(code);
}

function ulid(): string {
  // Minimaler Crockford-base32-ULID-Generator. Reicht für CLI-Use, Worker nutzt npm `ulid`.
  const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const t = Date.now();
  const tsBytes: number[] = [];
  let ts = t;
  for (let i = 9; i >= 0; i--) {
    tsBytes[i] = ts % 32;
    ts = Math.floor(ts / 32);
  }
  let out = tsBytes.map((b) => ENC[b]).join("");
  const rand = randomBytes(16);
  for (let i = 0; i < 16; i++) out += ENC[(rand[i] as number) % 32];
  return out;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sql(s: string): string {
  return s.replace(/'/g, "''");
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (!/^[a-z0-9-]+$/.test(args.slug)) {
    console.error("slug muss nur a-z 0-9 - enthalten");
    process.exit(1);
  }
  if (!/^[A-Z]{2}$/.test(args.country)) {
    console.error("country muss ISO-3166 alpha-2 sein");
    process.exit(1);
  }
  if (!/^[A-Z]{3}$/.test(args.currency)) {
    console.error("currency muss ISO-4217 sein (3 Buchstaben)");
    process.exit(1);
  }

  const tenant_id = `t_${ulid()}`;
  const api_key_id = `k_${ulid()}`;
  const api_key_plain = `gh_${base64Url(randomBytes(24))}`;
  const hmac_secret = base64Url(randomBytes(32));
  const customer_jwt_secret = base64Url(randomBytes(32));
  const key_hash = createHash("sha256").update(api_key_plain).digest("hex");
  const now = new Date().toISOString();

  const stmt = `
    INSERT INTO tenants (id, slug, name, country, currency, customer_jwt_secret, status, vat_id, address, created_at, updated_at)
    VALUES ('${sql(tenant_id)}', '${sql(args.slug)}', '${sql(args.name)}', '${sql(args.country)}', '${sql(args.currency)}', '${sql(customer_jwt_secret)}', 'active', ${args.vatId ? `'${sql(args.vatId)}'` : "NULL"}, ${args.address ? `'${sql(args.address)}'` : "NULL"}, '${sql(now)}', '${sql(now)}');
    INSERT INTO api_keys (id, tenant_id, key_hash, hmac_secret, name, scope, created_at)
    VALUES ('${sql(api_key_id)}', '${sql(tenant_id)}', '${sql(key_hash)}', '${sql(hmac_secret)}', 'bootstrap', 'full', '${sql(now)}');
  `.trim();

  const target = args.remote ? "--remote" : "--local";
  const envArg = args.env ? `--env ${args.env}` : "";
  const cmd = `wrangler d1 execute DB ${target} ${envArg} --command ${JSON.stringify(stmt)}`;

  console.log(`Bootstrap → ${args.remote ? "REMOTE" : "LOCAL"} D1${args.env ? ` (env=${args.env})` : ""}`);
  console.log(`Schreibe Tenant + API-Key …`);

  try {
    execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const stderrStr = stderr instanceof Buffer ? stderr.toString("utf-8") : (stderr ?? "");
    if (stderrStr.includes("UNIQUE constraint") || stderrStr.includes("UNIQUE")) {
      console.error(`\nFehler: Slug "${args.slug}" existiert bereits.`);
      process.exit(2);
    }
    console.error(`\nFehler beim Ausführen der wrangler-Migration:\n${stderrStr}`);
    process.exit(3);
  }

  console.log(`
✓ Tenant + API-Key angelegt

  tenant_id            ${tenant_id}
  slug                 ${args.slug}
  api_key_id           ${api_key_id}
  api_key (plain)      ${api_key_plain}
  hmac_secret          ${hmac_secret}
  customer_jwt_secret  ${customer_jwt_secret}

⚠  Klartext-Werte werden NICHT erneut angezeigt. Speichere sie sicher.
   Auth-Header für API-Calls:
     X-Api-Key: ${api_key_plain}
     X-Signature: <HMAC-SHA256(hmac_secret, METHOD\\nPATH\\nTIMESTAMP\\nSHA256(BODY))>
     X-Timestamp: <unix-seconds>
`);
}

main().catch((err) => {
  console.error("Unerwarteter Fehler:", err);
  process.exit(99);
});

export {};
