import React from "react";
import { Alert, Image, ScrollView, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Action, CategoryPicker, Field, S } from "./ui";
import { imageSource } from "./api";

function today() { return new Date().toISOString().slice(0, 10); }
const DATE = /^\d{4}-\d\d-\d\d$/;

export default function ManualScreen({ editing, categories, connection, onCreateCategory, onSave, onCancel, saving }) {
  const [name, setName] = React.useState(editing?.name || "");
  const [code, setCode] = React.useState(editing?.barcode_text || "");
  const [code2, setCode2] = React.useState(editing?.barcode_text_2 || "");
  const [category, setCategory] = React.useState(editing?.brand_tag === "其他" ? "" : (editing?.brand_tag || ""));
  const [insertDate, setInsertDate] = React.useState(editing?.insert_date || today());
  const [expires, setExpires] = React.useState(editing?.expires_at || "");
  const [faceValue, setFaceValue] = React.useState(editing?.face_value == null ? "" : String(editing.face_value));
  const [photo, setPhoto] = React.useState(null);

  React.useEffect(() => {
    setName(editing?.name || "");
    setCode(editing?.barcode_text || "");
    setCode2(editing?.barcode_text_2 || "");
    setCategory(editing?.brand_tag === "其他" ? "" : (editing?.brand_tag || ""));
    setInsertDate(editing?.insert_date || today());
    setExpires(editing?.expires_at || "");
    setFaceValue(editing?.face_value == null ? "" : String(editing.face_value));
    setPhoto(null);
  }, [editing?.id]);

  const pick = async () => {
    const selection = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (!selection.canceled && selection.assets?.length) setPhoto(selection.assets[0]);
  };
  const submit = () => {
    if (!name.trim()) return Alert.alert("資料不足", "請輸入票券名稱");
    if (!code.trim() && !photo && !editing?.barcode_image) {
      return Alert.alert("資料不足", "請輸入條碼，或選擇票券圖片");
    }
    if (insertDate && !DATE.test(insertDate)) return Alert.alert("日期格式", "取得日期請輸入 YYYY-MM-DD");
    if (expires && !DATE.test(expires)) return Alert.alert("日期格式", "到期日期請輸入 YYYY-MM-DD");
    if (faceValue && (!Number.isFinite(Number(faceValue)) || Number(faceValue) < 0)) {
      return Alert.alert("金額格式", "請輸入有效的非負金額");
    }
    onSave({
      name: name.trim(), barcode_text: code.trim() || null, barcode_text_2: code2.trim() || null,
      brand_tag: category || "其他", insert_date: insertDate || null, expires_at: expires || null,
      no_expiry: !expires, face_value: faceValue ? Number(faceValue) : null,
    }, photo, editing);
  };

  return <ScrollView style={S.page} contentContainerStyle={{ paddingBottom: 35 }} keyboardShouldPersistTaps="handled">
    <Text style={S.header}>{editing ? "編輯票券" : "新增票券"}</Text>
    <View style={S.card}>
      <Field label="名稱 *" value={name} onChangeText={setName} placeholder="例如：【麥當勞】漢堡(好禮即享券)" autoCapitalize="sentences" />
      <Field label="第一組條碼" value={code} onChangeText={setCode} placeholder="掃描或貼上條碼內容" />
      <Field label="第二組條碼（7-11 商品卡可填）" value={code2} onChangeText={setCode2} placeholder="選填" />
      <CategoryPicker categories={categories} value={category} onChange={setCategory} onCreate={onCreateCategory} />
      <Field label="取得日期（YYYY-MM-DD）" value={insertDate} onChangeText={setInsertDate} placeholder="2026-11-10" />
      <Field label="到期日期（YYYY-MM-DD，留空即未設定）" value={expires} onChangeText={setExpires} placeholder="2027-02-10" />
      <Field label="面額（選填）" value={faceValue} onChangeText={setFaceValue} keyboardType="decimal-pad" placeholder="100" />
      <Text style={S.label}>票券圖片（選填）</Text>
      {editing?.barcode_image && !photo && <Image source={imageSource(connection, editing.barcode_image)}
        style={{ height: 160, width: "100%", resizeMode: "contain" }} />}
      {photo && <Image source={{ uri: photo.uri }} style={{ height: 160, width: "100%", resizeMode: "contain" }} />}
      <View style={[S.row, { marginTop: 8 }]}>
        <Action label="選擇圖片" variant="secondary" onPress={pick} />
        {photo && <Action label="清除選擇" variant="secondary" onPress={() => setPhoto(null)} />}
      </View>
      <Text style={[S.sub, { marginTop: 8 }]}>儲存會直接寫到 Main；手機本身不會建立獨立的 Main 資料庫。</Text>
      <Action label={saving ? "儲存中…" : editing ? "儲存修改" : "新增票券"} disabled={saving} onPress={submit} />
      {editing && <Action label="取消編輯" variant="secondary" onPress={onCancel} style={{ marginTop: 8 }} />}
    </View>
  </ScrollView>;
}
