import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as FS from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { pilotConfiguration } from "../src/config";
import { demoApi } from "../src/demo";
import { remoteApi, remoteSessionStore } from "../src/remote";
import { RequestFailure, type DemoScenario, type LineInput, type Order, type OrderResult, type OrderSummary, type Product, type Quote, type Session } from "../src/contracts";
import { Button, Loading, Message, colors, styles } from "../src/ui";
import { AccountScreen, LogoutScreen, SupportScreen } from "../src/screens/account/view";
import { CartScreen } from "../src/screens/cart/view";
import { CatalogScreen, ProductScreen } from "../src/screens/catalog/view";
import { ConfirmationScreen, PendingScreen, ReviewScreen } from "../src/screens/checkout/view";
import { LoginScreen } from "../src/screens/login/view";
import { OrderScreen, OrdersScreen } from "../src/screens/orders/view";
import type { Screen } from "../src/screens/shared";

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
const reauthCodes = new Set(["GH-AUTH-002", "GH-AUTH-005", "GH-AUTH-007", "HTTP-401", "REAUTH"]);

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

  const waiting = Math.max(0, Math.ceil((retryAt - clock) / 1000));
  const orderExpired = !!order?.reservation_expires_at && Date.parse(order.reservation_expires_at) <= clock;
  const cartLocked = !!pending || openOrder;
  const refreshView = () => setRefresh((n) => n + 1);

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
          <LoginScreen email={email} code={code} expires={expires} clock={clock} waiting={waiting} demo={api.demo}
            busy={busy} error={error} setEmail={setEmail} setCode={setCode} enter={enter} sendCode={sendCode}
            restore={() => void restore()} changeEmail={() => { setExpires(0); setCode(""); setError(""); }} />
        ) : <>
          {screen === "catalog" && <CatalogScreen query={query} loadedQuery={loadedQuery} items={items} loading={loading}
            error={error} setQuery={setQuery} refresh={refreshView} enterProduct={enterProduct} />}
          {screen === "product" && selected && <ProductScreen selected={selected} qty={qty} activeQuote={activeQuote}
            cartLocked={cartLocked} error={error} invalidQuantity={invalidFields.product} setQty={setQty}
            setQuantityInvalid={(value) => invalidField("product", value)} refresh={refreshView}
            addToCart={() => mergeProduct(selected)} viewCart={() => go("cart")} />}
          {screen === "cart" && <CartScreen cart={cart} products={products} removed={removed} activeQuote={activeQuote}
            pending={!!pending} openOrder={openOrder} cartLocked={cartLocked} busy={busy} invalidFields={invalidFields}
            error={error} go={go} enterProduct={enterProduct} invalidField={invalidField} setCart={setCart}
            setRemoved={setRemoved} refresh={refreshView} showOpenOrder={() => {
              if (draftOrder) { setOrder(draftOrder); go(draftOrder.state === "on_hold" ? "issue" : "review"); }
            }} reviewOrder={(quote) => void run(() => send({ kind: "draft", key: Crypto.randomUUID(), lines: cart, quote }))} />}
          {(screen === "review" || screen === "issue") && order && <ReviewScreen screen={screen} order={order}
            orderExpired={orderExpired} changed={changed} demo={api.demo} busy={busy} pending={!!pending}
            cancelPrompt={cancelPrompt} setCancelPrompt={setCancelPrompt} support={support}
            confirm={() => void run(() => send({ kind: "confirm", order, key: Crypto.randomUUID() }))}
            cancel={() => void run(() => send({ kind: "cancel", order, key: Crypto.randomUUID() }))} />}
          {screen === "pending" && <PendingScreen pending={!!pending} busy={busy} canRepeat={canRepeat}
            go={go} checkPending={checkPending} support={support} repeatPending={() => {
              if (pending) void run(() => send(pending));
            }} />}
          {screen === "success" && order && <ConfirmationScreen order={order} viewOrder={() => openOrderDetail(order)}
            copyReference={() => void run(async () => { await Clipboard.setStringAsync(order.customer_reference); setMessage("Bestellnummer kopiert."); })}
            continueShopping={() => go("catalog")} />}
          {screen === "orders" && <OrdersScreen pending={!!pending} history={history} filter={filter} loading={loading}
            go={go} setFilter={setFilter} openOrderDetail={openOrderDetail} refresh={refreshView} />}
          {screen === "order" && order && <OrderScreen order={order} busy={busy} pending={!!pending}
            review={() => { setDraftOrder(order); go("review"); }} openInvoice={() => openInvoice(order)}
            refresh={() => openOrderDetail(order)} support={support} />}
          {screen === "account" && <AccountScreen session={session} demo={api.demo} scenario={scenario} cartLocked={cartLocked}
            setScenario={setScenario} support={support} askLogout={() => go("logout")} />}
          {screen === "logout" && <LogoutScreen hasCart={cart.length > 0} busy={busy} logout={logout}
            staySignedIn={() => go("account")} />}
          {screen === "support" && <SupportScreen session={session} order={order} supportOrigin={supportOrigin}
            writeEmail={() => void run(async () => Linking.openURL(`mailto:${session.supportEmail}`))}
            copyEmail={() => void run(async () => { await Clipboard.setStringAsync(session.supportEmail!); setMessage("Adresse kopiert."); })} />}
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
  tabs: { flexDirection: "row", padding: 5, backgroundColor: colors.paper, borderTopWidth: 1, borderColor: colors.edge },
  tab: { flex: 1, minHeight: 48, justifyContent: "center", borderRadius: 10, paddingHorizontal: 3 },
  active: { backgroundColor: colors.lime },
  tabText: { textAlign: "center", color: colors.ink, fontSize: 13, fontWeight: "700" },
});
