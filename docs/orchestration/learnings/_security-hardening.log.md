# Security & Bugs Hardening — Plan-Revision

## 2026-04-29 — by claude-opus-4-7 (security-pass)

### Auslöser
Ehrliche Bestandsaufnahme zeigte: Sicherheits-Architektur ist solide, aber
nichts ist extern verifiziert. Bug-Coverage hat Lücken bei DO-tests, FEFO,
DSGVO, Webhook-Delivery.

Dieses Protokoll listet alle in-code-fixbaren Punkte. Was extern Mittel braucht
(Pen-Test, Sec-Engineer-Review, Bug-Bounty), bleibt explizit out-of-scope.

### Geliefert (in dieser Session)

#### CI-Security-Hardening
- [ ] `pnpm audit --prod` als Job in `.github/workflows/ci.yml` (fails CI bei high/critical)
- [ ] Semgrep auto-config Job
- [ ] CodeQL Code-Scanning Workflow
- [ ] secretlint für commit-Hygiene

#### Test-Coverage
- [ ] `services/fefo.ts` Pure-Function-Tests (eligibility, allocation, perishable bypass)
- [ ] `services/dsgvo.ts` Roundtrip-Test (vor/nach Pseudonymisierung, addresses-Felder, PII-Hash deterministic)
- [ ] Customer-Auth-Middleware: Cross-Tenant-JWT via SELF.fetch (M02b Acceptance!)
- [ ] Outbox-Tx: Order-Update + Outbox-Insert atomarer Test (mit miniflare-D1 batch)
- [ ] Pricing-Feed-Drift-Detection (Pure-Function-Test)
- [ ] CSV-Import-Header-Drift Test

#### Code-Hardening
- [ ] PII-Pattern erweitert um `billing_address`, `shipping_address`, `*_pii` etc.
- [ ] Magic-Link-Code: 8-Digit Base32 (statt 6-Digit-Decimal) → Entropie 40 Bit statt ~20 Bit
- [ ] `/health` mit leichtem Rate-Limit (1000/min pro IP) — Anti-Recon
- [ ] Webhook-Subscription-KV-Cache (60s TTL) — verhindert D1-Heavy bei vielen Subs
- [ ] CSV-Import: Header-Drift-Detection mit klarer Fehlermeldung
- [ ] Backup: `schema_version` pro row für Restore-Forward-Compat

#### Documentation
- [ ] `SECURITY.md` Top-Level mit Reporting-Adresse + Scope
- [ ] `docs/threat-model.md` mit STRIDE pro Auth-Flow
- [ ] `docs/owasp-api-top10.md` — pro OWASP-API-Top-10-Punkt: addressed/not-applicable/follow-up
- [ ] Diese Datei vollständig abgehakt

### Out-of-scope (braucht externe Mittel)
1. **Externe Pen-Tests** — z.B. via Cure53, Cobalt, Bishop Fox (€5k+/Woche)
2. **Bug-Bounty-Programm** auf HackerOne / Intigriti
3. **Externe Code-Review** durch Sec-Engineer (1-3 Tage)
4. **Lasttest gegen deployed Worker** (k6/artillery, setzt Staging voraus)
5. **DR-Drill** auf Staging (setzt Staging voraus)
6. **Real-APNs/FCM-Adapter** (brauchen Apple-Team-ID, FCM-Service-Account-Key)
7. **Aalsmeer/RBC-Adapter** (brauchen API-Access vom Pilot-Tenant)
8. **Cloudflare-Resources** anlegen (D1/KV/R2/Queues/DO-Migrationen)
9. **CF-WAF-Rules + Bot-Management** konfigurieren
10. **Logpush + 7y-Cold-Archive** in CF-Dashboard einrichten

### Acceptance-Kriterien für diesen Pass
- pnpm typecheck grün
- pnpm test ≥ 110 Tests passing (von ~96 jetzt + ~15 neue)
- pnpm build grün
- Alle Listen-Punkte oben abgehakt
- SECURITY.md, threat-model.md, owasp-api-top10.md committed
- Commit-Message listet alle Verbesserungen auf

### Status nach diesem Pass
- Code-side: hardened auf Pilot-Niveau
- Process-side: dokumentiert was als nächstes zu tun ist
- Operator-side: 10-Punkte-Checkliste für externe Massnahmen
