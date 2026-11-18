# Frontend-Bauplan für den Blumen-Großhandel

**Stand** · Planungsübergabe auf Basis von Backend-Commit `a540ecf` abgeschlossen. Die Nutzerabläufe sind simuliert. Mock-Pakete sind startklar. Preise, Warenverfügbarkeit und Verhalten im Pilotbetrieb benötigen die dokumentierten fachlichen Freigaben und Tests auf Staging und Geräten.

**Detaillierter Bauplan** · [frontend-build-plan.json](frontend-build-plan.json) enthält pro Modul die Planungsdurchläufe, Screens, Bedienelemente, Zustände, Übergänge und Abnahmekriterien. Der Abschnitt `backend_alignment` verknüpft alle 25 Backend-Module und sieben zurückgestellte Themen mit dem Frontend. `scenario_traces` hält die geprüften Schrittabfolgen fest. Die folgende Übersicht beschreibt den Pilotumfang und den Backend-Stand.

**Ziel** · Eine Floristin kann sich morgens am Handy anmelden, die richtige Ware in der richtigen Einheit finden, ihren Kundenpreis prüfen, auf Rechnung bestellen und den Auftrag später wiederfinden. Der Innendienst kann denselben bestätigten Auftrag anhand seiner Referenz identifizieren und bearbeiten.

## 1. Pilotumfang und technische Entscheidung

- **Pilotannahme** · Bestehende Kunden eines Großhändlers, eine Kundenidentität je Konto, EUR, Bestellung auf Rechnung. Der Einstieg erfolgt über eine Einladung oder eine für den Pilot fest konfigurierte Händlerzuordnung. Die Oberfläche startet auf Deutsch und hält Texte zentral für weitere Sprachen.
- **App-Vorschlag** · Expo mit React Native und TypeScript, Expo Router für Navigation, TanStack Query für Serverdaten und SecureStore für Sitzungsschlüssel. Das mobile Ziel folgt dem Backend-Plan. Ein gemeinsamer iOS-/Android-Codepfad und installierbare Testbuilds erlauben frühe Tests auf beiden Plattformen. Plattformen für die erste Pilotgruppe werden in F00 festgelegt.
- **Navigation nach dem Login** · Katalog, Warenkorb, Bestellungen, Konto. Der Katalog ist der Startpunkt. Produktdetails und Bestellprüfung liegen im jeweiligen Ablauf, die Bestätigung führt direkt zum Bestelldetail.
- **Nach dem Pilot** · Weitere Händler im selben Client, Mehrpersonen-Firmenkonten, Kunden-Push, vollständiges Rechnungsarchiv, Admin-Oberfläche und Web-Portal. Der Pilot nutzt einen bestätigten Übergabeweg für den Innendienst. Kartenzahlung, wählbare Lieferfenster und ERP-Automatisierung sind eigenständige Erweiterungen.

## 2. Was der Backend-Stand für die App bedeutet

