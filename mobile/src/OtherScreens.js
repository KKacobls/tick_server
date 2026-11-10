import React from "react";
import { Alert, FlatList, ScrollView, Share, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Action, C, Chip, S } from "./ui";

export function LogsScreen({ logs, onRefresh }) {
  const [q, setQ] = React.useState("");
  const filtered = logs.filter(entry => (entry.action + " " + (entry.detail || "")).toLowerCase().includes(q.toLowerCase()));
  return <FlatList style={S.page} data={filtered} keyExtractor={item => String(item.id)}
    ListHeaderComponent={<View>
      <Text style={S.header}>操作紀錄</Text>
      <View style={S.card}>
        <TextInput value={q} onChangeText={setQ} placeholder="搜尋動作或內容"
          placeholderTextColor="#94a3b8" style={S.input} />
        <Action label="更新紀錄" variant="secondary" style={{ marginTop: 8 }} onPress={onRefresh} />
      </View>
    </View>}
    ListEmptyComponent={<View style={S.card}><Text style={S.sub}>暫無紀錄。</Text></View>}
    renderItem={({ item }) => <View style={S.card}>
      <Text style={S.title}>{item.action}</Text>
      <Text style={S.sub}>{new Date(item.created_at).toLocaleString("zh-TW")}</Text>
      <Text style={S.text}>{item.detail || ""}</Text>
    </View>}
  />;
}

function buildExport(tickets) {
  const groups = new Map();
  for (const ticket of tickets) {
    if (!groups.has(ticket.name)) groups.set(ticket.name, []);
    for (const code of [ticket.barcode_text, ticket.barcode_text_2]) {
      if (code) groups.get(ticket.name).push(code);
    }
  }
  return [...groups.entries()].map(([name, values]) => [name, ...values].join("\n")).join("\n\n");
}

export function SettingsScreen({
  connection, mode, onChangeMode, display, onChangeDisplay, onRefresh,
  onRePair, onDisconnect, syncStatus, tickets, onDeleteUsed,
}) {
  const exportText = buildExport(tickets);
  return <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 35 }}>
    <Text style={S.header}>設定</Text>
    <View style={S.card}>
      <Text style={S.title}>Main 連線</Text>
      <Text selectable style={[S.sub, { marginTop: 8 }]}>{connection?.server || "尚未配對"}</Text>
      <Text style={[S.sub, { color: syncStatus?.error ? C.red : C.green }]}>
        {syncStatus?.error ? "連線失敗：" + syncStatus.error :
          syncStatus?.time ? "最後同步：" + syncStatus.time : "尚未同步"}
      </Text>
      <Text style={S.sub}>手機固定為輔助端，不會執行 Main 服務，也不需要帳號密碼登入。</Text>
      <View style={S.row}>
        <Action label="立即同步" onPress={onRefresh} />
        <Action label="掃描新的 Main 配對碼" variant="secondary" onPress={onRePair} />
      </View>
    </View>
    <View style={S.card}>
      <Text style={S.title}>與 Main 的同步方式</Text>
      <Text style={[S.sub, { marginTop: 8 }]}>掃描新增的票券一律直接傳到 Main。下列選項只控制手機收到 Main 資料後，如何更新手機快取。</Text>
      <View style={S.row}>
        <Chip text="✓ 完全同步" selected={mode === "mirror"} onPress={() => onChangeMode("mirror")} />
        <Chip text="只新增 Main 票券" selected={mode === "append"} onPress={() => onChangeMode("append")} />
      </View>
      <Text style={[S.sub, { marginTop: 8 }]}>
        {mode === "mirror" ? "完全同步：Main 改名、改狀態、刪除，手機下一次同步都跟著更新；同步失敗時保留原快取。" :
          "只新增：手機只補進 Main 沒看過的新票券；既有快取不覆寫，Main 刪掉的舊票也暫時保留在手機。"}
      </Text>
    </View>
    <View style={S.card}>
      <Text style={S.title}>條碼顯示</Text>
      <View style={[S.row, { marginTop: 10 }]}>
        <Chip text="QR Code" selected={display === "qr"} onPress={() => onChangeDisplay("qr")} />
        <Chip text="一維 Code128" selected={display === "barcode"} onPress={() => onChangeDisplay("barcode")} />
      </View>
    </View>
    <View style={S.card}>
      <Text style={S.title}>文字匯出</Text>
      <Text style={[S.sub, { marginTop: 7 }]}>依名稱合併；7-11 商品卡會依序輸出兩組條碼。</Text>
      <Action label="複製全部票券文字" variant="secondary" onPress={async () => {
        await Clipboard.setStringAsync(exportText);
        Alert.alert("完成", "已複製票券文字");
      }} />
      <Action label="分享全部票券文字" variant="secondary" style={{ marginTop: 8 }}
        onPress={() => Share.share({ message: exportText || "尚無票券" })} />
    </View>
    <View style={S.card}>
      <Text style={S.title}>資料整理</Text>
      <Text style={[S.sub, { marginTop: 8 }]}>只會刪除 Main 中「已使用、非部分使用」的票券。此操作不可復原，建議先備份 Main 資料庫。</Text>
      <Action label="刪除 Main 已使用票券" variant="danger" onPress={() => Alert.alert(
        "確認刪除 Main 票券？", "會永久刪除 Main 所有標記「已使用」的票券，不含部分剩餘。",
        [{ text: "取消" }, { text: "確定刪除", style: "destructive", onPress: onDeleteUsed }]
      )} />
      <Action label="解除本手機配對" variant="secondary" style={{ marginTop: 12 }} onPress={() => Alert.alert(
        "解除手機配對？", "將清除這台手機保存的授權資訊，已下載票券快取不會自動刪除。請同時到 Main 網站撤銷裝置權杖。",
        [{ text: "取消" }, { text: "解除", style: "destructive", onPress: onDisconnect }]
      )} />
    </View>
  </ScrollView>;
}
