# M23 — Learnings

### What happened
`devices`-Tabelle (push_token unique-aktiv, customer-bound), `services/push.ts` mit `sendToCustomer` (Throttle 5/min via KV, APNs/FCM-Adapter als Stub mit structured log), `routes/devices.ts` (POST/DELETE).

### Decisions
1. **APNs/FCM-Adapter sind Stubs**: echte Provider-Calls sind Plan-Revision-Kandidat (Tenant-spezifische Apple-Team-ID, FCM-Server-Key, JWT für APNs). v1 logged Push-Versuche → CI-konformer Smoke ohne externe Abhängigkeit.
2. **Quiet-Hours**: nicht aktiv weil Customer-Timezone-Feld fehlt. Plan-Revision-Kandidat.
3. **Auto-Cleanup für invalide Tokens** (`invalidateToken`) ist verfügbar, wird aber nicht automatisch aus 410/404-Receiver-Responses getriggert (das passiert erst wenn echte APNs/FCM-Adapter da sind).
