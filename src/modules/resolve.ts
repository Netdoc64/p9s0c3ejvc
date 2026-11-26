/**
 * Konfiguration eines Moduls für einen Tenant auflösen.
 *
 * Reihenfolge:
 *  1. Datensatz des Tenants (`tenant_modules` + verschlüsselte Zugänge). Ist das
 *     Modul dort ausgeschaltet oder nicht verfügbar, gilt es als AUS — auch wenn
 *     im alten Sammel-Secret noch etwas steht.
 *  2. Übergang: das alte Sammel-Secret (`*_CONNECTIONS`), solange der Tenant
 *     keinen eigenen Datensatz hat. Das Modul meldet dann `source: "legacy"`.
 *
 * Diese Datei importiert keine Anbindung (sonst Zirkel); die Anbindungen
 * reichen ihr Schema herein.
 */
import type { z } from "zod";
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";
import { unseal } from "./crypto";

export interface ModuleRow {
  tenant_id: string;
  module_id: string;
  available: number;
  enabled: number;
  settings: string;
  status: "ok" | "error" | "unchecked";
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export async function moduleRow(env: Env, tenantId: string, moduleId: string): Promise<ModuleRow | null> {
  return env.DB.prepare("SELECT * FROM tenant_modules WHERE tenant_id = ? AND module_id = ?").bind(tenantId, moduleId).first<ModuleRow>();
}

export async function tenantModuleConfig<S extends z.ZodType>(
  env: Env,
  tenantId: string,
  moduleId: string,
  schema: S,
  legacy: () => z.infer<S> | undefined,
): Promise<z.infer<S> | undefined> {
  const row = await moduleRow(env, tenantId, moduleId);
  if (!row) return legacy();
  if (!row.available || !row.enabled) return undefined;
  const cred = await env.DB.prepare("SELECT salt, iv, ciphertext FROM tenant_module_credentials WHERE tenant_id = ? AND module_id = ?")
    .bind(tenantId, moduleId).first<{ salt: string; iv: string; ciphertext: string }>();
  const secrets = cred ? await unseal(env, tenantId, moduleId, cred) : {};
  const parsed = schema.safeParse({ ...(JSON.parse(row.settings) as object), ...secrets });
  if (!parsed.success) throw new CodedError("GH-SUPPLIER-001", { reason: "module_incomplete" });
  return parsed.data;
}

/** Tenants, für die ein Modul aktiv ist (eigener Datensatz) — für Zeitpläne. */
export async function tenantsWithModule(env: Env, moduleId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT m.tenant_id FROM tenant_modules m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.module_id = ? AND m.enabled = 1 AND m.available = 1 AND t.status = 'active' AND t.deleted_at IS NULL
      ORDER BY m.tenant_id`,
  ).bind(moduleId).all<{ tenant_id: string }>();
  return (rows.results ?? []).map((r) => r.tenant_id);
}
