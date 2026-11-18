import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

export const colors = { canvas: "#f5f3eb", paper: "#fffdf7", ink: "#192a23", muted: "#475a4f", moss: "#244735", lime: "#d9eaa0", edge: "#d8ded0", error: "#912e3d" };

export function Button({ label, onPress, disabled, secondary, testID }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; testID?: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }}
      disabled={disabled} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, (disabled || pressed) && styles.dim]}>
      <Text style={[styles.buttonLabel, secondary && styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

export function Input({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}>
    <Text style={styles.body}>{label}</Text>
    <TextInput {...props} accessibilityLabel={label} style={styles.input} placeholderTextColor={colors.muted} />
  </View>;
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Message({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <Text accessibilityRole={error ? "alert" : undefined} accessibilityLiveRegion="polite"
    style={[styles.message, error && styles.error]}>{children}</Text>;
}

export function Loading() {
  return <ActivityIndicator accessibilityLabel="Wird geladen" color={colors.moss} />;
}

export const styles = StyleSheet.create({
  title: { fontSize: 35, lineHeight: 42, fontWeight: "800", letterSpacing: -1.1, color: colors.ink },
  heading: { fontSize: 22, lineHeight: 28, fontWeight: "700", color: colors.ink },
  body: { fontSize: 16, lineHeight: 23, color: colors.ink },
  muted: { fontSize: 15, lineHeight: 22, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  spread: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
  stack: { gap: 12 },
  button: { borderRadius: 12, minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, justifyContent: "center", backgroundColor: colors.moss },
  buttonLabel: { color: "#fff", fontWeight: "700", fontSize: 15, lineHeight: 21, textAlign: "center" },
  secondary: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.edge },
  secondaryLabel: { color: colors.ink },
  dim: { opacity: 0.56 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.edge, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: colors.paper, color: colors.ink, fontSize: 16 },
  field: { gap: 5 },
  card: { borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.paper, padding: 15, borderRadius: 15, gap: 10 },
  message: { borderRadius: 10, backgroundColor: colors.lime, color: colors.ink, padding: 12, fontSize: 15, lineHeight: 22 },
  error: { color: colors.error, backgroundColor: "#f8e7e7" },
});