| Bereich | Im Code vorhanden | Voraussetzung für die App |
|---|---|---|
| Login | `/v1/auth/magic-link/request` verschickt konzeptionell einen 8-stelligen E-Mail-Code. `/oauth/authorize` und `/oauth/token` unterstützen den Austausch via PKCE und rotierende Refresh-Tokens. Der Worker verwendet Cloudflare Email Service über `EMAIL` und `MAIL_FROM`. Fehlt der Versand außerhalb der Entwicklung, meldet die Route `GH-EXT-003`. | Händlerzuordnung festlegen, Cloudflare-Versand auf Staging verifizieren, Testpostfach und den kompletten Login mit Ablauf und Erneuerung prüfen. |
| Kunden-API | `/v1/customer` mountet mit Kunden-JWT derzeit Geräterouten. Katalog, Preis, Bestand, Bestellungen und Rechnung liegen in der Tenant-API mit API-Key und HMAC. MCP deckt Teile der Kundenfunktionen ab. | Eigene REST-Operationen für die App auf Basis der vorhandenen Backend-Logik. Tenant-Zugangsdaten bleiben serverseitig. MCP bleibt ein separater Kanal. |
| Katalog und Preise | Produktdaten enthalten SKU, Mindestmenge, Verpackungen und Attribute. Tenant-Routen bieten Liste, Suche, Details und Einzelpreisangebot. Bilder können hochgeladen werden. | Aktive Artikel und zulässige Bilder als Kundenansicht liefern. Maße, Artikelnummer und Gebinde verständlich anzeigen. Bis eine Bildauslieferung bereitsteht, braucht der Pilot einen lesbaren Text-Fallback. |
| Bestand | Bestandsabfrage braucht SKU und Lager. Die Bestellung nutzt Reservierung und bei verderblichen Artikeln eine Prüfung der Restlaufzeit. Der Pilot verwendet `wh_main`, der Orchestrator liest das Händler-Standardlager vor dem Fallback `wh_default`. | Das Backend ordnet das Pilotlager ausdrücklich zu und meldet bestellbare Menge nur nach vereinbarter Prüfung. Für einen realen Warenkorbtest müssen sowohl wirksamer Bestand im Durable Object als auch passende Chargen im Testsystem vorhanden sein. |
| Bestellung | Tenant-API legt einen Auftrag an, berechnet Preise und Steuern, reserviert Ware und wartet auf Bestätigung. Bestätigung und Abbruch sind eigene Operationen. Bei Bestands- oder Restlaufzeitkonflikten speichert der Orchestrator `on_hold` mit Positionsproblemen. `notes` wird beim Erstellen validiert, aber der Handler übernimmt es nicht ins gespeicherte Dokument. | Kundenbezogene Schreib- und Leseoperationen, wiederholbare Requests und reduzierte Antwortdaten. Das Notizfeld erst freigeben, wenn es gespeichert und für den Innendienst sichtbar ist. |
| Rechnung und Betrieb | Die Bestätigungskette führt den PDF-Schritt aus. Bestellung und Outbox-Ereignis werden gemeinsam gespeichert. Der erzeugte Rechnungsverweis liegt am Auftrag. Es gibt Tenant-Downloads und signierte Links. Der Client-Version-Guard ist implementiert, im Einstiegspunkt aber nicht aktiviert. | PDF erst bei tatsächlicher Verfügbarkeit anbieten und Kundenzugriff auf den zugehörigen Auftrag prüfen. Die App sendet Plattform und Version. Ein erzwungenes Update setzt einen eingebundenen und getesteten Guard, ein geprüftes Updateziel und die Wiederaufnahme offener Vorgänge voraus. |

Geprüfte Codepfade · [Routen-Einstieg](../src/index.ts), [Auth-Routen](../src/routes/auth.ts), [E-Mail-Adapter](../src/auth/email.ts), [Produkte](../src/routes/products.ts), [Bestellungen](../src/routes/orders.ts), [Orchestrator](../src/orchestrator/handlers.ts), [Rechnungen](../src/routes/invoices.ts), [Pilot-Seed](../scripts/seed-pilot.ts), [Smoke-Test](../scripts/smoke.ts), [Backend-Bauplan](build-plan.md).

## 3. Nutzerablauf und Abnahme pro Abschnitt

Alle Zitate sind simulierte Nutzerfragen. Die Abnahme ist als beobachtbares Verhalten für den umsetzenden Agenten formuliert.

### F01 · Einstieg und Anmeldung

**„Ich öffne die App zum ersten Mal. Woher weiß sie, bei wem ich bestelle, und wo finde ich meinen Code?“**

- **Oberfläche** · Händlername und E-Mail-Eingabe, dann Code-Eingabe mit Einfügen aus der Zwischenablage, E-Mail ändern und Code erneut anfordern. Bei lokal erkanntem Fristablauf oder Ratenlimit bleibt klar, was als Nächstes möglich ist. Serverseitig führen falsche und abgelaufene Codes derzeit zum selben Fehler. Die Oberfläche bietet dafür eine gemeinsame Meldung und einen verständlichen nächsten Schritt. Die Bestätigung der Code-Anforderung ist für bekannte und unbekannte Adressen gleich formuliert.
- **Backend** · `X-Tenant-Slug` aus dem verifizierten Händlerkontext. E-Mail-Code anfordern, dann genau einen Code-Austausch über PKCE verwenden. Sitzungserneuerung pro Konto bündeln, damit parallele Requests nicht denselben rotierenden Refresh-Token verbrauchen. Abmeldung widerruft den Refresh-Token soweit erreichbar und löscht lokale Sitzungs- und Kundendaten.
- **Abnahme** · Eine Testkundin erhält tatsächlich einen Code im Testpostfach und landet im richtigen Katalog. Ein abgelaufener Code führt zum neuen Code, ein App-Neustart setzt eine gültige Sitzung fort, und nach Abmeldung öffnet die App keine zwischengespeicherten Kundendaten.

### F02 · Katalog, Suche und Produktdetail

