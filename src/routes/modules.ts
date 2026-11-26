/**
 * `/v1/modules` — Module je Tenant selbst verwalten (Händler-Dashboard).
 * Lesen dürfen alle Mitarbeiter, ändern nur Inhaber (und API-Keys).
 * Geheime Werte gehen hinein, nie heraus.
 */
import { Hono } from "hono";
import type { AppContext, Env } from "../env";
import { CodedError } from "../errors/catalog";
import { kekConfigured, seal, unseal } from "../modules/crypto";
import { MODULES, moduleDef, plainFields, secretFields, type ModuleDef } from "../modules/registry";
import { moduleRow, type ModuleRow } from "../modules/resolve";
import { ownerOnly } from "../middleware/tenant-auth";

export const modulesRoutes = new Hono<AppContext>();

type CredRow = { salt: string; iv: string; ciphertext: string; fingerprint: string; updated_at: string };

async function credRow(env: Env, tenantId: string, moduleId: string): Promise<CredRow | null> {
  return env.DB.prepare("SELECT salt, iv, ciphertext, fingerprint, updated_at FROM tenant_module_credentials WHERE tenant_id = ? AND module_id = ?")
    .bind(tenantId, moduleId).first<CredRow>();
}

function hasLegacy(env: Env, def: ModuleDef, tenantId: string): boolean {
  try { return Boolean(def.legacy?.(env, tenantId)); } catch { return false; }
}

async function view(env: Env, tenantId: string, def: ModuleDef) {
  const row = await moduleRow(env, tenantId, def.id);
  const cred = await credRow(env, tenantId, def.id);
  const legacy = !row && hasLegacy(env, def, tenantId);
  const settings = row ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
  const plainOk = def.fields.filter((f) => f.type !== "secret" && f.required).every((f) => settings[f.name] !== undefined && settings[f.name] !== "");
  const secretsOk = secretFields(def).length === 0 || Boolean(cred);
  return {
    id: def.id, name: def.name, kind: def.kind, description: def.description,
    available: row ? row.available === 1 : true,
    enabled: row ? row.enabled === 1 : legacy || false,
    configured: legacy || (plainOk && secretsOk),
    source: legacy ? "legacy" : "tenant",
    status: row?.status ?? "unchecked",
    last_checked_at: row?.last_checked_at ?? null,
    last_error: row?.last_error ?? null,
    settings: Object.fromEntries(plainFields(def).filter((k) => k in settings).map((k) => [k, settings[k]])),
    credentials: cred ? { configured: true, fingerprint: cred.fingerprint, updated_at: cred.updated_at } : { configured: false },
    checkable: Boolean(def.probe),
    fields: def.fields,
  };
}

function requireDef(id: string): ModuleDef {
  const def = moduleDef(id);
  if (!def) throw new CodedError("GH-MODULE-001");
  return def;
}

async function ensureRow(env: Env, tenantId: string, moduleId: string): Promise<ModuleRow> {
  await env.DB.prepare("INSERT INTO tenant_modules (tenant_id, module_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (tenant_id, module_id) DO NOTHING")
    .bind(tenantId, moduleId, new Date().toISOString()).run();
  return (await moduleRow(env, tenantId, moduleId)) as ModuleRow;
}

/** Volle Konfiguration (offen + entschlüsselt) gegen das Schema des Moduls. */
async function fullConfig(env: Env, tenantId: string, def: ModuleDef, row: ModuleRow) {
  const cred = await credRow(env, tenantId, def.id);
  const secrets = cred ? await unseal(env, tenantId, def.id, cred) : {};
  const merged = { ...(JSON.parse(row.settings) as object), ...secrets };
  if (!def.schema) return { ok: true as const, data: merged };
  const parsed = def.schema.safeParse(merged);
  return parsed.success ? { ok: true as const, data: parsed.data } : { ok: false as const, fields: parsed.error.issues.map((i) => String(i.path[0])) };
}

modulesRoutes.get("/", async (c) => {
  const tenantId = c.var.tenant_id as string;
  const data = [];
  for (const def of MODULES) data.push(await view(c.env, tenantId, def));
  return c.json({ data });
});

modulesRoutes.get("/:id", async (c) => {
  return c.json(await view(c.env, c.var.tenant_id as string, requireDef(c.req.param("id"))));
});

