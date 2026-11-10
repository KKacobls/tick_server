import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

export const C = {
  bg: "#f4f6fa", card: "#ffffff", text: "#172438", muted: "#68778d",
  blue: "#1764e8", border: "#dfe6ef", red: "#bd2e36", green: "#118465",
};
export const S = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  card: { backgroundColor: C.card, marginHorizontal: 14, marginVertical: 7, padding: 14,
    borderRadius: 16, borderWidth: 1, borderColor: C.border },
  header: { fontSize: 21, fontWeight: "800", color: C.text, padding: 14 },
  sub: { fontSize: 14, color: C.muted, lineHeight: 21, marginBottom: 10 },
  text: { fontSize: 15, color: C.text },
  title: { fontSize: 17, fontWeight: "700", color: C.text },
  label: { fontSize: 13, fontWeight: "700", color: C.muted, marginBottom: 5, marginTop: 10 },
  input: { backgroundColor: "white", borderColor: C.border, borderWidth: 1, borderRadius: 10,
    minHeight: 46, paddingHorizontal: 12, color: C.text, fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  button: { borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, alignItems: "center",
    justifyContent: "center", minHeight: 40 },
  buttonLabel: { fontSize: 14, fontWeight: "700" },
});

export function Action({ label, onPress, variant = "primary", disabled, style }) {
  const background = variant === "primary" ? C.blue :
    variant === "danger" ? C.red : variant === "green" ? C.green : "#e8edf6";
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    onPress={onPress} disabled={disabled} style={[S.button, { backgroundColor: background, opacity: disabled ? 0.5 : 1 }, style]}>
    <Text style={[S.buttonLabel, { color: ["primary", "danger", "green"].includes(variant) ? "white" : C.text }]}>{label}</Text>
  </Pressable>;
}

export function Field({ label, value, onChangeText, placeholder, multiline = false, keyboardType = "default", autoCapitalize = "none" }) {
  return <View style={{ marginBottom: 6 }}>
    <Text style={S.label}>{label}</Text>
    <TextInput accessibilityLabel={label} style={[S.input, multiline && { minHeight: 100, textAlignVertical: "top", paddingTop: 12 }]}
      value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#93a0b3"
      multiline={multiline} keyboardType={keyboardType} autoCapitalize={autoCapitalize} />
  </View>;
}

export function Chip({ text, selected, onPress }) {
  return <Pressable onPress={onPress} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
    borderWidth: 1, borderColor: selected ? C.blue : C.border, backgroundColor: selected ? "#e4eeff" : "white", marginBottom: 6 }}>
    <Text style={{ fontSize: 13, fontWeight: selected ? "700" : "500", color: selected ? C.blue : C.text }}>{text}</Text>
  </Pressable>;
}

export function CategoryPicker({ categories, value, onChange, onCreate }) {
  const [adding, setAdding] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  return <View style={{ marginTop: 5 }}>
    <Text style={S.label}>分類（不選就是不分類）</Text>
    <View style={S.row}>
      <Chip text="不分類" selected={!value || value === "其他"} onPress={() => onChange("")} />
      {categories.map(c => <Chip key={c} text={c} selected={value === c} onPress={() => onChange(c)} />)}
      <Chip text="+ 新增分類" selected={adding} onPress={() => setAdding(!adding)} />
    </View>
    {adding && <View style={S.row}>
      <View style={{ flex: 1, minWidth: 160 }}><Field label="新分類名稱" value={typed} onChangeText={setTyped} placeholder="例如：麥當勞" /></View>
      <Action label="建立" onPress={async () => {
        const value = typed.trim();
        if (!value) return;
        const ok = await onCreate(value);
        if (ok) { onChange(value); setTyped(""); setAdding(false); }
      }} />
    </View>}
  </View>;
}
