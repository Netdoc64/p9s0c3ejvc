# Händler-Dashboard

Aus diesem Ordner mit `npm start` starten und im Browser `http://127.0.0.1:8082` öffnen. Für Typecheck und Tests einmal `npm ci` ausführen. Mit `npm run build` werden die statischen Dateien nach `dist/` kopiert. Ohne API-Adresse zeigt das Dashboard lokale Beispieldaten. Für den Live-Build vor `npm run build` die Umgebungsvariablen `GROSSHANDEL_API_URL` und `GROSSHANDEL_TENANT_SLUG` setzen. In der Live-Ansicht sind Stückpreise kundenabhängig. Die sechs Bereiche sind über URL-Fragmente direkt erreichbar.

`data.mjs` bündelt die Abfragen für die spätere Mitarbeiter-Anmeldung. Produktpreise beziehen sich in der Demo auf den Beispielkunden. Bestände sind je Artikel und Lager gruppiert.
