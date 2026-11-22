import { Text, View } from "react-native";
import type { DemoScenario, Order, Session } from "../../contracts";
import { Button, Card, styles } from "../../ui";
import type { Screen } from "../shared";

const examples: { id: DemoScenario; label: string }[] = [
  { id: "normal", label: "Normaler Einkauf" }, { id: "price", label: "Preiswechsel" },
  { id: "stock", label: "Bestandskonflikt" }, { id: "lost", label: "Antwortverlust" },
];


type AccountProps = {
  session: Session; demo: boolean; scenario: DemoScenario; cartLocked: boolean;
  setScenario: (scenario: DemoScenario) => void; support: () => void; askLogout: () => void;
};

export function AccountScreen({ session, demo, scenario, cartLocked, setScenario, support, askLogout }: AccountProps) {
  return <>
    <Card><Text style={styles.heading}>{session.customerName}</Text><Text style={styles.body}>{session.merchantName}</Text></Card>
    {demo && <Card><Text style={styles.heading}>Demo-Szenario</Text><View style={styles.row}>
      {examples.map((item) => <Button key={item.id} label={item.label} secondary={scenario !== item.id} disabled={cartLocked} onPress={() => setScenario(item.id)} />)}
    </View></Card>}
    <Button label="Händler kontaktieren" secondary onPress={support} />
    <Button label="Abmelden" secondary onPress={askLogout} />
  </>;
}

type LogoutProps = { hasCart: boolean; busy: boolean; logout: () => void; staySignedIn: () => void };

export function LogoutScreen({ hasCart, busy, logout, staySignedIn }: LogoutProps) {
  return <>
    <Text style={styles.body}>Deine Bestellungen bleiben im Konto.{hasCart ? " Der lokale Warenkorb wird auf diesem Gerät gelöscht." : ""}</Text>
    <Button label="Jetzt abmelden" disabled={busy} onPress={logout} />
    <Button label="Angemeldet bleiben" secondary disabled={busy} onPress={staySignedIn} />
  </>;
}

type SupportProps = { session: Session; supportOrigin: Screen; order?: Order; writeEmail: () => void; copyEmail: () => void };

export function SupportScreen({ session, supportOrigin, order, writeEmail, copyEmail }: SupportProps) {
  return <>
    <Text style={styles.heading}>{session.merchantName}</Text>
    {(supportOrigin === "order" || supportOrigin === "review" || supportOrigin === "issue") && order && <Text style={styles.body}>Bestellung {order.customer_reference}</Text>}
    {session.supportEmail ? <>
      <Text style={styles.body}>{session.supportEmail}</Text>
      <Button label="E-Mail schreiben" onPress={writeEmail} />
      <Button label="E-Mail-Adresse kopieren" secondary onPress={copyEmail} />
    </> : <Text style={styles.muted}>Händlerkontakt derzeit nicht verfügbar.</Text>}
  </>;
}
