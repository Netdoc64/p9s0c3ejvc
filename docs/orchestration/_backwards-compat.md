# Backwards-Compatibility Rules

Versionierungs- und Kompatibilitätsregeln, die für den **Plan**, die
**Orchestration-Schicht** und die **App selbst** gelten. Jede Plan-Revision (siehe
`_self-optimization.md`) muss eine dieser Regeln explizit referenzieren.

## Stabilität — was sich nie ändert

Diese Identifier sind **eingefroren**, sobald sie einmal vergeben wurden:

| Kategorie                     | Beispiel                          |
|-------------------------------|-----------------------------------|
| Modul-IDs                     | `M06_pricing`                     |
| Phase-IDs                     | `P2_domain`                       |
| Error-Codes                   | `GH-AUTH-001`                     |
| API-Pfade in stabiler Version | `GET /v1/orders/:id`              |
| Order-Document `doc_type`     | `"order"`, `"credit_note"`, …     |
| Tenant-IDs                    | `t_pilot`                  |
| Resource-ID-Prefixes          | `ord_`, `cust_`, `sku_`           |

Ändern = **niemals**. Ersetzen = neuer Identifier mit Mapping-Doku, alter wird
auf `deprecated` gesetzt aber nicht entfernt.

## Schema-Versionierung

Drei Schemas werden separat versioniert:

### 1. Build-Plan-Schema

```
build-plan/1.0   — initial
build-plan/1.1   — additiv (neue Felder mit Default)
build-plan/2.0   — breaking (selten erlaubt, mit Migrations-Skript)
```

Änderungs-Klassifikation:

- **Additiv (Minor-Bump 1.x → 1.x+1)**
  - Neues Feld mit Default
  - Neuer Modul-Eintrag in `modules[]`
  - Neue `risks[]`-Einträge
  - Neuer `cross_cutting`-Standard, sofern Default-kompatibel

- **Breaking (Major-Bump 1.x → 2.0)**
  - Existierendes Feld umbenannt
  - Pflichtfeld neu eingeführt ohne Default
  - `cross_cutting`-Wert geändert (z.B. Money-Format)
  - Modul-ID umbenannt (siehe oben — nie!)

Major-Bumps brauchen Migrations-Skript in `scripts/migrate-plan/v1-to-v2.ts`,
das `build-plan.json` (alle Versionen, die existieren) auf das neue Schema bringt.

### 2. Order-Document-Schema

Identische Regeln wie oben, eigene Versionsspur:

```
order-document/1.0
order-document/1.1
...
```

**Spezialregel:** Persistierte Order-Documents werden **nicht** retroaktiv
migriert. Ein Reader für `order-document/1.0` muss bestehen, solange Documents
dieser Version in der DB liegen. Das heisst pragmatisch: Reader ist
**Forward-Compatible** (versteht alle Minor-Bumps seiner Major-Linie).

Major-Bump bei Order-Document: nur mit explizitem Migrations-Lauf, der
persistierte Docs umschreibt UND ein Backup zieht.

### 3. API-Versionierung

REST-Pfade tragen Major-Version: `/v1/orders`. Innerhalb einer Major-Version
sind **nur** additive Änderungen erlaubt:

- Neue Endpoints — ja
- Neue optionale Request-Felder — ja
- Neue Response-Felder — ja (Clients ignorieren Unbekanntes)
- Existierende Felder umbenennen — **nein**, neuer Endpoint mit `/v2`-Prefix
- Pflichtparameter neu hinzufügen — **nein**

Deprecation:

- Endpoint wird mit `Deprecation: true`-Header und `Sunset: <date>`-Header
  markiert
- Mindestens 6 Monate Lauffrist vor Entfernung
- Tenant-Telemetry: wer ruft den Endpoint noch auf? → erst entfernen, wenn 0
  Aufrufe in 30 Tagen

## Datenmigrations

D1-Migrations laufen **forward-only**:

- Migrations-Files: `migrations/0001_init.sql`, `0002_add_credit_limit.sql`, …
- Niemals Down-Migration im normalen Betrieb (CI-Tests laufen Roundtrip up/down,
  prod nur up)
