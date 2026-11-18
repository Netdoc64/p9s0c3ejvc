import { Text, View } from "react-native";
import { euro, type Order, type OrderSummary } from "../../contracts";
import { Button, Card, styles } from "../../ui";
import { OrderLines, TotalsView, type Screen } from "../shared";

const statuses: Record<Order["state"], string> = {
  draft: "Entwurf", resolving: "Wird geprüft", awaiting_confirmation: "Noch zu bestätigen",
  confirmed: "Bestätigt", shipped: "Versandt", invoiced: "Abgerechnet", paid: "Bezahlt",
  cancelled: "Storniert", on_hold: "Aktion erforderlich",
};

type Filter = "all" | Order["state"];
type OrdersProps = {
  pending: boolean; history: OrderSummary[]; filter: Filter; loading: boolean; go: (screen: Screen) => void;
  setFilter: (filter: Filter) => void; openOrderDetail: (order: OrderSummary) => void; refresh: () => void;
};

export function OrdersScreen({ pending, history, filter, loading, go, setFilter, openOrderDetail, refresh }: OrdersProps) {
  return <>
    {pending && <Button label="Offenen Bestellvorgang prüfen" secondary onPress={() => go("pending")} />}
    <View style={styles.row}>{(["all", "confirmed", "awaiting_confirmation", "on_hold", "cancelled"] as const).map((state) =>
      <Button key={state} label={state === "all" ? "Alle" : statuses[state]} secondary={filter !== state} onPress={() => setFilter(state)} />)}</View>
    {history.filter((value) => filter === "all" || value.state === filter).map((value) =>
      <Button key={value.id} label={`${value.customer_reference} · ${statuses[value.state]} · ${euro(value.totals.total_cents)}`} secondary onPress={() => openOrderDetail(value)} />)}
    {!loading && !history.some((value) => filter === "all" || value.state === filter) && <Text style={styles.muted}>Keine passenden Bestellungen.</Text>}
    <Button label="Bestellungen aktualisieren" secondary onPress={refresh} />
  </>;
}

type OrderProps = {
  order: Order; busy: boolean; pending: boolean; review: () => void; openInvoice: () => void;
  refresh: () => void; support: () => void;
};

export function OrderScreen({ order, busy, pending, review, openInvoice, refresh, support }: OrderProps) {
  return <>
    <Card><Text style={styles.heading}>{order.customer_reference}</Text><Text style={styles.body}>{statuses[order.state] ?? "Status aktualisieren"}</Text>
      <Text style={styles.muted}>{new Date(order.created_at).toLocaleDateString("de-DE")}</Text><OrderLines order={order} /></Card>
    <TotalsView quote={order.totals} />
    {order.state === "awaiting_confirmation" && order.allowed_actions?.includes("confirm") !== false && <Button label="Bestellung weiter prüfen" disabled={pending} onPress={review} />}
    {order.invoice_available ? <Button label="Rechnung öffnen" disabled={busy} onPress={openInvoice} /> : <Text style={styles.muted}>Rechnung noch nicht verfügbar.</Text>}
    <Button label="Status aktualisieren" secondary disabled={busy} onPress={refresh} />
    <Button label="Händler zu dieser Bestellung kontaktieren" secondary onPress={support} />
  </>;
}