**„Ich brauche rote Rosen mit 60 cm. Wie erkenne ich, ob ein Karton 50 Stiele enthält und welchen Preis ich bekomme?“**

- **Oberfläche** · Einstieg über Katalog oder Suche nach Name und SKU. Liste mit Name, Variante, Gebinde und Bild-Fallback. Im Detail stehen Mindestmenge, Mengeneingabe und Kundenpreis für die gewählte Menge. Strukturierte Filter für Farbe oder Länge erst anbieten, wenn der Pilotkatalog die Attribute zuverlässig liefert.
- **Backend** · Such- und Listenoperationen mit Kundensicht, Seitennavigation und aktiven Artikeln. Gleiche Basis für Preisangebot und Bestellung. F00 legt je Pilot-SKU fest, was `qty` zählt, worauf sich der Preis bezieht und welche Menge dem Mindestwert entspricht. Ein Preis für ein Gebinde wird eindeutig als Gebindepreis bezeichnet.
- **Abnahme** · Die Kundin findet eine 60-cm-Variante anhand von Name oder SKU und vergleicht sie mit einer anderen Variante. Stückzahl pro Gebinde, Mindestmenge und Preisbasis stimmen mit den Testdaten überein. Zwei Testkunden sehen für dieselbe SKU ihre jeweils gültigen Preise. Leere Suche und nicht ladbarer Katalog sind unterscheidbar.

### F03 · Warenkorb und Preisprüfung

**„Ich erhöhe von neun auf zehn Kartons. Gilt jetzt die Staffel? Ist die Menge noch verfügbar?“**

- **Oberfläche** · Positionen ändern oder entfernen, Warenkorb mit App-Neustart wiederfinden. Bei Mengenänderung Preis neu laden. Positionen mit veraltetem Angebot bleiben erkennbar. Unter Mindestmenge zeigt die App die erlaubte Eingabe. Netzverlust erhält den Warenkorb als Entwurf. Beim Bestandskonflikt bleiben die übrigen Positionen erhalten.
- **Backend** · Kundenspezifische Preisvorschau für den gesamten Warenkorb mit Positionen, Währung und Preisbasis. Verwendung derselben Preis- und Steuerregeln wie im Auftrag. Bestandsindikator ist eine Momentaufnahme. Die verbindliche Prüfung und Reservierung passieren in F04.
- **Abnahme** · Ein Staffelwechsel aktualisiert den Kundenpreis. Nach Netzunterbrechung bleiben die Mengen erhalten. Abmeldung entfernt den lokalen Warenkorb. Eine nicht verfügbare Position bleibt bearbeitbar, während die anderen Positionen unverändert bleiben.

### F04 · Prüfen, reservieren und bestellen

**„Was bezahle ich insgesamt, wohin geht die Ware, und war der Klick erfolgreich, obwohl der Empfang weg war?“**

- **Oberfläche** · „Bestellung prüfen“ legt einen Entwurf an und zeigt berechnete Netto-, Steuer- und Gesamtbeträge, bestätigte Mengen sowie die vereinbarte Lieferart. Weicht der Entwurf von der Vorschau ab, zeigt die App die Änderung vor dem verbindlichen Schritt. Nur ein bestätigbarer Entwurf bietet „Verbindlich bestellen“. Anschließend erscheinen Bestellreferenz und tatsächlicher Status.
- **Backend** · Bestehende Orchestrierung in die Kunden-API einbinden. Kunde und Lager werden serverseitig ermittelt. Entwurf, Abbruch und Bestätigung erhalten getrennte, je Kundenaktion stabile Idempotenzschlüssel. Die Bestätigung gilt nur für die gezeigte Auftragsrevision. Die Kunden-API braucht für kritische Schreibvorgänge einen dauerhaft nachschlagbaren Operationseintrag. Eine Wiederholung mit demselben Schlüssel und demselben Inhalt liefert denselben Vorgang. Bei verlorener Antwort ermittelt die App den vorhandenen Auftrag. Änderungen erzeugen erst nach kontrolliertem Abbruch oder Ablauf der alten Reservierung einen neuen Entwurf. F00 klärt, wann eine Reservierung endet und wie gesperrte oder teils fehlgeschlagene Reservierungen aufgeräumt werden.
- **Abnahme** · Ein Doppeltipp und eine verlorene Antwort mit anschließendem Wiederholen ergeben je genau einen Auftrag und eine Bestandsbuchung. Bei fehlender Restlaufzeit, zu knappem Bestand, gesperrtem Konto oder überschrittenem Kreditlimit sieht die Kundin einen verständlichen nächsten Schritt. Zwei Testgeräte können den letzten verfügbaren Bestand nicht beide erfolgreich bestellen. Bei abgelaufener Reservierung kann die Kundin neu prüfen. Eine konkrete Adresse, Abholung oder Lieferzusage wird nur angezeigt, wenn der vereinbarte Pilotprozess sie tatsächlich trägt.

