# Runbook — Stock-DO Reserve Latency

**SLO:** p99 < 100ms (`stock_reserve_p99`)

## Trigger

`p99(stock.reserve.duration_ms over 30m) > 100`

## Schritte

1. Per-DO-ID-Latenz prüfen (group by `tenant_id, warehouse_id, sku_id`)
2. Concurrent-Reservation-Volumen je DO?
3. Alarm-API für TTL-Cleanup zeitig?

## Wahrscheinliche Ursachen

- **Hot-SKU:** ein einzelner DO ist Bottleneck. Lösungen: Sub-DOs pro Lager-Bin (Plan-Revision M21+).
- **DO-Region-Routing:** falls der Tenant in einer anderen Region als `weur` ist.
- **Storage-Backpressure:** zuviele Reservations → langsamer Lookup. Cleanup-Cadence prüfen.

## Sofortmassnahme

- Reservierungs-TTL kürzen (verhindert Backlog)
- Tenant-spezifische Rate-Limit-Anpassung erwägen
