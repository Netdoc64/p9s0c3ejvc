import { Text } from "react-native";
import type { Order } from "../../contracts";
import { Button, Card, Message, styles } from "../../ui";
import { OrderLines, TotalsView, type Screen } from "../shared";

type ReviewProps = {
  screen: "review" | "issue"; order: Order; orderExpired: boolean; changed: boolean; demo: boolean;
  busy: boolean; pending: boolean; cancelPrompt: boolean;
  setCancelPrompt: (value: boolean) => void; confirm: () => void; cancel: () => void; support: () => void;
};

export function ReviewScreen({ screen, order, orderExpired, changed, demo, busy, pending, cancelPrompt,
  setCancelPrompt, confirm, cancel, support }: ReviewProps) {
  const accountHold = order.issues?.some((issue) => ["GH-CUST-003", "GH-CUST-004"].includes(issue.code));
  const issueMessage = orderExpired ? "Die Reservierung ist abgelaufen."
    : accountHold ? "Bitte kläre diese Bestellung mit deinem Händler."
      : "Die ausgewählte Menge ist derzeit nicht vollständig bestellbar.";
  return <>
    {screen === "issue" ? <Message error>{issueMessage}</Message>
      : changed && <Message>Der Auftrag hat sich geändert. Prüfe die aktuellen Positionen und Beträge vor der Bestätigung.</Message>}
    <Card><Text style={styles.heading}>{order.customer_reference}</Text><OrderLines order={order} /></Card>
    <TotalsView quote={order.totals} />
    <Text style={styles.body}>Zahlung auf Rechnung{demo ? " · vereinbarte Testlieferung" : ""}</Text>
    {order.reservation_expires_at && <Text style={styles.muted}>{orderExpired ? "Reservierung abgelaufen" : `Reserviert bis ${new Date(order.reservation_expires_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`}</Text>}
    {screen === "review" && <Button label="Verbindlich bestellen" disabled={busy || orderExpired || order.state !== "awaiting_confirmation" || order.allowed_actions?.includes("confirm") === false || pending}
      onPress={confirm} />}
    {cancelPrompt ? <Card>
      <Text style={styles.body}>Die Reservierung wird freigegeben. Deine Auswahl bleibt im Warenkorb.</Text>
      <Button label="Reservierung freigeben" disabled={busy} onPress={cancel} />
      <Button label="Prüfung fortsetzen" secondary disabled={busy} onPress={() => setCancelPrompt(false)} />
    </Card> : <Button label="Warenkorb bearbeiten" secondary disabled={busy || pending} onPress={() => setCancelPrompt(true)} />}
    <Button label="Händler kontaktieren" secondary onPress={support} />
  </>;
}

type PendingProps = {
  pending: boolean; busy: boolean; canRepeat: boolean; go: (screen: Screen) => void;
  checkPending: () => void; repeatPending: () => void; support: () => void;
};

export function PendingScreen({ pending, busy, canRepeat, go, checkPending, repeatPending, support }: PendingProps) {
  return <>
    <Text style={styles.body}>Prüfe den Status, bevor du erneut bestellst. Der Vorgang bleibt gespeichert.</Text>
    <Button label="Status prüfen" disabled={!pending || busy} onPress={checkPending} />
    {canRepeat && pending && <Button label="Vorgang erneut senden" disabled={busy} secondary onPress={repeatPending} />}
    <Button label="Zu meinen Bestellungen" secondary onPress={() => go("orders")} />
    <Button label="Händler kontaktieren" secondary onPress={support} />
  </>;
}

type ConfirmationProps = { order: Order; viewOrder: () => void; copyReference: () => void; continueShopping: () => void };

export function ConfirmationScreen({ order, viewOrder, copyReference, continueShopping }: ConfirmationProps) {
  return <>
    <Message>Deine Bestellnummer lautet {order.customer_reference}.</Message>
    <TotalsView quote={order.totals} />
    <Button label="Bestellung ansehen" onPress={viewOrder} />
    <Button label="Bestellnummer kopieren" secondary onPress={copyReference} />
    <Button label="Weiter einkaufen" secondary onPress={continueShopping} />
  </>;
}