### F05 · Bestellhistorie, Status und Rechnung

**„Ist meine Bestellung wirklich eingegangen? Kann ich sie morgen öffnen und die Rechnung herunterladen?“**

- **Oberfläche** · Eigene Bestellungen nach Datum mit Lade-, Leer- und Fehlerzuständen. Detail enthält Menge, Artikelbezeichnung, Beträge, Referenz und verständlichen Status. `awaiting_confirmation` erscheint als „Noch zu bestätigen“, `confirmed` als „Bestätigt“ und `on_hold` je nach Grund als „Aktion erforderlich“ oder „Wird geprüft“. Rechnung zum Öffnen oder Teilen anbieten, sobald das PDF tatsächlich verfügbar ist. Eine fehlende Rechnung ändert den Bestellstatus nicht. Stornierung bestätigter Aufträge nur bei fachlicher Freigabe der Aktion.
- **Backend** · Eigene Aufträge paginieren. Produktname und Verkaufseinheit historisch festhalten, damit Umbenennungen alte Belege nicht verändern. Kundenansicht und PDF-Zugriff aus dem verifizierten Auftrag ableiten. Eine Versandstufe erscheint nur, wenn sie aus einem betriebenen Prozess aktualisiert wird.
- **Abnahme** · Nach neuem Login ist dieselbe Bestellung auffindbar. Ein anderes Konto desselben Händlers kann weder Detail noch PDF lesen. Ein fehlgeschlagenes PDF bleibt getrennt von der bestätigten Bestellung und kann nach Behebung geöffnet werden. Der Innendienst findet denselben Auftrag über seine Referenz.

### F06 · Konto, Support und späteres Wiederbestellen

**„Wer hilft mir, wenn Preis oder Lieferadresse falsch sind? Kann ich die Bestellung nächste Woche wiederholen?“**

- **Oberfläche** · Im Pilot zeigt das Konto den angemeldeten Betrieb, Händlerkontakt und Abmeldung. Support aus dem Bestelldetail übernimmt nur die nötige Referenz. Stammdatenänderungen laufen im Pilot über den vereinbarten Kontakt. Danach kann „Erneut bestellen“ Positionen eines alten Auftrags als neuen Warenkorbvorschlag übernehmen.
- **Backend** · Minimale `me`-Antwort und Händlerkontakt. Für Wiederbestellung jede SKU, Menge, Preis und Verfügbarkeit aktuell prüfen. Ausgelistete Artikel bleiben als Hinweis in der Vorschau sichtbar.
- **Abnahme** · Die Testkundin findet eine Kontaktmöglichkeit mit Bestellreferenz und kann sich vollständig abmelden. Nach Freigabe der Wiederbestellung entsteht aus einem Altauftrag zunächst ein bearbeitbarer Warenkorb. Eine Bestellung erfordert die normale Bestätigung.

## 4. Vorgeschlagener API-Vertrag für Frontend und Backend

Die Pfade sind neue Kundenschnittstellen unter `/v1/customer`. F00 hält Felder, Fehler und Beispielantworten in OpenAPI fest, bevor getrennte Agenten dagegen bauen.

| Bedarf | Vorgeschlagene Operation | Antwort und Verhalten |
|---|---|---|
| Konto und Händler | `GET /me` | Betriebsname, Händlername, Supportkontakt und freigegebene Angaben zum Pilotprozess |
| Katalog | `GET /products`, `GET /products/{id}` | Suche und Cursor in der Liste, aktive SKU, Name, Variante, Verkaufseinheit, Mindestmenge und optionale Bild-URL |
| Preisvorschau | `POST /quotes` | SKU, Menge, Preisbasis, Geldwerte in Cents, Währung, Positionsprobleme und Zeitpunkt der Prüfung |
| Entwurf und Bestätigung | `POST /orders`, `POST /orders/{id}/confirm`, `POST /orders/{id}/cancel` | Kundenansicht mit Kennung, Status, Beträgen, zulässigen Aktionen und gegebenenfalls Reservierungsfrist. Klarer Wiederholungs- und Konfliktvertrag |
| Unklarer Bestellausgang | `GET /order-operations/{id}` | Eigene Operation nach Netzverlust wiederfinden und deren tatsächlichen Ausgang feststellen. |
| Historie und Einzelauftrag | `GET /orders`, `GET /orders/{id}` | Eigene Aufträge mit Cursor, Bestellreferenz, historischer Positionsansicht und Rechnungsverfügbarkeit |
| Rechnung | `GET /orders/{id}/invoice` | Nach Eigentümerprüfung PDF oder ein kurzlebiger Download. Die Antwort unterscheidet Verfügbarkeit von einem vorübergehenden Fehler. |

