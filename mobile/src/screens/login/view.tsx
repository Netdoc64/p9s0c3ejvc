import { Text } from "react-native";
import { Button, Card, Input, Message, styles } from "../../ui";

type LoginProps = {
  email: string; code: string; expires: number; clock: number; waiting: number;
  demo: boolean; busy: boolean; error: string;
  setEmail: (value: string) => void; setCode: (value: string) => void;
  sendCode: () => void; enter: () => void; restore: () => void; changeEmail: () => void;
};

export function LoginScreen({ email, code, expires, clock, waiting, demo, busy, error,
  setEmail, setCode, sendCode, enter, restore, changeEmail }: LoginProps) {
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return expires ? <>
    <Text style={styles.body}>Wenn du registriert bist, erhältst du einen Code für {email.trim()}.</Text>
    <Input label="Achtstelliger Code" value={code} autoCapitalize="characters" maxLength={10}
      onChangeText={(value) => setCode(value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "").slice(0, 8))} />
    {clock >= expires && <Message>Der zuletzt angeforderte Code ist abgelaufen.</Message>}
    <Button label="Anmelden" disabled={code.length !== 8 || busy || clock >= expires || waiting > 0} onPress={enter} />
    <Button label={waiting ? `Code erneut anfordern (${waiting}s)` : "Code erneut anfordern"} secondary disabled={busy || waiting > 0} onPress={sendCode} />
    <Button label="E-Mail ändern" secondary disabled={busy} onPress={changeEmail} />
    {demo && <Text style={styles.muted}>Demo-Code · ABCD2345</Text>}
  </> : <>
    <Text style={styles.body}>Bestelle zu den Konditionen deines Betriebs.</Text>
    <Input label="Geschäftliche E-Mail-Adresse" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
    <Button label={waiting ? `Code anfordern (${waiting}s)` : "Code anfordern"} disabled={!emailValid || busy || waiting > 0} onPress={sendCode} />
    {error && <Button label="Gespeicherte Sitzung prüfen" secondary onPress={restore} />}
    {demo && <Card><Text style={styles.muted}>Testkonto auswählen</Text>
      <Button label="Floraly Berlin" secondary onPress={() => setEmail("floraly@example.test")} />
      <Button label="Blume Amsterdam" secondary onPress={() => setEmail("blume@example.test")} />
    </Card>}
  </>;
}