modulesRoutes.put("/:id", ownerOnly(), async (c) => {
  const tenantId = c.var.tenant_id as string;
  const def = requireDef(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; settings?: unknown };
  const row = await ensureRow(c.env, tenantId, def.id);
  if (!row.available) throw new CodedError("GH-MODULE-001");

  let settings = JSON.parse(row.settings) as Record<string, unknown>;
  if (body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new CodedError("GH-MODULE-004", { reason: "settings" });
    const allowed = new Set(plainFields(def));
    const unknown = Object.keys(body.settings).filter((k) => !allowed.has(k));
    // Ein geheimes Feld über settings zu setzen hieße: im Klartext ablegen.
    if (unknown.length) throw new CodedError("GH-MODULE-004", { reason: "unknown_or_secret_fields", fields: unknown });
    settings = { ...settings, ...(body.settings as Record<string, unknown>) };
  }
  const enabled = body.enabled === undefined ? row.enabled === 1 : body.enabled === true;
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE tenant_modules SET settings = ?, enabled = 0, status = 'unchecked', last_error = NULL, updated_at = ? WHERE tenant_id = ? AND module_id = ?")
    .bind(JSON.stringify(settings), now, tenantId, def.id).run();
  if (enabled) {
    const check = await fullConfig(c.env, tenantId, def, { ...row, settings: JSON.stringify(settings) });
    if (!check.ok) throw new CodedError("GH-MODULE-004", { reason: "incomplete", fields: check.fields });
    await c.env.DB.prepare("UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module_id = ?").bind(tenantId, def.id).run();
  }
  return c.json(await view(c.env, tenantId, def));
});

modulesRoutes.put("/:id/credentials", ownerOnly(), async (c) => {
  const tenantId = c.var.tenant_id as string;
  const def = requireDef(c.req.param("id"));
  if (!kekConfigured(c.env)) throw new CodedError("GH-MODULE-002");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CodedError("GH-MODULE-004", { reason: "body" });
  const allowed = new Set(secretFields(def));
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length || !Object.keys(body).length) throw new CodedError("GH-MODULE-004", { reason: "unknown_fields", fields: unknown });
  if (Object.values(body).some((v) => typeof v !== "string" || v.length === 0 || v.length > 4096)) throw new CodedError("GH-MODULE-004", { reason: "value_type" });

  const row = await ensureRow(c.env, tenantId, def.id);
  if (!row.available) throw new CodedError("GH-MODULE-001");
  const existing = await credRow(c.env, tenantId, def.id);
  const previous = existing ? await unseal(c.env, tenantId, def.id, existing) : {};
  const sealed = await seal(c.env, tenantId, def.id, { ...previous, ...(body as Record<string, string>) });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO tenant_module_credentials (tenant_id, module_id, salt, iv, ciphertext, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, module_id) DO UPDATE SET salt = excluded.salt, iv = excluded.iv, ciphertext = excluded.ciphertext, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`)
      .bind(tenantId, def.id, sealed.salt, sealed.iv, sealed.ciphertext, sealed.fingerprint, now),
    c.env.DB.prepare("UPDATE tenant_modules SET status = 'unchecked', last_error = NULL, updated_at = ? WHERE tenant_id = ? AND module_id = ?").bind(now, tenantId, def.id),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ configured: true, fingerprint: sealed.fingerprint, updated_at: now });
});

modulesRoutes.delete("/:id/credentials", ownerOnly(), async (c) => {
  const tenantId = c.var.tenant_id as string;
  const def = requireDef(c.req.param("id"));
  const now = new Date().toISOString();
  await ensureRow(c.env, tenantId, def.id);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tenant_module_credentials WHERE tenant_id = ? AND module_id = ?").bind(tenantId, def.id),
    c.env.DB.prepare("UPDATE tenant_modules SET enabled = 0, status = 'unchecked', last_error = NULL, updated_at = ? WHERE tenant_id = ? AND module_id = ?").bind(now, tenantId, def.id),
  ]);
  return c.body(null, 204);
});

/** Nur die Art des Fehlers festhalten — nie eine Antwort des Anbieters, die etwas spiegeln könnte. */
function errorSummary(err: unknown): string {
  const e = err as { name?: string; status?: number };
  if (typeof e?.status === "number") return `Anbieter antwortete mit HTTP ${e.status}`;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "Zeitüberschreitung beim Anbieter";
  if (err instanceof CodedError) return err.code;
  return "Verbindung fehlgeschlagen";
}

modulesRoutes.post("/:id/check", ownerOnly(), async (c) => {
  const tenantId = c.var.tenant_id as string;
  const def = requireDef(c.req.param("id"));
  const row = await moduleRow(c.env, tenantId, def.id);
  if (!row || !row.available) throw new CodedError("GH-MODULE-001");
  const now = new Date().toISOString();
  let status: "ok" | "error" | "unchecked" = "unchecked";
  let detail: string | null = def.probe ? null : "Für dieses Modul gibt es noch keine automatische Prüfung.";
  const cfg = await fullConfig(c.env, tenantId, def, row);
  if (!cfg.ok) {
    status = "error"; detail = `Angaben fehlen oder sind ungültig: ${cfg.fields.join(", ")}`;
  } else if (def.probe) {
    try { await def.probe(cfg.data as never); status = "ok"; detail = null; } catch (err) { status = "error"; detail = errorSummary(err); }
  }
  await c.env.DB.prepare("UPDATE tenant_modules SET status = ?, last_checked_at = ?, last_error = ? WHERE tenant_id = ? AND module_id = ?")
    .bind(status, now, status === "error" ? detail : null, tenantId, def.id).run();
  return c.json({ status, detail, checked_at: now });
});
