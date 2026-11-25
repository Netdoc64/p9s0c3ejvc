import { monotonicFactory, ulid as ulidNonMonotonic } from "ulid";

// Per build-plan §cross_cutting.ids.prefixes:
// t_, cust_, sku_, ord_, inv_, shp_, pay_, wh_, pl_
// + Implementations-Bedarf: k_ (api-keys), res_ (reservations), evt_ (events),
//   whs_ (webhook subscriptions), dev_ (devices)
//
// WICHTIG: Prefixe dürfen niemals Präfix eines anderen Prefix sein.
// `wh_` (warehouse) und `wh_sub_` würden kollidieren — daher `whs_` für Webhooks.
export const ID_PREFIXES = {
  tenant: "t_",
  customer: "cust_",
  product: "sku_",
  order: "ord_",
  invoice: "inv_",
  shipment: "shp_",
  payment: "pay_",
  warehouse: "wh_",
  price_list: "pl_",
  api_key: "k_",
  reservation: "res_",
  event: "evt_",
  webhook: "whs_",
  device: "dev_",
  return_case: "rtc_",
  return_line: "rtl_",
  return_handoff: "rth_",
  staff: "stf_",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const monotonicUlid = monotonicFactory();

export function newId(kind: IdKind): string {
  return ID_PREFIXES[kind] + monotonicUlid();
}

export function newRequestId(): string {
  return ulidNonMonotonic();
}

export function isIdOf(value: string, kind: IdKind): boolean {
  return value.startsWith(ID_PREFIXES[kind]);
}

// Sortierte Prefix-Liste (längste zuerst) damit `whs_` vor `wh_` matched.
const SORTED_PREFIXES: Array<[IdKind, string]> = (Object.entries(ID_PREFIXES) as Array<[IdKind, string]>)
  .sort((a, b) => b[1].length - a[1].length);

export function parseIdKind(value: string): IdKind | null {
  for (const [kind, prefix] of SORTED_PREFIXES) {
    if (value.startsWith(prefix)) return kind;
  }
  return null;
}