- Tenant und Kunde werden aus der geprüften Sitzung abgeleitet. Jede Abfrage und Mutation prüft die Zuordnung am Server. Idempotenz ist pro Tenant, Kunde und Aktion isoliert. Der Kundenvertrag gibt nur freigegebene Felder aus. Interne Dokumentteile wie `audit`, `gates_log`, Lager- und Reservierungsdaten werden serverseitig ausgefiltert.
- Der Client übersetzt stabile Fehlercodes in konkrete Handlungsmöglichkeiten. Ein unbekannter Zustand bleibt neutral und bietet Aktualisieren oder Support mit Request-ID. Bei Statuskonflikten lädt die App den Auftrag erneut. Wiederholungen von Schreibvorgängen behalten Schlüssel und ursprünglichen Inhalt.
- Preis, Menge, Verfügbarkeit und Status haben einen gemeinsamen Vertrag. Die App zeigt Geld und Zeit lokal formatiert an. Sie hält Aktualität und Ladezustand sichtbar, und kritische Meldungen funktionieren mit Screenreader und ohne Farbcodierung.

## 5. Bau-Reihenfolge und offene Entscheidungen

| Paket | Abhängigkeit | Ergebnis |
|---|---|---|
| **F00 · Pilotvertrag und Testdaten** | Backend-Stand `a540ecf` | Pilotentscheidungen, OpenAPI-Beispiele, gesichertes Staging, zwei Kunden mit unterschiedlichen Preisen, Testpostfach und tatsächlich bestellbare Ware im vorgesehenen Lager. |
| **F01 · Anmeldung und App-Grundgerüst** | F00 für Integration | Installierbarer Build und funktionierende Kundensitzung. Kann parallel zur Kunden-API und den Katalogansichten gebaut werden, sobald der Vertrag steht. |
| **F02 · Katalog** | F00 und F01 für Abnahme | Kundin findet eine SKU und versteht Gebinde und Preis. Das Frontend kann gegen vereinbarte Beispielantworten beginnen. |
| **F03 · Warenkorb** | F02 | Menge ändern und aktuellen Preis prüfen. |
| **F04 · Checkout** | F03, Kunden-Schreiboperationen und Pilot-Lieferprozess | Erster durchgehender Auftrag bis zur bestätigten Referenz im Innendienst. |
| **F05 · Historie und Rechnung** | F04 für Abnahme | Auftrag und verfügbare Rechnung wiederfinden. Leseschnittstellen und Ansichten lassen sich nach F00 parallel vorbereiten. |
| **F06 · Konto und Support** | F01 und F05 für Abnahme aus dem Bestelldetail | Händlerkontakt und Abmeldung im Pilot. Wiederbestellung als späteres Paket. |
| **F07 · Gerätetest und Pilotübergabe** | F00, F04, F05 und F06 | Installierbarer Pilotbuild, getestete Kernstrecke und geprüfter Eingang beim Innendienst. |

**F00 klärt diese Fragen vor der Freigabe der betreffenden Umsetzung.**

