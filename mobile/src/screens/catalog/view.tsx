import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { euro, type Product, type Quote } from "../../contracts";
import { Button, Card, Input, Message, colors, styles } from "../../ui";
import { Quantity } from "../shared";

function ProductImage({ item, large = false }: { item: Product; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (item.image_url && !failed) {
    return <Image accessible={false} source={{ uri: item.image_url }} resizeMode="cover"
      style={large ? layout.heroImage : layout.swatch} onError={() => setFailed(true)} />;
  }
  if (large) return null;
  return <View style={layout.swatch}><Text style={layout.swatchText}>{item.sku_code.split("-")[0]}</Text></View>;
}


function Availability({ item }: { item: Product }) {
  if (item.available_quantity === undefined) return null;
  return <Text style={styles.muted}>
    {item.available_quantity === 0 ? "Derzeit nicht verfügbar" : `Verfügbar: ${item.available_quantity} · Einheit: ${item.sale_unit}`}
  </Text>;
}

type CatalogProps = {
  query: string; loadedQuery?: string; items: Product[]; loading: boolean; error: string;
  setQuery: (value: string) => void; refresh: () => void; enterProduct: (item: Product) => void;
};

export function CatalogScreen({ query, loadedQuery, items, loading, error, setQuery, refresh, enterProduct }: CatalogProps) {
  return <>
    <Input label="Name oder Artikelnummer" value={query} onChangeText={setQuery} placeholder="Rote Rosen, 60 cm …" />
    {query && <Button label="Suche leeren" secondary onPress={() => setQuery("")} />}
    {error && <Button label="Katalog erneut laden" secondary onPress={refresh} />}
    {!loading && !error && loadedQuery === query && items.length === 0 && <Text style={styles.muted}>{query ? "Keine passenden Artikel gefunden." : "Der Katalog ist leer."}</Text>}
    {loadedQuery === query && items.map((item) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}, ${item.variant}`} key={item.id} onPress={() => enterProduct(item)} style={layout.product}>
      <ProductImage key={item.image_url ?? item.id} item={item} />
      <View style={layout.productText}><Text style={styles.heading}>{item.name}</Text>
        <Text style={styles.muted}>{item.variant} · {item.contains} {item.unit_of_inner} je {item.sale_unit}</Text><Availability item={item} /></View>
    </Pressable>)}
  </>;
}

type ProductProps = {
  selected: Product; qty: number; activeQuote?: Quote; cartLocked: boolean; error: string; invalidQuantity?: boolean;
  setQty: (value: number) => void; setQuantityInvalid: (value: boolean) => void;
  refresh: () => void; addToCart: () => void; viewCart: () => void;
};

export function ProductScreen({ selected, qty, activeQuote, cartLocked, error, invalidQuantity,
  setQty, setQuantityInvalid, refresh, addToCart, viewCart }: ProductProps) {
  return <>
    <Card><ProductImage key={selected.image_url ?? selected.id} item={selected} large /><Text style={styles.heading}>{selected.name}</Text>
      <Text style={styles.body}>{selected.variant} · {selected.sku_code}</Text>
      <Text style={styles.muted}>{selected.contains} {selected.unit_of_inner} je {selected.sale_unit} · Mindestmenge {selected.min_order_qty}</Text>
      <Availability item={selected} />
    </Card>
    <Quantity label={`Menge in ${selected.sale_unit}`} qty={qty} min={selected.min_order_qty} change={setQty} invalid={setQuantityInvalid} disabled={cartLocked} />
    <Text style={styles.heading}>{activeQuote ? `${euro(activeQuote.lines[0].unit_price_cents)} netto je ${selected.sale_unit}` : "Preis wird geprüft"}</Text>
    {error && <Button label="Preis erneut laden" secondary onPress={refresh} />}
    {cartLocked && <Message>Bearbeite zuerst deine offene Bestellprüfung.</Message>}
    <Button label="In den Warenkorb" disabled={!activeQuote || cartLocked || invalidQuantity} onPress={addToCart} />
    <Button label="Warenkorb ansehen" secondary onPress={viewCart} />
  </>;
}

const layout = StyleSheet.create({
  product: { borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.paper, borderRadius: 15, padding: 13, flexDirection: "row", gap: 12, alignItems: "center" },
  swatch: { backgroundColor: "#e8edda", width: 48, height: 48, borderRadius: 13, justifyContent: "center", alignItems: "center" },
  heroImage: { width: "100%", height: 190, borderRadius: 11, backgroundColor: colors.canvas },
  swatchText: { color: colors.moss, fontWeight: "800", fontSize: 14 },
  productText: { flex: 1 },
});
