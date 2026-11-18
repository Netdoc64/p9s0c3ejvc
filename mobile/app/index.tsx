import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as FS from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { pilotConfiguration } from "../src/config";
import { demoApi } from "../src/demo";
import { remoteApi, remoteSessionStore } from "../src/remote";
import { euro, RequestFailure, type DemoScenario, type LineInput, type Order, type OrderResult, type OrderSummary, type Product, type Quote, type Session } from "../src/contracts";
import { Button, Card, Input, Loading, Message, colors, styles } from "../src/ui";

type Screen = "catalog" | "product" | "cart" | "review" | "pending" | "issue" | "success" | "orders" | "order" | "account" | "logout" | "support";
type Pending = { key: string } & (
  { kind: "draft"; lines: LineInput[]; quote: Quote } |
  { kind: "confirm" | "cancel"; order: Order }
);
interface LocalOrderState { cart: LineInput[]; pending?: Pending; order?: Order }

const baseUrl = pilotConfiguration.apiUrl;
const merchantSlug = pilotConfiguration.tenantSlug ?? "pilot";
const sessionStore = remoteSessionStore;
const demoStore = "grosshandel-demo-session";
const cartStore = (session: Session) => `grosshandel-cart:${baseUrl ?? "demo"}:${merchantSlug}:${session.customerId}`;
const tabs = { catalog: "Katalog", cart: "Warenkorb", orders: "Bestellungen", account: "Konto" } as const;
const labels: Record<Screen, string> = {
  ...tabs, product: "Artikel", review: "Bestellung prüfen", pending: "Bestellstatus", issue: "Bestellung korrigieren",
  success: "Bestellung bestätigt", order: "Bestelldetails", logout: "Abmelden", support: "Händler kontaktieren",
};
const statuses: Record<Order["state"], string> = {
  draft: "Entwurf", resolving: "Wird geprüft", awaiting_confirmation: "Noch zu bestätigen",
  confirmed: "Bestätigt", shipped: "Versandt", invoiced: "Abgerechnet", paid: "Bezahlt",
  cancelled: "Storniert", on_hold: "Aktion erforderlich",
};
const reauthCodes = new Set(["GH-AUTH-002", "GH-AUTH-005", "GH-AUTH-007", "HTTP-401", "REAUTH"]);
const examples: { id: DemoScenario; label: string }[] = [
  { id: "normal", label: "Normaler Einkauf" }, { id: "price", label: "Preiswechsel" },
  { id: "stock", label: "Bestandskonflikt" }, { id: "lost", label: "Antwortverlust" },
];

function invoiceBase64(pdf: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Rechnung konnte nicht gelesen werden."));
    reader.onabort = reader.onerror;
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const prefix = /^data:[^,]*;base64,/i.exec(result)?.[0];
      if (prefix) resolve(result.slice(prefix.length));
      else reject(new Error("Rechnung konnte nicht gelesen werden."));
    };
    reader.readAsDataURL(pdf);
  });
}

