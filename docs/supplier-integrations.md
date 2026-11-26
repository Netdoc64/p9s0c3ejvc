# Lieferanten-Anbindungen

## Module je Tenant (empfohlen)

Jeder Tenant schaltet seine Anbindungen selbst ein und pflegt die Zugänge im
Händler-Dashboard bzw. über `/v1/modules` (nur Inhaber). Geheime Felder werden
mit dem Worker-Secret `MODULE_KEK` verschlüsselt gespeichert und nie wieder
herausgegeben; die Antwort nennt nur einen Abdruck. Was ein Tenant überhaupt
nutzen darf, legt der Betreiber mit `PUT /admin/tenants/<slug>/modules/<id>`
(`{"available": false}`) fest.

Die unten beschriebenen Sammel-Secrets (`*_CONNECTIONS`) gelten nur noch
übergangsweise für Tenants **ohne** eigenen Modul-Datensatz. Sobald ein Tenant
ein Modul selbst einrichtet oder ausschaltet, gilt sein Datensatz.

Die Anbindungen sind pro Mandant konfiguriert. Die API verwendet dieselbe
Tenant-HMAC-Signatur wie die übrigen Routen unter `/v1`. Die Routen und
Request-Schemas stehen im laufenden Worker unter `/openapi.json`.

## Quellenmix: Verkaufsartikel aus Lieferanten

`/v1/sourcing/offers` zeigt die Angebote aller aktiven Quellen in einer Form.
`POST /v1/sourcing/import` übernimmt ausgewählte Angebote als Verkaufsartikel
und verknüpft sie; `PUT /v1/sourcing/products/<id>/sources` setzt mehrere
Quellen je Artikel. Die Regeln (`/v1/sourcing/rules`: günstigste, Reihenfolge
oder schnellste Quelle, Aufschlag, Mindestmarge, Rundungsraster) bestimmen den
Verkaufspreis. Er steht in der Standard-Preisliste mit `managed_by = 'sourcing'`
und wird nach jedem Lieferanten-Abgleich neu gerechnet. **Ein von Hand
gepflegter Preis wird nie überschrieben.** Kundenbestellungen auf Artikel ohne
eigenen Bestand lösen den Einkauf beim Lieferanten noch nicht automatisch aus;
das folgt in einem eigenen Schritt.

## Lieferantenangebote aus Dateien übernehmen

Für freigegebene Lieferantenexporte ohne direkte API kann pro Mandant und
Quelle ein Angebotsstand importiert werden. Legt je Lieferant einen eigenen
stabilen Quellschlüssel an, etwa `supplier-a`. Bringt die Exportdatei in das
folgende JSON-Format und sendet sie signiert an `POST /v1/suppliers/imports/supplier-a`.

```json
{
  "revision": 1,
  "expires_at": "2027-01-02T12:00:00Z",
  "items": [
    {
      "sku": "ROSE-01",
      "name": "Rote Rose",
      "unit": "stem",
      "unit_price": "0.275",
      "currency": "EUR",
      "available_quantity": 80,
      "minimum_quantity": 10
    }
  ]
}
```

Preise und Mengen beziehen sich auf `unit`. Verwendet je Export eine höhere
`revision` und eine Gültigkeit gemäß Lieferant. Ein Stand ersetzt den bisherigen
vollständig und umfasst bis zu 500 Artikel. `items: []` leert die Quelle. Eine
identische Wiederholung liefert `applied: false`. Ältere oder widersprüchliche
Stände liefern HTTP 409.

`GET /v1/suppliers/imports/supplier-a?limit=50` listet die Angebote. Für die
nächste Seite `next_after` als Query-Parameter `after` verwenden. Beginnt bei
einem Revisionswechsel wieder auf Seite eins. Nach Ablauf enthält die Antwort
die Revisionsdaten und eine leere Artikelliste. Der Import hält die Angebote
getrennt vom internen Bestand, von Preislisten und von der Bestellübermittlung.

## Floriday für den Großhandel

Floriday stellt die Zugangsdaten für OAuth und den API-Schlüssel für das
Käuferkonto bereit. Die Anbindung verwendet die Customers API 2026v2.