1. **Wie kommen Pilotkunden in die App?** Vorschlag · ein fest zugeordneter Händler, nur bestehende Konten, Verteilung als interner iOS-/Android-Testbuild je nach Pilotgeräten.
2. **Was bedeutet eine bestellte Einheit?** Der Händler bestätigt die Basis für `qty`, Mindestmenge, Gebindeumrechnung und Preis. Ein Beispielartikel muss in Katalog, Warenkorb und Rechnung dieselbe Menge ergeben.
3. **Wie gelangt eine Bestellung in die Bearbeitung?** Händler entscheidet über feste Lieferadresse oder Abholung sowie den Übergabeweg an den Innendienst. Als Pilot ist ein manueller Prozess mit einem zugriffsgeschützten Auftragsabruf und einer benannten Zuständigkeit möglich. Eine zugesagte Lieferzeit braucht eine betriebliche Grundlage.
4. **Wann darf die Kundin abbrechen oder stornieren?** Vorschlag · einen unbestätigten Entwurf abbrechen, bei verbindlich bestätigten Aufträgen im Pilot den Support kontaktieren. Das Backend liefert die tatsächlich erlaubten Aktionen.
5. **Wann muss die Rechnung in der App vorliegen?** Vorschlag · PDF aus dem eigenen Auftrag anbieten. Vor dem Pilot festlegen, wie ein fehlgeschlagener PDF-Lauf erkannt und nachgeholt wird und welchen Rechnungsweg der Innendienst bis dahin nutzt.
6. **Welche Märkte kommen in den Pilot?** Vorschlag · mit einer deutschsprachigen Gruppe starten. Bei mehreren Zielländern die tatsächlich verwendeten Steuer- und Lieferfälle vor Freigabe mit den jeweiligen Testkonten durchspielen.

## Übergabe an die umsetzenden Agenten

Im JSON stehen unter `implementation_handoff` elf Arbeitspakete mit Zuständigkeit, Abhängigkeiten, Ergebnis und verknüpften Abnahmefällen. Login, Katalog, Warenkorb, Checkout und Historie können mit den vereinbarten Mock-Antworten vorbereitet werden. Die Freigaben in F00 bestimmen, welche Pakete mit Staging-Daten integriert und für den Pilot abgenommen werden.

Unter `api_contract.pilot_fixture` stehen Beispielanfragen, Antworten und UI-Zustände für einen erfolgreichen Auftrag, einen Preiswechsel, eine verlorene Bestätigungsantwort und einen Bestandskonflikt. Zwei weitere Fälle prüfen ein ungeklärtes Ergebnis ohne Wiederholungsfreigabe und eine abgewiesene Auftragsrevision. `api_contract.checkout_recovery` verknüpft Serverergebnisse mit den passenden Anzeigen und Aktionen. Die Preise, Steuer und Mengen sind synthetisch. Sie dienen als Planungs- und Testdaten bis zur fachlichen Bestätigung.

## 6. Prüfung vor der Pilotfreigabe

- **Pro Pull Request** · Typprüfung, Build und Tests. API-Vertragstests decken Kontentrennung, Preisbasis, Warenkorbsummen, konkurrierende Reservierungen und wiederholte Bestätigung ab. Änderungen mit Backend-Abhängigkeit laufen gegen vereinbarte Fixtures und vor der Abnahme gegen Staging.
- **Automatisierter Geräteablauf** · Mit Maestro als vorgeschlagenem Testwerkzeug steigt eine Testkundin über den E-Mail-Code ein, sucht einen Artikel, wechselt die Mengenstaffel, bestätigt und findet den Auftrag nach App-Neustart wieder. Für Fehlerabläufe werden Session-Ablauf, kein Netz nach dem Absenden, Reservierungsablauf, fremde Bestellreferenz und fehlendes PDF gezielt geprüft. CI nutzt ein isoliertes Testpostfach und künstliche Kundendaten.
- **Agentenabnahme** · Ein Agent spielt den Ablauf auf den vorgesehenen Pilotplattformen als Kundin und als Innendienst durch. Der PR dokumentiert Gerät oder Build, Szenario, Ergebnis und bekannte offene Punkte. Rechnungs- und Auftragsdaten aus echten Kundenkonten gehören nicht in die Testnachweise.
- **Pilotfreigabe** · Der Händler bestätigt Einheit, Preis, Steuer und Übergabe eines vollständigen Beispielauftrags. Die Testgruppe kann sich anmelden, mindestens einen echten Testauftrag bestätigen, ihn wiederfinden und Hilfe erreichen. Ein mobiles Testpaket und ein dokumentierter Start- und Testablauf stehen bereit. Bei doppelter Buchung, falschem Betrag, fremden Kundendaten oder verfehlter Auftragsübergabe pausiert die Pilotaufnahme bis zur Behebung.

## Plan im Repo prüfen

```sh
node scripts/check-frontend-plan.mjs
```

Der Befehl prüft Abhängigkeiten, Quellen, klickbare Ziele und den Zusammenhang zwischen Beispielpayloads und Vertragsfeldern. Ein Defekt in der Planung führt zu einem Fehlercode. Gerätetests und Tests gegen die Staging-API folgen bei der Umsetzung. Unter `handoff_readiness` steht, welcher Nachweis für die sechs verbleibenden Pilotentscheidungen benötigt wird.
