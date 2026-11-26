/**
 * Welche Module es gibt, welche Felder sie brauchen und wie man sie prüft.
 *
 * Geheime Felder (`type: "secret"`) landen verschlüsselt in
 * `tenant_module_credentials`, alle anderen offen in `tenant_modules.settings`.
 * Das Schema je Modul ist dasselbe, mit dem die Anbindung ihre Konfiguration
 * liest — es gibt nur EINE Wahrheit darüber, was gültig ist.
 */
import type { z } from "zod";
import type { Env } from "../env";
import { FloridayClient, floridayConfigSchema, legacyFloridayConfig } from "../integrations/floriday";
import { fleuropConfigSchema, legacyFleuropConfig } from "../integrations/fleurop";
import { fsnConfigSchema, legacyFlowerShopNetworkConfig } from "../integrations/flower-shop-network";
import { KomanderClient, komanderConfigSchema, legacyKomanderConfig } from "../integrations/komander";

export interface ModuleField {
  name: string;
  label: string;
  type: "text" | "secret" | "select" | "boolean" | "number";
  required: boolean;
  options?: string[];
  help?: string;
}

export interface ModuleDef {
  id: string;
  name: string;
  kind: "supplier" | "network" | "shop";
  description: string;
  fields: ModuleField[];
  schema?: z.ZodType;
  legacy?: (env: Env, tenantId: string) => unknown;
  /** Lesender Aufruf gegen den Anbieter; wirft bei Fehler. Fehlt er, bleibt der Status „ungeprüft“. */
  probe?: (config: never) => Promise<void>;
}

const bool = (name: string, label: string, help?: string): ModuleField => ({ name, label, type: "boolean", required: false, ...(help ? { help } : {}) });

export const MODULES: ModuleDef[] = [
  {
    id: "floriday",
    name: "Floriday",
    kind: "supplier",
    description: "Großhandels-Marktplatz der niederländischen Erzeuger: Katalog und Angebote abholen, Einkaufsbestellungen senden.",
    fields: [
      { name: "environment", label: "Umgebung", type: "select", required: true, options: ["staging", "production"] },
      { name: "account", label: "Bezeichner des Käuferkontos", type: "text", required: true, help: "Frei wählbar, stabil (a-z, 0-9, _ und -). Bei einem anderen Käuferkonto einen neuen wählen." },
      { name: "clientId", label: "Client-ID", type: "text", required: true },
      { name: "clientSecret", label: "Client-Secret", type: "secret", required: true },
      { name: "apiKey", label: "API-Schlüssel des Käuferkontos", type: "secret", required: true },
      bool("scheduled", "Automatisch alle 15 Minuten abgleichen"),
      bool("ordering", "Einkaufsbestellungen senden erlauben", "Erst nach Freigabe der Schreibrechte bei Floriday einschalten."),
    ],
    schema: floridayConfigSchema,
    legacy: legacyFloridayConfig,
    probe: async (config) => { await new FloridayClient(config).readPage("catalog", 0); },
  },
  {
    id: "fleurop-nl",
    name: "Fleurop Niederlande",
    kind: "network",
    description: "Floristen-Netzwerk: Endkunden-Bestellungen an einen Floristen vor Ort weitergeben.",
    fields: [
      { name: "account", label: "Bezeichner", type: "text", required: true },
      { name: "bearerToken", label: "Zugangs-Token", type: "secret", required: true },
      { name: "sender", label: "Mitgliedsnummer (Absender)", type: "number", required: true },
      { name: "debtorId", label: "Debitorennummer", type: "number", required: true },
      bool("ordering", "Bestellungen senden erlauben"),
    ],
    schema: fleuropConfigSchema,
    legacy: legacyFleuropConfig,
  },
  {
    id: "flower-shop-network",
    name: "Flower Shop Network",
    kind: "network",
    description: "Floristen-Netzwerk (USA): Produkte, Floristen und Bestellungen.",
    fields: [
      { name: "environment", label: "Umgebung", type: "select", required: true, options: ["development", "production"] },
      { name: "account", label: "Bezeichner", type: "text", required: true },
      { name: "token", label: "Zugangs-Token", type: "secret", required: true },
      bool("ordering", "Bestellungen senden erlauben"),
    ],
    schema: fsnConfigSchema,
    legacy: legacyFlowerShopNetworkConfig,
  },
  {
    id: "komander",
    name: "Blumen Komander",
    kind: "shop",
    description: "Endkunden-Shop: Produkte suchen, Verfügbarkeit prüfen, Checkout.",
    fields: [
      { name: "storeKey", label: "Store-Schlüssel", type: "secret", required: true },
      bool("checkout", "Checkout erlauben"),
    ],
    schema: komanderConfigSchema,
    legacy: legacyKomanderConfig,
    probe: async (config: { storeKey: string }) => { await new KomanderClient(config.storeKey).read("products/search", { limit: 1 }); },
  },
  {
    id: "file-import",
    name: "Lieferanten-Dateien",
    kind: "supplier",
    description: "Preis- und Bestandslisten von Lieferanten ohne API als Datei übernehmen (je Lieferant ein Quellschlüssel).",
    fields: [],
  },
];

export function moduleDef(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}

export const secretFields = (d: ModuleDef) => d.fields.filter((f) => f.type === "secret").map((f) => f.name);
export const plainFields = (d: ModuleDef) => d.fields.filter((f) => f.type !== "secret").map((f) => f.name);
