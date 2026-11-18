# Mobile Pilot-App

Die Expo-App startet standardmäßig mit künstlichen Pilotdaten. Die Demo speichert Bestellungen pro Testkonto auf dem Gerät bzw. im Browser. Sie ermöglicht Katalogsuche, Mengenstaffeln, Warenkorb, Reservierungsprüfung, Bestätigung, Statusklärung, Bestellhistorie, Musterrechnung und Kontowechsel.

## Lokal starten

```sh
cd mobile
npm ci
npm start
```

Im Web läuft die App über `npm run web`. Wähle **Floraly Berlin** oder **Blume Amsterdam** und verwende nach der Code-Anforderung `ABCD2345`. Unter **Konto → Demo-Szenario** lassen sich Preiswechsel, Bestandskonflikt und eine verlorene Bestätigungsantwort testen.

## Gegen die Kunden-API starten

```sh
EXPO_PUBLIC_API_URL=https://api.example.test EXPO_PUBLIC_TENANT_SLUG=pilot npm start
```

Die API-Adresse wird in die App eingebaut. Nach einem Wechsel der Adresse Expo mit `npm start -- --clear` neu starten. Der Web-Export leert den Metro-Cache automatisch. Verwende für Geräte eine erreichbare HTTPS-Adresse. Für die Integration braucht die Worker-Umgebung Migration `0025_customer_order_operations.sql`, die Worker-Variable `CUSTOMER_APP_ORIGINS` mit der Origin des Web-Builds (nur für den Browser nötig), den eingerichteten E-Mail-Versand, aktive Pilotkunden, Preise und wirksamen Wareneingang im Standardlager. Die Browser-Vorschau hält echte Anmeldedaten nur im Arbeitsspeicher. Android und iOS verwenden SecureStore.

Die App verwendet den Kundenvertrag aus PR #8. Die Warenkorbvorschau zeigt Nettopreise. Der Worker berechnet Steuer und Gesamtbetrag bei der Bestellprüfung. Die Kunden-API prüft Berechtigungen pro Kundenkonto. Der Innendienst verwendet weiterhin seine Tenant-API und findet den mobilen Auftrag unter seiner Referenz. Pilot-Lieferzusagen brauchen die fachlich bestätigten Daten. Für einen Testbuild mit einem vereinbarten Händlerkontakt kann `EXPO_PUBLIC_SUPPORT_EMAIL` gesetzt werden. Bleibt eine Operation nach einer Unterbrechung serverseitig ungeklärt, bleibt erneutes Bestellen gesperrt, bis der Vorgang aufgelöst ist.

## Prüfen

Im App-Ordner `npm run typecheck` und `npm run build:web` ausführen. Der Browser-Test nutzt Chromium und einen Server für den exportierten Build. Beispielsweise in zwei Terminals starten:

```sh
python3 -m http.server 8081 --bind 127.0.0.1 --directory dist
```

```sh
npx playwright install chromium
npm run test:browser
```

Wenn Chromium bereits installiert ist, kann `CHROMIUM_PATH` auf sein Binary zeigen. `PILOT_SMOKE_URL` überschreibt die Standardadresse. Der Test prüft den normalen Kauf, eine Preisänderung, einen Bestandskonflikt und die Wiederaufnahme nach simuliertem Antwortverlust einschließlich Kontowechsel und PDF-Download.

Der Worker-Integrationstest steht unter `tests/routes/customer-pilot.spec.ts` im Repo-Hauptordner. Die [Planungsübersicht](../docs/frontend-plan.md) beschreibt die übrigen Bedingungen für Staging und Pilotfreigabe.

## App und Worker gemeinsam lokal testen

Aus dem Repo-Hauptordner nach Installation der Backend- und Mobile-Abhängigkeiten:

```sh
node scripts/test-mobile-local.mjs
```

Der Test startet einen lokalen Worker und einen Browser-Build mit temporärer Datenbank. Login, PKCE, Kundenpreise, Bestellbestätigung und Rechnung laufen über die echte Kunden-API. Ein isolierter Test-Mailadapter stellt den Code auf Loopback bereit. Beim zweiten Auftrag wird die Bestätigungsantwort nach erfolgreicher Verarbeitung verworfen. Der Test prüft, ob nach Browser-Neustart und erneuter Anmeldung dieselbe Bestellung wiedergefunden wird und ein anderes Konto sie nicht sieht.