- Drop-Column ist **niemals** im Minor-Bump erlaubt — erst Spalte als
  `deprecated` markieren (Soft-Drop), nach Major-Bump physisch entfernen
- Schreib-Backwards-Compat: alte Code-Versionen müssen mit neuer DB laufen
  können (keine Pflicht-Spalten ohne Default)
- Lese-Backwards-Compat: neue Code-Versionen müssen alte DB-Stände lesen können

## Mobile-Client-Backwards-Compat (M24)

Mobile-Apps haben einen eigenen Lebenszyklus durch App-Stores. Daraus folgt:

- **Pflicht-Header** auf Customer-Routes: `X-Client-Version` (SemVer) +
  `X-Client-Platform` (`ios`, `android`, `web`)
- **`min_supported_version`** wird pro Plattform gepflegt; älter → 426 Upgrade
  Required mit Store-Link
- **Soft-Sunset 30 Tage** vor Hard-Cutoff: Server gibt
  `X-Client-Status: deprecated` zurück und triggert Push-Notification
- **Niemals Hard-Cutoff ohne Soft-Sunset**, auch nicht bei kritischen
  Sicherheits-Bugs (Sunset-Window kann auf 7d gekürzt werden, aber nicht 0)
- **Server muss alte API-Major-Version mind. 12 Monate parallel betreiben** wenn
  Mobile-App eine breaking Change durchläuft

Konkret: bei Major-API-Bump läuft der Server zwei API-Versions parallel; die
Mobile-App migrieren wir Plattform-für-Plattform mit Soft-Sunset.

## Code-Backwards-Compat (Worker-Deploy)

Cloudflare Workers haben **gleichzeitig laufende Versionen** während Rollouts.
Daraus folgt:

- Datenformat-Änderungen müssen **2-Phasen** sein:
  1. Code v(n) liest alt **und** neu, schreibt alt
  2. Code v(n+1) liest alt **und** neu, schreibt neu
  3. (optional Code v(n+2) liest nur neu, schreibt neu)
- Niemals einen Schritt überspringen.

## Plan-Revision-Checkliste (Backwards-Compat-Statement)

Im PR jeder Plan-Revision muss eines dieser Statements angehakt sein:

- [ ] **Additive Änderung, kein Modul shipped** — keine Migration nötig.
- [ ] **Additive Änderung, Module shipped** — alte Implementation bleibt valide,
      neue Felder optional. Modul-Status bleibt `shipped`.
- [ ] **Breaking, Module shipped** — neuer Modul-ID (z.B. `M06b_pricing_v2`),
      alter wird `deprecated`, Migration dokumentiert.
- [ ] **Breaking, kein Modul shipped** — direkter In-Place-Update am Modul-File
      erlaubt; Plan-Major-Bump.

Plan-Revisions ohne Backwards-Compat-Statement werden abgelehnt.

## Deprecation-Lifecycle

```
active                    normaler Betrieb
  ↓
deprecated_announced      Header/Doku markiert, Telemetry läuft
  ↓
sunset_scheduled          Datum gesetzt (≥ 6 Monate Voraus)
  ↓
sunset                    Endpoint/Feld antwortet 410 Gone, Reader entfernt
```

Niemals direkt von `active` → `sunset`. Auch bei klar unbenutzten Pfaden
mindestens 30 Tage `deprecated_announced` mit Telemetrie-Beleg.

## Was über die App hinausgeht — Plan & Orchestration selbst

Die Orchestration-Schicht IST eine versionierte Schicht. Datei-Pfade in
`docs/orchestration/` sind **stabil**:

- Wenn ein Modul-File seinen Inhalt grundlegend ändert (Plan-Revision evolved den
  Aufbau), bleibt der **Dateipfad** identisch.
- Verschieben oder Umbenennen erzeugt eine `MOVED.md` als Stub am alten Pfad mit
  Redirect-Kommentar — für 6 Monate.
- `learnings/<MODUL>.log.md` darf **nie** umbenannt werden, sonst geht historische
  Spur verloren.

## Prinzip

> Stabilität von Identifiern, Disziplin in Änderungen, Spur von allem.
> Der Plan darf wachsen, aber nicht vergessen.
