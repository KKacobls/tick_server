import React from "react";
import { Alert, FlatList, Image, Text, TextInput, View } from "react-native";
import { Action, C, Chip, S } from "./ui";
import Barcode from "./Barcode";
import { imageSource } from "./api";

const STATUS = ["未使用", "已使用", "部分使用"];

function TicketRow({ ticket, connection, barcodeMode, onChangeState, onEdit }) {
  const [expanded, setExpanded] = React.useState(false);
  const [amount, setAmount] = React.useState(
    ticket.remaining_amount == null ? "" : String(ticket.remaining_amount)
  );
  const [partial, setPartial] = React.useState(false);
  const change = (state, remaining) => {
    onChangeState(ticket, state, remaining);
    setPartial(false);
  };
  return <View style={{ paddingVertical: 12, borderTopWidth: 1, borderColor: C.border }}>
    <Text style={S.text}>#{ticket.id} · {STATUS[ticket.local_state] || "未使用"}
      {ticket.face_value != null ? " · 面額 " + ticket.face_value : ""}</Text>
    <Text style={[S.sub, { marginBottom: 4 }]}>到期：{ticket.expires_at || (ticket.no_expiry ? "未提供期限" : "未設定")}</Text>
    <View style={S.row}>
      <Action label={expanded ? "收起條碼" : "顯示條碼"} variant="secondary" onPress={() => setExpanded(!expanded)} />
      <Action label="編輯" variant="secondary" onPress={() => onEdit(ticket)} />
      {ticket.local_state !== 1 && <Action label="標記已使用" variant="danger" onPress={() =>
        Alert.alert("確認使用", "將這張票券標記為已使用？", [
          { text: "取消" }, { text: "確認", onPress: () => change(1) },
        ])} />}
      {ticket.local_state !== 0 && <Action label="恢復未使用" variant="secondary" onPress={() => change(0)} />}
      {ticket.local_state !== 2 && <Action label="部分剩餘" variant="secondary" onPress={() => setPartial(!partial)} />}
    </View>
    {partial && <View style={[S.row, { marginTop: 8 }]}>
      <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad"
        placeholder="剩餘金額" placeholderTextColor="#94a3b8" style={[S.input, { flex: 1 }]} />
      <Action label="儲存剩餘" onPress={() => {
        const n = Number(amount);
        if (!amount.trim() || !Number.isFinite(n) || n < 0) {
          Alert.alert("金額錯誤", "請輸入有效的剩餘金額");
          return;
        }
        change(2, n);
      }} />
    </View>}
    {expanded && <View style={{ marginTop: 12 }}>
      {ticket.barcode_text && <Barcode value={ticket.barcode_text} mode={barcodeMode} />}
      {ticket.barcode_text_2 && <><Text style={S.label}>第二個條碼（7-11 商品卡）</Text>
        <Barcode value={ticket.barcode_text_2} mode={barcodeMode} /></>}
      {ticket.barcode_image && <Image source={imageSource(connection, ticket.barcode_image)}
        style={{ height: 230, width: "100%", resizeMode: "contain", marginTop: 8 }} />}
    </View>}
  </View>;
}

export default function TicketsScreen({ tickets, categories, connection, barcodeMode, syncStatus, onRefresh, onEdit, onChangeState }) {
  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [hideUsed, setHideUsed] = React.useState(false);
  const [open, setOpen] = React.useState({});
  const filtered = tickets.filter(ticket => {
    if (hideUsed && ticket.local_state > 0) return false;
    if (category && ticket.brand_tag !== category) return false;
    const query = search.trim().toLocaleLowerCase();
    if (!query) return true;
    return [ticket.name, ticket.brand_tag, ticket.barcode_text, ticket.barcode_text_2]
      .some(text => (text || "").toLocaleLowerCase().includes(query));
  });
  const groups = new Map();
  filtered.forEach(ticket => {
    const key = (ticket.brand_tag || "其他") + "\0" + ticket.name;
    if (!groups.has(key)) groups.set(key, { key, name: ticket.name, category: ticket.brand_tag, items: [] });
    groups.get(key).items.push(ticket);
  });
  const grouped = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  return <FlatList style={S.page} data={grouped} keyExtractor={item => item.key}
    keyboardShouldPersistTaps="handled"
    ListHeaderComponent={<View>
      <Text style={S.header}>我的票券 · {tickets.length} 張</Text>
      <View style={S.card}>
        <Text style={[S.sub, { color: syncStatus?.error ? C.red : C.muted }]}>
          {syncStatus?.error ? "離線快取：" + syncStatus.error :
            syncStatus?.time ? "已同步 Main：" + syncStatus.time : "尚未與 Main 同步"}
        </Text>
        <TextInput accessibilityLabel="搜尋票券" placeholder="搜尋名稱、分類或條碼" value={search}
          onChangeText={setSearch} style={S.input} placeholderTextColor="#94a3b8" />
        <View style={[S.row, { marginTop: 10 }]}>
          <Chip text="所有分類" selected={!category} onPress={() => setCategory("")} />
          {categories.map(c => <Chip key={c} text={c} selected={category === c} onPress={() => setCategory(c)} />)}
          <Chip text={hideUsed ? "✓ 隱藏已使用" : "隱藏已使用"} selected={hideUsed} onPress={() => setHideUsed(!hideUsed)} />
        </View>
        <Action label="立即從 Main 同步" variant="secondary" onPress={onRefresh} />
      </View>
    </View>}
    ListEmptyComponent={<View style={S.card}><Text style={S.sub}>沒有符合條件的票券。若剛配對 Main，請先確認伺服器可連線。</Text></View>}
    renderItem={({ item }) => {
      const expanded = search.trim() || !!open[item.key];
      return <View style={S.card}>
        <Text onPress={() => setOpen(previous => ({ ...previous, [item.key]: !previous[item.key] }))}
          style={S.title}>{expanded ? "▾" : "▸"} {item.name}</Text>
        <Text style={S.sub}>{(item.category && item.category !== "其他" ? item.category : "不分類")} ·
          {item.items.length} 張 · 尚未使用 {item.items.filter(t => t.local_state === 0).length} 張</Text>
        {expanded && item.items.map(ticket => <TicketRow key={ticket.id}
          ticket={ticket} connection={connection} barcodeMode={barcodeMode} onChangeState={onChangeState} onEdit={onEdit} />)}
      </View>;
    }}
  />;
}
