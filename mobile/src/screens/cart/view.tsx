import type { Dispatch, SetStateAction } from "react";
import { Text, View } from "react-native";
import { euro, type LineInput, type Product, type Quote } from "../../contracts";
import { Button, Card, styles } from "../../ui";
import { Quantity, TotalsView, type Screen } from "../shared";

type CartProps = {
  cart: LineInput[]; products: Record<string, Product>; removed?: LineInput; activeQuote?: Quote;
  pending: boolean; openOrder: boolean; cartLocked: boolean; busy: boolean; invalidFields: Record<string, boolean>; error: string;
  go: (screen: Screen) => void; enterProduct: (item: Product) => void; showOpenOrder: () => void;
  invalidField: (id: string, invalid: boolean) => void; setCart: Dispatch<SetStateAction<LineInput[]>>;
  setRemoved: (line?: LineInput) => void; refresh: () => void; reviewOrder: (quote: Quote) => void;
};

export function CartScreen({ cart, products, removed, activeQuote, pending, openOrder, cartLocked, busy,
  invalidFields, error, go, enterProduct, showOpenOrder, invalidField, setCart, setRemoved, refresh, reviewOrder }: CartProps) {
  return <>
    {pending ? <Button label="Bestellstatus prüfen" onPress={() => go("pending")} /> : openOrder &&
      <Button label="Offene Bestellung ansehen" onPress={showOpenOrder} />}
    {!cart.length && <Text style={styles.muted}>Dein Warenkorb ist leer.</Text>}
    {cart.map((line) => {
      const item = products[line.sku_id];
      const quoted = activeQuote?.lines.find((entry) => entry.sku_id === line.sku_id);
      return <Card key={line.sku_id}>
        <Text style={styles.heading}>{item?.name ?? line.sku_id}</Text>
        {quoted && <Text style={styles.body}>{euro(quoted.unit_price_cents)} netto je {item?.sale_unit ?? "Einheit"}</Text>}
        <Quantity label={`Menge in ${item?.sale_unit ?? "Verkaufseinheit"} für ${item?.name ?? line.sku_id}`} qty={line.qty} min={item?.min_order_qty ?? 1} disabled={cartLocked}
          invalid={(value) => invalidField(line.sku_id, value)} change={(value) => setCart((old) => old.map((entry) => entry.sku_id === line.sku_id ? { ...entry, qty: value } : entry))} />
        <View style={styles.row}>
          {item && <Button label="Artikel ansehen" secondary onPress={() => enterProduct(item)} />}
          <Button label={`${item?.name ?? line.sku_id} entfernen`} secondary disabled={cartLocked}
            onPress={() => { invalidField(line.sku_id, false); setRemoved(line); setCart((old) => old.filter((entry) => entry.sku_id !== line.sku_id)); }} />
        </View>
      </Card>;
    })}
    {removed && <Button label="Entfernen rückgängig machen" secondary disabled={cartLocked} onPress={() => {
      setCart((old) => old.some((line) => line.sku_id === removed.sku_id) ? old : [...old, removed]); setRemoved(undefined);
    }} />}
    {activeQuote && cart.length > 0 && <TotalsView quote={activeQuote.totals} netOnly={activeQuote.netOnly} />}
    {cart.length > 0 && !activeQuote && !error && <Text style={styles.muted}>Preise werden geprüft.</Text>}
    {error && <Button label="Preise erneut prüfen" secondary onPress={refresh} />}
    {cart.length > 0 && <Button label="Bestellung prüfen" disabled={!activeQuote || cartLocked || busy || Object.values(invalidFields).some(Boolean)}
      onPress={() => activeQuote && reviewOrder(activeQuote)} />}
    <Button label="Weiter einkaufen" secondary onPress={() => go("catalog")} />
  </>;
}