function ProductImage({ item, large = false }: { item: Product; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (item.image_url && !failed) {
    return <Image accessible={false} source={{ uri: item.image_url }} resizeMode="cover"
      style={large ? layout.heroImage : layout.swatch} onError={() => setFailed(true)} />;
  }
  if (large) return null;
  return <View style={layout.swatch}><Text style={layout.swatchText}>{item.sku_code.split("-")[0]}</Text></View>;
}

function TotalsView({ quote, netOnly }: { quote: Quote["totals"]; netOnly?: boolean }) {
  return <Card>
    <Text style={styles.body}>Netto · {euro(quote.subtotal_cents, quote.currency)}</Text>
    {netOnly ? <Text style={styles.muted}>Steuer und Gesamtbetrag erscheinen bei der Bestellprüfung.</Text> : <>
      <Text style={styles.body}>Steuer · {euro(quote.tax_cents, quote.currency)}</Text>
      <Text style={styles.heading}>Gesamt · {euro(quote.total_cents, quote.currency)}</Text>
    </>}
  </Card>;
}

function Quantity({ label, qty, min, change, invalid, disabled }: { label: string; qty: number; min: number; change: (qty: number) => void; invalid: (value: boolean) => void; disabled?: boolean }) {
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

export default function Pilot() {
  const [scenario, setScenario] = useState<DemoScenario>("normal");
  const api = useMemo(() => baseUrl ? remoteApi(baseUrl, merchantSlug) : demoApi(scenario), [scenario]);
  const [session, setSession] = useState<Session>();
  const [booting, setBooting] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [expires, setExpires] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [retryAt, setRetryAt] = useState(0);
  const [screen, setScreen] = useState<Screen>("catalog");
  const [supportOrigin, setSupportOrigin] = useState<Screen>("account");
  const [productOrigin, setProductOrigin] = useState<"catalog" | "cart">("catalog");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Product[]>([]);
  const [loadedQuery, setLoadedQuery] = useState<string>();
  const [products, setProducts] = useState<Record<string, Product>>({});
  const [selected, setSelected] = useState<Product>();
  const [qty, setQty] = useState(1);
  const [cart, setCart] = useState<LineInput[]>([]);
  const [removed, setRemoved] = useState<LineInput>();
  const [quote, setQuote] = useState<Quote>();
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const [quoteKey, setQuoteKey] = useState("");
  const [history, setHistory] = useState<OrderSummary[]>([]);
  const [filter, setFilter] = useState<"all" | Order["state"]>("all");
  const [order, setOrder] = useState<Order>();
  const [draftOrder, setDraftOrder] = useState<Order>();
  const [pending, setPending] = useState<Pending>();
  const [canRepeat, setCanRepeat] = useState(false);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [cancelPrompt, setCancelPrompt] = useState(false);
  const working = useRef(false);
  const generation = useRef(0);
  const applyQueue = useRef(Promise.resolve());
  const invoicePath = useRef<string | undefined>(undefined);

  function go(next: Screen) {
    setError(""); setMessage(""); setCancelPrompt(false); setInvalidFields({}); setScreen(next);
  }
  function support() {
    setSupportOrigin(screen); go("support");
  }
  const quoteLines = screen === "product" && selected ? [{ sku_id: selected.id, qty }] : cart;
  const lineKey = JSON.stringify(quoteLines);
  const activeQuote = quoteKey === lineKey ? quote : undefined;
  const openOrder = !!draftOrder;
  const invalidField = (id: string, value: boolean) => setInvalidFields((items) => ({ ...items, [id]: value }));

  async function storeSession(value?: Session) {
    if (api.demo) {
      return value ? AsyncStorage.setItem(demoStore, JSON.stringify(value)) : AsyncStorage.removeItem(demoStore);
    }
    if (Platform.OS === "web") return;
    return value ? SecureStore.setItemAsync(sessionStore, JSON.stringify(value)) : SecureStore.deleteItemAsync(sessionStore);
  }
  async function loadSession(s: Session) {
    const saved = await AsyncStorage.getItem(cartStore(s));
    const local: LocalOrderState = saved ? JSON.parse(saved) : { cart: [] };
    setRequiresLogin(false);
    setCart(local.cart); setPending(local.pending); setOrder(local.order); setDraftOrder(local.order); setSession(s);
    go(local.pending ? "pending" : "catalog");
  }
  async function restore() {
    setBooting(true); setError("");
    try {
      if (Platform.OS !== "web" && FS.cacheDirectory) {
        await FS.deleteAsync(FS.cacheDirectory + "grosshandel-invoice.pdf", { idempotent: true }).catch(() => {});
      }
      const saved = api.demo ? await AsyncStorage.getItem(demoStore)
        : Platform.OS === "web" ? null : await SecureStore.getItemAsync(sessionStore);
      if (saved) {
        const s = await api.restore(JSON.parse(saved));
        await storeSession(s);
        await loadSession(s);
      }
    } catch (cause) {
      if (cause instanceof RequestFailure && reauthCodes.has(cause.code)) {
        await storeSession();
      }
      setError(cause instanceof Error ? cause.message : "Anmeldung konnte nicht geladen werden.");
    } finally { setBooting(false); }
  }
  useEffect(() => { void restore(); }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!session) return;
    const saved: LocalOrderState = { cart, pending, order: draftOrder };
    applyQueue.current = applyQueue.current.catch(() => {}).then(() => AsyncStorage.setItem(cartStore(session), JSON.stringify(saved)));
  }, [session, cart, pending, draftOrder]);

  useEffect(() => {
    if (!session || screen !== "catalog") return;
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void api.catalog(session, query).then((result) => {
        if (!current) return;
        setItems(result);
        setLoadedQuery(query);
        setProducts((old) => ({ ...old, ...Object.fromEntries(result.map((item) => [item.id, item])) }));
      }).catch((cause: unknown) => {
        if (current) showFailure(cause, "Katalog nicht verfügbar.");
      }).finally(() => { if (current) setLoading(false); });
    }, 200);
    return () => { current = false; clearTimeout(timer); setLoading(false); };
  }, [session, api, screen, query, refresh]);

  useEffect(() => {
    if (!session || !["product", "cart"].includes(screen) || lineKey === "[]") return;
    let current = true;
    setError("");
    setQuoteKey("");
    void api.quote(session, JSON.parse(lineKey)).then((value) => {
      if (current) { setQuote(value); setQuoteKey(lineKey); }
    }).catch((cause: unknown) => {
      if (current) showFailure(cause, "Preise konnten nicht geprüft werden.");
    });
    return () => { current = false; };
  }, [session, api, screen, lineKey, refresh]);

  useEffect(() => {
    if (!session || screen !== "orders") return;
    let current = true;
    setLoading(true);
    void api.orders(session).then((value) => { if (current) setHistory(value); })
      .catch((cause: unknown) => { if (current) showFailure(cause, "Bestellungen konnten nicht geladen werden."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; setLoading(false); };
  }, [session, api, screen, refresh]);

  function back() {
    if (busy) return true;
    if (cancelPrompt) { setCancelPrompt(false); return true; }
    if (!session && expires) { setExpires(0); setCode(""); setError(""); return true; }
    const target: Partial<Record<Screen, Screen>> = {
      product: productOrigin, review: "cart", pending: "orders", issue: "cart", success: "orders",
      order: "orders", logout: "account", support: supportOrigin,
    };
    if (target[screen]) { go(target[screen]!); return true; }
    return false;
  }
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", back);
    return () => listener.remove();
  });

  function showFailure(cause: unknown, fallback: string) {
    if (cause instanceof RequestFailure && reauthCodes.has(cause.code)) setRequiresLogin(true);
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (cause) {
      if (cause instanceof RequestFailure && cause.retryAfter) setRetryAt(Date.now() + cause.retryAfter * 1000);
      showFailure(cause, "Bitte versuche es erneut.");
    } finally { working.current = false; setBusy(false); }
  }

  function sendCode() {
    void run(async () => {
      const ttl = await api.requestCode(email.trim().toLowerCase());
      setClock(Date.now()); setExpires(Date.now() + ttl * 1000); setCode("");
    });
  }
  function enter() {
    void run(async () => {
      const value = await api.signIn(email.trim().toLowerCase(), code);
      await storeSession(value); await loadSession(value);
      setCode(""); setExpires(0);
    });
  }
  function reauthenticate() {
    void run(async () => {
      if (!session) return;
      generation.current += 1;
      await applyQueue.current.catch(() => {});
      await storeSession();
      setSession(undefined); setRequiresLogin(false);
      setCart([]); setRemoved(undefined); setPending(undefined);
      setOrder(undefined); setDraftOrder(undefined); setHistory([]); setProducts({}); setItems([]);
      setLoadedQuery(undefined); setSelected(undefined); setQuote(undefined); setQuery("");
      setExpires(0); setCode(""); go("catalog");
    });
  }

  function logout() {
    void run(async () => {
      if (!session) return;
      const previous = session;
      generation.current += 1;
      await applyQueue.current.catch(() => {});
      await Promise.all([
        storeSession(), AsyncStorage.removeItem(cartStore(previous)),
        invoicePath.current ? FS.deleteAsync(invoicePath.current, { idempotent: true }) : Promise.resolve(),
      ]);
      invoicePath.current = undefined;
      setSession(undefined); setCart([]); setRemoved(undefined); setOrder(undefined); setDraftOrder(undefined); setHistory([]);
      setPending(undefined); setProducts({}); setItems([]); setLoadedQuery(undefined); setSelected(undefined); setQuote(undefined); setQuery("");
      setExpires(0); setEmail(""); setCode(""); go("catalog");
      void api.signOut(previous).catch(() => {});
    });
  }

  function enterProduct(item: Product) {
    setProductOrigin(screen === "cart" ? "cart" : "catalog");
    setSelected(item); setQty(item.min_order_qty); go("product");
  }

  function mergeProduct(item: Product) {
    const current = cart.find((line) => line.sku_id === item.id);
    const quantity = (current?.qty ?? 0) + qty;
    if (quantity > 500) { setError("Die Höchstmenge beträgt 500."); return; }
    setCart(current ? cart.map((line) => line.sku_id === item.id ? { ...line, qty: quantity } : line) : [...cart, { sku_id: item.id, qty }]);
    setMessage(`${quantity} ${item.sale_unit} im Warenkorb.`);
  }

  function finish(next: Order, attempt: Pending) {
    setPending(undefined); setCanRepeat(false); setOrder(next);
    if (next.state === "awaiting_confirmation" || next.state === "on_hold") setDraftOrder(next);
    else setDraftOrder((active) => active?.id === next.id ? undefined : active);
    if (["confirmed", "shipped", "invoiced", "paid"].includes(next.state)) {
      const snapshot = attempt.kind === "draft" ? attempt.lines : attempt.order.lines;
      setCart((old) => old.map((line) => ({ ...line, qty: line.qty - (snapshot.find((item) => item.sku_id === line.sku_id)?.qty ?? 0) })).filter((line) => line.qty > 0));
      go("success");
    } else if (next.state === "cancelled") {
      go("cart"); setRefresh((n) => n + 1); setMessage("Die Reservierung wurde freigegeben.");
    } else if (next.state === "on_hold") {
      go("issue");
    } else {
      setChanged(attempt.kind === "draft" && (
        (attempt.quote.netOnly ? next.totals.subtotal_cents !== attempt.quote.totals.subtotal_cents : next.totals.total_cents !== attempt.quote.totals.total_cents) ||
        next.lines.some((line) => attempt.quote.lines.find((quoted) => quoted.sku_id === line.sku_id)?.unit_price_cents !== line.unit_price_cents)
      ));
      go("review");
    }
  }

  async function send(attempt: Pending) {
    if (!session) return;
    await applyQueue.current.catch(() => {});
    await AsyncStorage.setItem(cartStore(session), JSON.stringify({ cart, order: draftOrder, pending: attempt }));
    setPending(attempt); setCanRepeat(false);
    let result: OrderResult;
    try {
      if (attempt.kind === "draft") result = await api.draft(session, attempt.lines, attempt.quote.quote_id, attempt.key);
      else if (attempt.kind === "confirm") result = await api.confirm(session, attempt.order, attempt.key);
      else result = await api.cancel(session, attempt.order, attempt.key);
    } catch (cause) {
      if (attempt.kind === "draft" && cause instanceof RequestFailure && ["GH-INPUT-001", "GH-PROD-001", "GH-PROD-003", "GH-PRICE-001"].includes(cause.code)) {
        setPending(undefined); go("cart"); setError(cause.message);
        return;
      }
      if (attempt.kind !== "draft" && cause instanceof RequestFailure && ["GH-ORDER-002", "GH-STOCK-002", "GH-STATE-001"].includes(cause.code)) {
        try {
          const next = await api.order(session, attempt.order.id);
          if (cause.code === "GH-STOCK-002" && next.state === "awaiting_confirmation") {
            setPending(undefined); setOrder(next); go("issue"); setError(cause.message); return;
          }
          finish(next, attempt);
          if (next.state === "awaiting_confirmation") setChanged(true);
          return;
        } catch { /* Preserve operation until authoritative lookup succeeds. */ }
      }
      go("pending");
      showFailure(cause, "Das Ergebnis ist noch offen. Prüfe den Vorgang, bevor du erneut bestellst.");
      return;
    }
    finish(result.order, attempt);
  }

  function checkPending() {
    if (!session || !pending) return;
    void run(async () => {
      const result = await api.operation(session, pending.key);
      if (result.state === "completed" && result.order) finish(result.order, pending);
      else {
        setCanRepeat(result.repeat_allowed && result.state === "not_recorded");
        setMessage("Der Vorgang konnte noch nicht abgeschlossen werden.");
      }
    });
  }

  function openOrderDetail(value: OrderSummary) {
    setOrder("revision" in value ? value as Order : undefined); go("order");
    if (session) void run(async () => setOrder(await api.order(session, value.id)));
  }

  function openInvoice(value: Order) {
    if (!session) return;
    void run(async () => {
      const current = generation.current;
      const pdf = await api.invoice(session, value.id);
      if (generation.current !== current) return;
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(pdf);
        const link = document.createElement("a");
        link.href = url; link.download = `${value.customer_reference}.pdf`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else {
        if (!await Sharing.isAvailableAsync() || !FS.cacheDirectory) throw new Error("Rechnung kann auf diesem Gerät gerade nicht geöffnet werden.");
        const base64 = await invoiceBase64(pdf);
        await FS.deleteAsync(invoicePath.current ?? FS.cacheDirectory + "grosshandel-invoice.pdf", { idempotent: true });
        invoicePath.current = FS.cacheDirectory + "grosshandel-invoice.pdf";
        await FS.writeAsStringAsync(invoicePath.current, base64, { encoding: FS.EncodingType.Base64 });
        await Sharing.shareAsync(invoicePath.current, { mimeType: "application/pdf", UTI: "com.adobe.pdf" });
      }
    });
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const waiting = Math.max(0, Math.ceil((retryAt - clock) / 1000));
  const orderExpired = !!order?.reservation_expires_at && Date.parse(order.reservation_expires_at) <= clock;
  const cartLocked = !!pending || openOrder;
  const accountHold = order?.issues?.some((issue) => ["GH-CUST-003", "GH-CUST-004"].includes(issue.code));
  const issueMessage = orderExpired ? "Die Reservierung ist abgelaufen."
    : accountHold ? "Bitte kläre diese Bestellung mit deinem Händler."
      : "Die ausgewählte Menge ist derzeit nicht vollständig bestellbar.";
  const lines = order?.lines.map((line) => <View key={line.sku_id} style={styles.spread}>
    <Text style={styles.body}>{line.qty} × {line.sale_unit} · {line.name}</Text>
    <Text style={styles.body}>{euro(line.unit_price_cents, order.totals.currency)} je Einheit</Text>
  </View>);

  return <SafeAreaView style={layout.safe}>
    <View style={layout.app}>
      <View style={layout.header}>
        <Text style={layout.brand}>{session?.merchantName ?? "Grosshandel"}</Text>
        {api.demo && <Text style={layout.badge}>Demo</Text>}
      </View>
      <ScrollView style={layout.scroll} contentContainerStyle={layout.content} keyboardShouldPersistTaps="handled">
        {session && !Object.hasOwn(tabs, screen) && !busy && <Button label="Zurück" secondary onPress={back} />}
        <Text accessibilityRole="header" style={styles.title}>{!session ? (expires ? "Code eingeben" : "Anmelden") : labels[screen]}</Text>
        {busy || booting || loading ? <Loading /> : null}
        {error ? <Message error>{error}</Message> : null}
        {message ? <Message>{message}</Message> : null}
        {session && requiresLogin && <Button label="Erneut anmelden" disabled={busy} onPress={reauthenticate} />}
        {booting ? null : !session ? (
          expires ? <>
            <Text style={styles.body}>Wenn du registriert bist, erhältst du einen Code für {email.trim()}.</Text>
            <Input label="Achtstelliger Code" value={code} autoCapitalize="characters" maxLength={10}
              onChangeText={(value) => setCode(value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "").slice(0, 8))} />
            {clock >= expires && <Message>Der zuletzt angeforderte Code ist abgelaufen.</Message>}
            <Button label="Anmelden" disabled={code.length !== 8 || busy || clock >= expires || waiting > 0} onPress={enter} />
            <Button label={waiting ? `Code erneut anfordern (${waiting}s)` : "Code erneut anfordern"} secondary disabled={busy || waiting > 0} onPress={sendCode} />
            <Button label="E-Mail ändern" secondary disabled={busy} onPress={() => { setExpires(0); setCode(""); setError(""); }} />
            {api.demo && <Text style={styles.muted}>Demo-Code · ABCD2345</Text>}
          </> : <>
            <Text style={styles.body}>Bestelle zu den Konditionen deines Betriebs.</Text>
            <Input label="Geschäftliche E-Mail-Adresse" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
            <Button label={waiting ? `Code anfordern (${waiting}s)` : "Code anfordern"} disabled={!emailValid || busy || waiting > 0} onPress={sendCode} />
            {error && <Button label="Gespeicherte Sitzung prüfen" secondary onPress={() => void restore()} />}
            {api.demo && <Card><Text style={styles.muted}>Testkonto auswählen</Text>
              <Button label="Floraly Berlin" secondary onPress={() => setEmail("floraly@example.test")} />
              <Button label="Blume Amsterdam" secondary onPress={() => setEmail("blume@example.test")} />
            </Card>}
          </>
        ) : <>
          {screen === "catalog" && <>
            <Input label="Name oder Artikelnummer" value={query} onChangeText={setQuery} placeholder="Rote Rosen, 60 cm …" />
            {query && <Button label="Suche leeren" secondary onPress={() => setQuery("")} />}
            {error && <Button label="Katalog erneut laden" secondary onPress={() => setRefresh((n) => n + 1)} />}
            {!loading && !error && loadedQuery === query && items.length === 0 && <Text style={styles.muted}>{query ? "Keine passenden Artikel gefunden." : "Der Katalog ist leer."}</Text>}
            {loadedQuery === query && items.map((item) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}, ${item.variant}`} key={item.id} onPress={() => enterProduct(item)} style={layout.product}>
              <ProductImage key={item.image_url ?? item.id} item={item} />
              <View style={layout.productText}><Text style={styles.heading}>{item.name}</Text>
                <Text style={styles.muted}>{item.variant} · {item.contains} {item.unit_of_inner} je {item.sale_unit}</Text></View>
            </Pressable>)}
          </>}
          {screen === "product" && selected && <>
            <Card><ProductImage key={selected.image_url ?? selected.id} item={selected} large /><Text style={styles.heading}>{selected.name}</Text>
              <Text style={styles.body}>{selected.variant} · {selected.sku_code}</Text>
              <Text style={styles.muted}>{selected.contains} {selected.unit_of_inner} je {selected.sale_unit} · Mindestmenge {selected.min_order_qty}</Text>
            </Card>
            <Quantity label={`Menge in ${selected.sale_unit}`} qty={qty} min={selected.min_order_qty} change={setQty} invalid={(value) => invalidField("product", value)} disabled={cartLocked} />
            <Text style={styles.heading}>{activeQuote ? `${euro(activeQuote.lines[0].unit_price_cents)} netto je ${selected.sale_unit}` : "Preis wird geprüft"}</Text>
            {error && <Button label="Preis erneut laden" secondary onPress={() => setRefresh((n) => n + 1)} />}
            {cartLocked && <Message>Bearbeite zuerst deine offene Bestellprüfung.</Message>}
            <Button label="In den Warenkorb" disabled={!activeQuote || cartLocked || invalidFields.product} onPress={() => mergeProduct(selected)} />
            <Button label="Warenkorb ansehen" secondary onPress={() => go("cart")} />
          </>}
          {screen === "cart" && <>
            {pending ? <Button label="Bestellstatus prüfen" onPress={() => go("pending")} /> : openOrder &&
              <Button label="Offene Bestellung ansehen" onPress={() => {
                if (draftOrder) { setOrder(draftOrder); go(draftOrder.state === "on_hold" ? "issue" : "review"); }
              }} />}
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
            {error && <Button label="Preise erneut prüfen" secondary onPress={() => setRefresh((n) => n + 1)} />}
            {cart.length > 0 && <Button label="Bestellung prüfen" disabled={!activeQuote || cartLocked || busy || Object.values(invalidFields).some(Boolean)}
              onPress={() => activeQuote && void run(() => send({ kind: "draft", key: Crypto.randomUUID(), lines: cart, quote: activeQuote }))} />}
            <Button label="Weiter einkaufen" secondary onPress={() => go("catalog")} />
          </>}
          {(screen === "review" || screen === "issue") && order && <>
            {screen === "issue" ? <Message error>{issueMessage}</Message>
              : changed && <Message>Der Auftrag hat sich geändert. Prüfe die aktuellen Positionen und Beträge vor der Bestätigung.</Message>}
            <Card><Text style={styles.heading}>{order.customer_reference}</Text>{lines}</Card>
            <TotalsView quote={order.totals} />
            <Text style={styles.body}>Zahlung auf Rechnung{api.demo ? " · vereinbarte Testlieferung" : ""}</Text>
            {order.reservation_expires_at && <Text style={styles.muted}>{orderExpired ? "Reservierung abgelaufen" : `Reserviert bis ${new Date(order.reservation_expires_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`}</Text>}
            {screen === "review" && <Button label="Verbindlich bestellen" disabled={busy || orderExpired || order.state !== "awaiting_confirmation" || order.allowed_actions?.includes("confirm") === false || !!pending}
              onPress={() => void run(() => send({ kind: "confirm", order, key: Crypto.randomUUID() }))} />}
            {cancelPrompt ? <Card>
              <Text style={styles.body}>Die Reservierung wird freigegeben. Deine Auswahl bleibt im Warenkorb.</Text>
              <Button label="Reservierung freigeben" disabled={busy} onPress={() => void run(() => send({ kind: "cancel", order, key: Crypto.randomUUID() }))} />
              <Button label="Prüfung fortsetzen" secondary disabled={busy} onPress={() => setCancelPrompt(false)} />
            </Card> : <Button label="Warenkorb bearbeiten" secondary disabled={busy || !!pending} onPress={() => setCancelPrompt(true)} />}
            <Button label="Händler kontaktieren" secondary onPress={support} />
          </>}
          {screen === "pending" && <>
            <Text style={styles.body}>Prüfe den Status, bevor du erneut bestellst. Der Vorgang bleibt gespeichert.</Text>
            <Button label="Status prüfen" disabled={!pending || busy} onPress={checkPending} />
            {canRepeat && pending && <Button label="Vorgang erneut senden" disabled={busy} secondary onPress={() => void run(() => send(pending))} />}
            <Button label="Zu meinen Bestellungen" secondary onPress={() => go("orders")} />
            <Button label="Händler kontaktieren" secondary onPress={support} />
          </>}
          {screen === "success" && order && <>
            <Message>Deine Bestellnummer lautet {order.customer_reference}.</Message>
            <TotalsView quote={order.totals} />
            <Button label="Bestellung ansehen" onPress={() => openOrderDetail(order)} />
            <Button label="Bestellnummer kopieren" secondary onPress={() => void run(async () => { await Clipboard.setStringAsync(order.customer_reference); setMessage("Bestellnummer kopiert."); })} />
            <Button label="Weiter einkaufen" secondary onPress={() => go("catalog")} />
          </>}
          {screen === "orders" && <>
            {pending && <Button label="Offenen Bestellvorgang prüfen" secondary onPress={() => go("pending")} />}
            <View style={styles.row}>{(["all", "confirmed", "awaiting_confirmation", "on_hold", "cancelled"] as const).map((state) =>
              <Button key={state} label={state === "all" ? "Alle" : statuses[state]} secondary={filter !== state} onPress={() => setFilter(state)} />)}</View>
            {history.filter((value) => filter === "all" || value.state === filter).map((value) =>
              <Button key={value.id} label={`${value.customer_reference} · ${statuses[value.state]} · ${euro(value.totals.total_cents)}`} secondary onPress={() => openOrderDetail(value)} />)}
            {!loading && !history.some((value) => filter === "all" || value.state === filter) && <Text style={styles.muted}>Keine passenden Bestellungen.</Text>}
            <Button label="Bestellungen aktualisieren" secondary onPress={() => setRefresh((n) => n + 1)} />
          </>}
          {screen === "order" && order && <>
            <Card><Text style={styles.heading}>{order.customer_reference}</Text><Text style={styles.body}>{statuses[order.state] ?? "Status aktualisieren"}</Text>
              <Text style={styles.muted}>{new Date(order.created_at).toLocaleDateString("de-DE")}</Text>{lines}</Card>
            <TotalsView quote={order.totals} />
            {order.state === "awaiting_confirmation" && order.allowed_actions?.includes("confirm") !== false && <Button label="Bestellung weiter prüfen" disabled={!!pending} onPress={() => { setDraftOrder(order); go("review"); }} />}
            {order.invoice_available ? <Button label="Rechnung öffnen" disabled={busy} onPress={() => openInvoice(order)} /> : <Text style={styles.muted}>Rechnung noch nicht verfügbar.</Text>}
            <Button label="Status aktualisieren" secondary disabled={busy} onPress={() => openOrderDetail(order)} />
            <Button label="Händler zu dieser Bestellung kontaktieren" secondary onPress={support} />
          </>}
          {screen === "account" && <>
            <Card><Text style={styles.heading}>{session.customerName}</Text><Text style={styles.body}>{session.merchantName}</Text></Card>
            {api.demo && <Card><Text style={styles.heading}>Demo-Szenario</Text><View style={styles.row}>
              {examples.map((item) => <Button key={item.id} label={item.label} secondary={scenario !== item.id} disabled={cartLocked} onPress={() => setScenario(item.id)} />)}
            </View></Card>}
            <Button label="Händler kontaktieren" secondary onPress={support} />
            <Button label="Abmelden" secondary onPress={() => go("logout")} />
          </>}
          {screen === "logout" && <>
            <Text style={styles.body}>Deine Bestellungen bleiben im Konto.{cart.length > 0 ? " Der lokale Warenkorb wird auf diesem Gerät gelöscht." : ""}</Text>
            <Button label="Jetzt abmelden" disabled={busy} onPress={logout} />
            <Button label="Angemeldet bleiben" secondary disabled={busy} onPress={() => go("account")} />
          </>}
          {screen === "support" && <>
            <Text style={styles.heading}>{session.merchantName}</Text>
            {(supportOrigin === "order" || supportOrigin === "review" || supportOrigin === "issue") && order && <Text style={styles.body}>Bestellung {order.customer_reference}</Text>}
            {session.supportEmail ? <>
              <Text style={styles.body}>{session.supportEmail}</Text>
              <Button label="E-Mail schreiben" onPress={() => void run(async () => Linking.openURL(`mailto:${session.supportEmail}`))} />
              <Button label="E-Mail-Adresse kopieren" secondary onPress={() => void run(async () => { await Clipboard.setStringAsync(session.supportEmail!); setMessage("Adresse kopiert."); })} />
            </> : <Text style={styles.muted}>Händlerkontakt derzeit nicht verfügbar.</Text>}
          </>}
        </>}
      </ScrollView>
      {session && !["review", "pending", "issue", "success", "logout"].includes(screen) && <View accessibilityRole="tablist" style={layout.tabs}>
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((tab) => <Pressable key={tab} accessibilityRole="tab"
          accessibilityState={{ selected: screen === tab }} style={[layout.tab, screen === tab && layout.active]} onPress={() => go(tab)}>
          <Text style={layout.tabText}>{tabs[tab]}{tab === "cart" && cart.length > 0 ? ` (${cart.length})` : ""}</Text>
        </Pressable>)}
      </View>}
    </View>
  </SafeAreaView>;
}

const layout = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  app: { flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 19, paddingVertical: 12, borderBottomWidth: 1, borderColor: colors.edge },
  brand: { color: colors.moss, fontSize: 17, fontWeight: "800" },
  badge: { color: colors.ink, backgroundColor: colors.lime, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, fontWeight: "600" },
  scroll: { flex: 1 },
  content: { padding: 19, gap: 13, paddingBottom: 28 },
  product: { borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.paper, borderRadius: 15, padding: 13, flexDirection: "row", gap: 12, alignItems: "center" },
  swatch: { backgroundColor: "#e8edda", width: 48, height: 48, borderRadius: 13, justifyContent: "center", alignItems: "center" },
  heroImage: { width: "100%", height: 190, borderRadius: 11, backgroundColor: colors.canvas },
  swatchText: { color: colors.moss, fontWeight: "800", fontSize: 14 },
  productText: { flex: 1 },
  tabs: { flexDirection: "row", padding: 5, backgroundColor: colors.paper, borderTopWidth: 1, borderColor: colors.edge },
  tab: { flex: 1, minHeight: 48, justifyContent: "center", borderRadius: 10, paddingHorizontal: 3 },
  active: { backgroundColor: colors.lime },
  tabText: { textAlign: "center", color: colors.ink, fontSize: 13, fontWeight: "700" },
});
