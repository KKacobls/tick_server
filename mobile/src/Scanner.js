import React from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { Action, C, CategoryPicker, Field, S } from "./ui";
const { is711Batch, is711Title, previewText, parsePairQR } = require("./core");

const TYPES = ["qr", "code128", "code39", "code93", "ean13", "ean8", "upc_a", "upc_e", "itf14", "pdf417", "datamatrix", "aztec"];

export function PairScreen({ onPair, busy }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = React.useState("");
  const [active, setActive] = React.useState(false);
  const [locked, setLocked] = React.useState(false);

  const accept = async raw => {
    if (locked || busy) return;
    setLocked(true);
    try {
      const pairing = parsePairQR(raw);
      await onPair(pairing);
      setActive(false);
    } catch (err) {
      Alert.alert("無法配對", err.message);
    } finally { setLocked(false); }
  };
  return <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 30 }}>
    <Text style={S.header}>手機與 Main 配對</Text>
    <View style={S.card}>
      <Text style={S.sub}>手機永遠是輔助端，不用帳號密碼。請先用電腦登入 Main → 設定 → 手機 App 配對 → 產生 QR Code，再用手機掃描。</Text>
      <Action label={active ? "關閉配對相機" : "掃描 Main 配對 QR Code"} onPress={async () => {
        if (!permission?.granted) {
          const p = await requestPermission();
          if (!p.granted) { Alert.alert("無法使用相機", "請在系統設定開啟相機權限"); return; }
        }
        setActive(!active);
      }} />
      {active && <View style={{ marginTop: 14, height: 350, overflow: "hidden", borderRadius: 14 }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={event => accept(event.data)} />
      </View>}
      <Text style={S.label}>沒有相機時，也可以貼上完整配對內容（測試用）</Text>
      <TextInput multiline value={manual} onChangeText={setManual} placeholder="貼上 Main 配對 JSON"
        style={[S.input, { minHeight: 70, textAlignVertical: "top" }]} />
      <Action label={busy ? "正在連線…" : "使用貼上的配對碼"} disabled={busy || !manual.trim()}
        onPress={() => accept(manual)} style={{ marginTop: 8 }} />
      <Text style={[S.sub, { marginTop: 14 }]}>為保護裝置授權，Main 必須有 HTTPS 網址；一般的「分享票券」唯讀 QR Code 不能用來編輯或掃描上傳。</Text>
    </View>
  </ScrollView>;
}