- [Registrierung und Testzugang](https://www.floriday.io/en/developers-portal)
- [Customers API 2026v2](https://api.staging.floriday.io/customers-api-2026v2/swagger/index.html)
- [OAuth-Client-Credentials](https://developer.floriday.io/docs/client-credentials-flow)

Die Migration `0022_supplier_integrations.sql` legt die Tabellen für Katalog,
Angebote und Beschaffung an. Legt `FLORIDAY_CONNECTIONS` als Worker-Secret im
jeweiligen Environment an. Für lokale Tests eignet sich eine nicht versionierte
`.dev.vars`-Datei. Das Format ist ein JSON-Objekt mit der internen Mandanten-ID
als Schlüssel.

```json
{
  "t_EXAMPLE": {
    "environment": "staging",
    "account": "buyer-one",
    "clientId": "<client-id>",
    "clientSecret": "<client-secret>",
    "apiKey": "<buyer-api-key>",
    "scheduled": true,
    "ordering": false
  }
}
```

`account` ist ein frei gewählter, stabiler Bezeichner für dieses Käuferkonto.
Behaltet ihn bei einer Schlüsselrotation bei. Bei einem Wechsel des Käuferkontos
verwendet einen neuen Bezeichner. Daten und Bestellungen sind durch Mandant,
Anbieter und Konto einschließlich Floriday-Environment getrennt. Ein Worker
außerhalb der Produktion akzeptiert nur Floridays Staging-Environment.

### Staging-Verbindung prüfen

Verwendet einen aktiven Staging-Testmandanten, dessen Tenant-API-Key und
Signaturschlüssel sowie das freigeschaltete Floriday-Staging-Käuferkonto.
Setzt `ordering` und `scheduled` auf `false`. Prüft zuerst den Status mit
`GET /v1/suppliers/floriday` und ruft danach `/sync` per `POST` auf. Der Sync
liest bei Floriday und aktualisiert nur den Staging-Datenspeicher. Prüft über
die signierten `GET`-Aufrufe für `/catalog?limit=1` und `/offers?limit=1` ein
bekanntes Testangebot samt Preis, Bestellfenster und Artikelzuordnung. Ein
erfolgreicher Sync mit leeren Listen bestätigt nur die Verbindung. Die
Anmeldung der Pilot-App läuft separat über ein Kunden-Testkonto.

### Angebote abrufen

1. `GET /v1/suppliers/floriday` zeigt Konfiguration und Freigaben an.
2. `POST /v1/suppliers/floriday/sync` zieht bis zu drei Seiten pro Datenstrom.
   Bei `caught_up: false` kann der Aufruf wiederholt werden. Der Zeitplan ruft
   bei `scheduled: true` alle 15 Minuten weitere Seiten ab.
3. `GET /v1/suppliers/floriday/catalog` und `GET /v1/suppliers/floriday/offers`
   lesen aus der lokalen Datenbank. Für die nächste Seite den zurückgegebenen
   Wert von `next_after` als `after` übergeben. Ein Angebot enthält, sofern
   synchronisiert, den zugehörigen Katalogartikel unter `article`.
   Preise kommen als Währung und Dezimalbetrag pro Stück von Floriday.

Das Add-on speichert Lieferantendaten in eigenen Tabellen. Angebote mit
abgelaufenem Bestellfenster und gelöschte Angebote werden ausgeblendet. Bei einem
Synchronisationsfehler bleibt der letzte bereits veröffentlichte Stand erhalten.

### Einkaufsbestellung

Aktiviert `ordering: true` nach Freigabe der Floriday-Schreibrechte. Wählt für
die erste Bestellung das Staging-Environment. Bestellungen brauchen eine
Floriday-Lieferkondition mit passendem Termin und GLN sowie eine für den
Lieferanten zulässige Zahlungsvereinbarung. Der Add-on-Ablauf erfasst eine
Angebotsposition pro Bestellung.

1. `POST /v1/suppliers/floriday/purchase-orders` legt einen Entwurf an. Erzeugt
   vorher eine UUID und verwendet sie für Wiederholungen mit identischem Inhalt.
2. `POST /v1/suppliers/floriday/purchase-orders/{id}/submit` sendet den Entwurf.
   Die App prüft vor dem Senden Angebotsfenster, Menge, Verpackung und den
   bestätigten Stückpreis anhand der synchronisierten Daten.
3. `GET /v1/suppliers/floriday/purchase-orders/{id}` liest den lokalen Stand.
   `POST /v1/suppliers/floriday/purchase-orders/{id}/reconcile` liest den
   tatsächlichen Status bei Floriday. `submitted` steht für die Übermittlung.
   Die Annahme durch Floriday steht in `provider_status`. Bei `scheduled: true`
   fragt der Zeitplan bis zu fünf offene Bestellungen je Mandant pro Lauf ab.

Beispiel für einen Entwurf. Werte und Lieferfenster müssen zum gewählten
Floriday-Angebot passen.

```json
{
  "id": "3300f3f2-1629-49e4-af18-712f1e248a53",
  "offer_id": "159f0a83-7d72-4cb4-81a2-970347b8db08",
  "number_of_pieces": 20,
  "packing_index": 0,
  "expected_price_per_piece": { "currency": "EUR", "value": 0.275 },
  "delivery": {
    "latestDeliveryDateTime": "2027-02-12T12:00:00Z",
    "location": { "gln": "8713783430001" },
    "incoterm": "DAP"
  },
  "payment_provider": "RFH",
  "reference": "PO-001"
}
```

Wenn Floriday einen Verpackungszuschlag ausweist, bestätigt ihn über
`expected_packaging_price_per_piece`. Lieferkosten ergeben sich aus der
Floriday-Lieferkondition.

Ein Zustand `unknown` bedeutet, dass die App keine eindeutige Antwort auf das
Absenden erhalten hat. Wiederholt den Statusabgleich mit derselben UUID. Ein
einzelnes Floriday-404 ist auch nach einem Timeout kein Beleg dafür, dass die
Bestellung nie angekommen ist. Wenn der Status offen bleibt, klärt die UUID
mit Floriday, bevor ihr eine Ersatzbestellung anlegt.

## Blumen Komander für Endkunden

Aktiviert den Anbieter über das Worker-Secret `KOMANDER_CONNECTIONS`. Verwendet
den in der [Komander-API-Doku](https://blumen-verschicken.online/llms.txt)
veröffentlichten Store-Key. Die Checkout-Freigabe ist separat.

```json
{
  "t_EXAMPLE": {
    "storeKey": "<publishable-store-key>",
    "checkout": true
  }
}
```

- `GET /v1/suppliers/komander/products` sucht Produkte und Varianten.
- `GET /v1/suppliers/komander/availability?date=YYYY-MM-DD&postalCode=80799`
  prüft die Lieferbarkeit im Gebiet des Anbieters.
- `POST /v1/suppliers/komander/checkout` prüft die Lieferbarkeit erneut und
  übermittelt die Lieferadresse und E-Mail an Komander, um den Warenkorb
  vorzubereiten. Übergibt `checkout_url` an den Kunden. Dieser schließt den
  Kauf auf der Händlerseite ab. Verwendet für verlässliche Wiederholungen
  nach einer erfolgreichen Antwort denselben `X-Idempotency-Key`.

Der Checkout unterstützt die dokumentierte Standardlieferung. Express und
Abholung laufen über den Händler. Übermittelt Kundendaten erst, wenn
der Kunde den Checkout anfordert.

## Heemskerk VMP

[Heemskerk bietet VMP als Kundenanbindung an](https://www.heemskerkflowers.com/over-ons/vmp-koppeling).
Für einen Heemskerk-Adapter fehlen der konkrete Partner-Endpunkt, die
Authentifizierung und die vom Anbieter verwendeten Nachrichtenprofile. Die
[öffentliche Beschreibung des VMP-Standards](https://www.floricode.com/nl-nl/sdk/xml-standardized-messages/commercial/cc-vmp)
reicht zur Bestätigung der Heemskerk-Kompatibilität nicht aus.

## Fleurop Niederlande

Das Add-on verwendet die [Aestas API v1](https://aestas.fleurop.nl/swagger/index.html).
Fleurop verlangt einen Bearer-Token für den B2B-Zugriff. Das Secret
`FLEUROP_NL_CONNECTIONS` ordnet jedem aktivierten Mandanten ein Konto zu.
Der Anbieter muss den Token und die passenden Sender- und Debitor-IDs bereitstellen.

```json
{
  "t_EXAMPLE": {
    "account": "nl-business-account",
    "bearerToken": "<fleurop-token>",
    "sender": 123,
    "debtorId": 456,
    "ordering": false
  }
}
```

Behaltet `account` bei einer Token-Rotation bei. Verwendet für ein anderes
Fleurop-Geschäftskonto einen neuen Bezeichner. Der Adapter ruft den in der
öffentlichen Spezifikation veröffentlichten Host auf. Für einen Zugriff auf
ein offizielles Testkonto gelten die von Fleurop bereitgestellten Konditionen.

- `GET /v1/suppliers/fleurop-nl` zeigt Konfiguration und Schreibfreigabe.
- `GET /v1/suppliers/fleurop-nl/products` liest das B2B-Sortiment des Debitors.
  `member_id` grenzt das Sortiment auf einen Floristen ein.
- `GET /v1/suppliers/fleurop-nl/availability` liefert zustellende Floristen und
  deren Verfügbarkeit für niederländische PLZ, Hausnummer und Zustelltermin.
- `GET /v1/suppliers/fleurop-nl/delivery-costs` reicht die Anbieterwerte für
  Kosten und Liefersteuer in der Originaleinheit durch. Die öffentliche
  Spezifikation gibt für diese Werte keine Einheit an.
- `POST /v1/suppliers/fleurop-nl/orders` ist bei `ordering: true` aktiv.
  Der Client gibt eine UUID und die zuvor ermittelten Artikel, Preise und
  Zustelldaten an. Die App verwendet die UUID als `clientOrderNumber` und
  speichert nur Referenz, Status und einen Hash der Bestelldaten.
- `GET /v1/suppliers/fleurop-nl/orders/{id}` liefert den lokalen Status.
  `POST /v1/suppliers/fleurop-nl/orders/{id}/reconcile` gleicht die Bestellung mit
  einer Anbieter-UUID ab. Die API prüft dabei die Geschäfts- und Bestellreferenz.

Fleurop dokumentiert beim Anlegen HTTP 201 ohne Antwortschema. Enthält
`Location` eine gültige Fleurop-Bestell-UUID, wird sie gespeichert. Fehlt sie,
liefert die App `remote_id: null`. Für den Statusabgleich kann die UUID anhand
der übermittelten Kundenreferenz im Fleurop-System ermittelt werden. Bei
`sending` oder `unknown` dieselbe UUID prüfen und keine Ersatzbestellung
anlegen, solange der Anbieterstatus ungeklärt ist.

Die Anbindung gilt für Fleurop NL. Für Fleurop Deutschland, BLUME2000,
Euroflorist, Landgard, FleuraMetz und Dutch Flower Group ist keine öffentlich
dokumentierte händlerspezifische Bestell-API bestätigt.

## Flower Shop Network

Die [FSN JSON API](https://api.flowershopnetwork.com/) richtet sich an Floristen
und POS-Partner. Das Secret `FSN_CONNECTIONS` enthält einen Eintrag pro Mandant
mit einem von FSN bereitgestellten Token.

```json
{
  "t_EXAMPLE": {
    "environment": "development",
    "account": "florist-one",
    "token": "<fsn-partner-token>",
    "ordering": false
  }
}
```

Produktivzugänge sind nur im Production-Worker zulässig. Entwicklertests
benötigen einen für das FSN-Entwicklungssystem freigeschalteten Token.

- `GET /v1/suppliers/flower-shop-network/products/{id}` liest einen bekannten
  Artikel des Floristen.
- `GET /v1/suppliers/flower-shop-network/florists` sucht nach US-PLZ, kanadischem
  Postleitzahlpräfix oder Stadt und Bundesstaat bzw. Provinz.
- `POST /v1/suppliers/flower-shop-network/orders` sendet den Auftrag, sofern
  `ordering` aktiviert ist. Preise und Steuerbeträge werden in Cents übergeben.
  Der Adapter rechnet daraus den von FSN verlangten Gesamtbetrag. Dieselbe
  UUID verhindert eine zweite Übermittlung.
- `GET /v1/suppliers/flower-shop-network/orders/{id}` liest den lokalen und,
  bei bekannter FSN-ID, den Anbieterstatus. Die Antwort enthält ausgewählte
  Statusfelder und keine Zahlungs- oder Empfängerdaten.

FSN liefert seine Auftrags-ID erst nach Annahme der Anfrage. Bei einem
unklaren Ausgang ohne FSN-ID kann nur der Anbieter den Auftrag zuordnen.
Die App wiederholt den Sendeaufruf dann nicht automatisch.

## Weitere Anbieter

[Flora@Home](https://floraathome.com/faq/) bietet eine API für Geschäftskunden.
Die früher öffentlich verlinkte Spezifikation führt inzwischen zum
Anmeldeportal. [Everspring](https://helpcenter.everspring.app/en/articles/4925281-api-integration)
bietet REST und auf Anfrage eine Sandbox. Die dort öffentlich verlinkte
[Channel-API](https://docs.everspring.app/) ist als veraltet gekennzeichnet.
Für beide braucht eine belastbare Implementierung die aktuelle Spezifikation.
