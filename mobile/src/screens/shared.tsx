import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { euro, type Order, type Quote } from "../contracts";
import { Button, Card, Input, Message, styles } from "../ui";

export type Screen = "catalog" | "product" | "cart" | "review" | "pending" | "issue" | "success" | "orders" | "order" | "account" | "logout" | "support";

export function TotalsView({ quote, netOnly }: { quote: Quote["totals"]; netOnly?: boolean }) {
  return <Card>
    <Text style={styles.body}>Netto · {euro(quote.subtotal_cents, quote.currency)}</Text>
    {netOnly ? <Text style={styles.muted}>Steuer und Gesamtbetrag erscheinen bei der Bestellprüfung.</Text> : <>
      <Text style={styles.body}>Steuer · {euro(quote.tax_cents, quote.currency)}</Text>
      <Text style={styles.heading}>Gesamt · {euro(quote.total_cents, quote.currency)}</Text>
    </>}
  </Card>;
}

export function Quantity({ label, qty, min, change, invalid, disabled }: { label: string; qty: number; min: number; change: (qty: number) => void; invalid: (value: boolean) => void; disabled?: boolean }) {
  const [text, setText] = useState(String(qty));
  useEffect(() => { setText(String(qty)); }, [qty]);
  const valid = /^\d+$/.test(text) && Number(text) >= min && Number(text) <= 500;
  return <View style={styles.stack}>
    <Input label={label} value={text} onChangeText={(value) => {
      setText(value);
      const number = Number(value);
      const validValue = /^\d+$/.test(value) && number >= min && number <= 500;
      invalid(!validValue);
      if (validValue) change(number);
    }} keyboardType="number-pad" editable={!disabled} maxLength={3} />
    {!valid && <Message error>Gib eine ganze Menge zwischen {min} und 500 ein.</Message>}
    <View style={styles.row}>
      <Button label="Menge verringern" secondary disabled={disabled || qty <= min} onPress={() => { setText(String(qty - 1)); invalid(false); change(qty - 1); }} />
      <Button label="Menge erhöhen" secondary disabled={disabled || qty >= 500} onPress={() => { setText(String(qty + 1)); invalid(false); change(qty + 1); }} />
    </View>
  </View>;
}


export function OrderLines({ order }: { order: Order }) {
  return order.lines.map((line) => <View key={line.sku_id} style={styles.spread}>
    <Text style={styles.body}>{line.qty} × {line.sale_unit} · {line.name}</Text>
    <Text style={styles.body}>{euro(line.unit_price_cents, order.totals.currency)} je Einheit</Text>
  </View>);
}