export function ScanScreen({
  phase, setPhase, codes, onCode, onStop, onClear, onRemove, onMove,
  title, setTitle, category, setCategory, categories, onCreateCategory,
  force711, setForce711, onSave, saving,
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = React.useState(false);
  const [manual, setManual] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const scan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) { Alert.alert("相機權限", "請允許相機存取才能掃描"); return; }
    }
    setPhase("scanning");
    setNotice("");
  };

  const add = data => {
    const value = String(data || "").trim();
    if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
      setNotice("不支援空白、超過 128 字元或含換行的 QR 內容");
      return;
    }
    if (value.startsWith('{"type":"tick_server_pair_v1"')) {
      setNotice("這是 Main 配對碼；請至「設定」掃描配對");
      return;
    }
    const added = onCode(value);
    if (added) setNotice("已加入：" + value);
  };

  const detected711 = is711Batch(codes);
  const wants711 = force711 || is711Title(title) || detected711;
  const invalid711 = wants711 && !detected711;
  const preview = previewText(title, codes);
  return <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
    <Text style={S.header}>連續掃描</Text>
    {phase === "idle" && <View style={S.card}>
      <Text style={S.sub}>對準畫面中的一維條碼或 QR Code；同一批次掃過的內容只會保留一次。掃完按「停止」再輸入名稱與分類。</Text>
      <Action label={codes.length ? "繼續上次掃描" : "開始連續掃描"} onPress={scan} />
      {codes.length > 0 && <Action label={"查看已掃描 " + codes.length + " 筆"} variant="secondary" onPress={() => setPhase("review")} style={{ marginTop: 8 }} />}
    </View>}

    {phase === "scanning" && <View style={S.card}>
      <View style={{ height: 335, borderRadius: 12, overflow: "hidden" }}>
        <CameraView style={{ flex: 1 }} facing="back" enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: TYPES }}
          onBarcodeScanned={event => add(event.data)} />
        <View pointerEvents="none" style={styles.frame}><View style={styles.frameLine} /></View>
      </View>
      <Text style={[S.title, { marginTop: 10 }]}>已掃描 {codes.length} 個不重複條碼</Text>
      <Text style={S.sub} numberOfLines={2}>{notice || "可連續移動相機，不需每掃一次就按確認"}</Text>
      <View style={S.row}>
        <Action label={torch ? "關閉手電筒" : "開啟手電筒"} variant="secondary" onPress={() => setTorch(!torch)} />
        <Action label="停止並整理" onPress={onStop} style={{ flex: 1 }} />
      </View>
      {codes.slice(-5).map((code, i) => <Text key={code + i} style={[S.sub, { marginBottom: 2 }]} numberOfLines={1}>{code}</Text>)}
    </View>}

    {phase === "review" && <View style={S.card}>
      <Text style={S.title}>掃描結束 · {codes.length} 個不重複條碼</Text>
      <Field label="票券名稱（必填）" value={title} onChangeText={setTitle} placeholder="例如：【麥當勞】漢堡(好禮即享券)" autoCapitalize="sentences" />
      <CategoryPicker categories={categories} value={category} onChange={setCategory} onCreate={onCreateCategory} />
      <View style={[S.row, { marginVertical: 8 }]}>
        <Action label={force711 ? "✓ 7-11 商品卡雙條碼" : "指定 7-11 商品卡"} variant="secondary" onPress={() => setForce711(!force711)} />
      </View>
      {wants711 && <Text style={[S.sub, { color: invalid711 ? C.red : C.green }]}>
        {invalid711 ? "7-11 商品卡必須每 2 個相鄰條碼配成一組（7100 開頭的 16 位數 + 含英文字母的 8 碼）；請調整順序或重新掃描。" :
          "已辨識為 7-11 商品卡，資料庫每張票券會保存兩個條碼。"}
      </Text>}
      <Text style={S.label}>調整條碼順序／移除誤掃內容</Text>
      {codes.map((code, i) => <View key={code} style={[S.row, { marginVertical: 4, borderBottomWidth: 1, borderBottomColor: C.border, paddingBottom: 5 }]}>
        <Text style={[S.text, { flex: 1, fontSize: 13 }]} selectable>{i + 1}. {code}</Text>
        <Action label="↑" variant="secondary" disabled={i === 0} onPress={() => onMove(i, -1)} />
        <Action label="↓" variant="secondary" disabled={i === codes.length - 1} onPress={() => onMove(i, 1)} />
        <Action label="×" variant="danger" onPress={() => onRemove(code)} />
      </View>)}
      <View style={S.row}>
        <View style={{ flex: 1, minWidth: 170 }}><Field label="手動補上一組條碼" value={manual} onChangeText={setManual} /></View>
        <Action label="加入" onPress={() => { add(manual); setManual(""); }} />
      </View>
      <Text style={S.label}>最後文字格式預覽</Text>
      <Text selectable style={[S.input, { fontFamily: "monospace", paddingVertical: 12, lineHeight: 23 }]}>{preview || "尚無資料"}</Text>
      <View style={[S.row, { marginTop: 12 }]}>
        <Action label="複製文字" variant="secondary" onPress={async () => {
          await Clipboard.setStringAsync(preview);
          Alert.alert("已複製", "已複製名稱與所有條碼");
        }} />
        <Action label="繼續掃描" variant="secondary" onPress={scan} />
      </View>
      <Action label={saving ? "儲存中…" : "寫入 Main 資料庫"} disabled={saving || !title.trim() || !codes.length || invalid711}
        onPress={onSave} style={{ marginTop: 12 }} />
      <Action label="丟棄這批掃描" variant="danger" onPress={() => Alert.alert("清除？", "這批尚未儲存的條碼將被丟棄", [
        { text: "取消" }, { text: "清除", style: "destructive", onPress: onClear },
      ])} style={{ marginTop: 8 }} />
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  frame: { position: "absolute", left: 22, right: 22, top: 70, bottom: 70,
    borderWidth: 2, borderColor: "#47dfb7", borderRadius: 18, justifyContent: "center" },
  frameLine: { height: 2, backgroundColor: "#47dfb7", marginHorizontal: 12 },
});
