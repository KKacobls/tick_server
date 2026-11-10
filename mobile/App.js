import React from "react";
import { Alert, AppState, Platform, Pressable, SafeAreaView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import TicketsScreen from "./src/Tickets";
import ManualScreen from "./src/Manual";
import { LogsScreen, SettingsScreen } from "./src/OtherScreens";
import { PairScreen, ScanScreen } from "./src/Scanner";
import { Action, C, S } from "./src/ui";
import { mainRequest } from "./src/api";
import {
  clearDraft, loadConnection, loadDisplay, loadDraft, loadMode, loadTickets,
  removeConnection, saveConnection, saveDisplay, saveDraft, saveMode, saveTickets,
} from "./src/storage";
const { mergeTickets, is711Batch, uniqueCodes } = require("./src/core");

const TABS = [
  { id: "list", icon: "⌂", name: "首頁" },
  { id: "manual", icon: "+", name: "新增" },
  { id: "logs", icon: "◷", name: "紀錄" },
  { id: "settings", icon: "⚙", name: "設定" },
  { id: "scan", icon: "▣", name: "掃描" }, // scanner is always the last bottom tab
];

export default function App() {
  const [ready, setReady] = React.useState(false);
  const [connection, setConnection] = React.useState(null);
  const [pairing, setPairing] = React.useState(false);
  const [pairBusy, setPairBusy] = React.useState(false);
  const [page, setPage] = React.useState("list");
  const [mode, setMode] = React.useState("mirror");
  const [barcodeMode, setBarcodeMode] = React.useState("qr");
  const [tickets, setTickets] = React.useState([]);
  const [categories, setCategories] = React.useState([]);
  const [logs, setLogs] = React.useState([]);
  const [syncStatus, setSyncStatus] = React.useState({});
  const [editing, setEditing] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  const [phase, setPhase] = React.useState("idle");
  const [codes, setCodes] = React.useState([]);
  const [scanTitle, setScanTitle] = React.useState("");
  const [scanCategory, setScanCategory] = React.useState("");
  const [force711, setForce711] = React.useState(false);

  const connRef = React.useRef(null);
  const modeRef = React.useRef("mirror");
  const ticketRef = React.useRef([]);
  const codesRef = React.useRef(new Set());
  const syncLock = React.useRef(false);
  const draftReady = React.useRef(false);

  React.useEffect(() => { connRef.current = connection; }, [connection]);
  React.useEffect(() => { modeRef.current = mode; }, [mode]);
  React.useEffect(() => { ticketRef.current = tickets; }, [tickets]);

  const syncNow = React.useCallback(async (forcedConn = null, forcedMode = null) => {
    const conn = forcedConn || connRef.current;
    if (!conn || syncLock.current) return;
    syncLock.current = true;
    try {
      const remote = await mainRequest(conn, "/tickets");
      if (!Array.isArray(remote) || remote.some(item => typeof item.id !== "number" || !item.name)) {
        throw Error("Main 回傳了不合法的票券清單");
      }
      const cached = await loadTickets(conn.server);
      const result = mergeTickets(cached, remote, forcedMode || modeRef.current);
      await saveTickets(conn.server, result);
      ticketRef.current = result;
      setTickets(result);
      setSyncStatus({ time: new Date().toLocaleString("zh-TW"), error: null });
      try {
        const tags = await mainRequest(conn, "/categories");
        if (Array.isArray(tags)) setCategories(tags);
      } catch { /* ticket data remains valid even if category fetch fails */ }
    } catch (err) {
      // Keep cached data on network errors, even when mirror mode is selected.
      setSyncStatus(last => ({ ...last, error: err.message }));
    } finally { syncLock.current = false; }
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [storedConn, storedMode, storedDisplay, draft] = await Promise.all([
          loadConnection(), loadMode(), loadDisplay(), loadDraft(),
        ]);
        if (!alive) return;
        setConnection(storedConn);
        connRef.current = storedConn;
        setMode(storedMode);
        modeRef.current = storedMode;
        setBarcodeMode(storedDisplay);
        const draftCodes = uniqueCodes(draft.codes || []);
        codesRef.current = new Set(draftCodes);
        setCodes(draftCodes);
        setScanTitle(draft.title || "");
        setScanCategory(draft.category || "");
        setForce711(!!draft.force711);
        setPhase(draftCodes.length ? "review" : "idle");
        if (storedConn?.server) {
          const cache = await loadTickets(storedConn.server);
          if (!alive) return;
          ticketRef.current = cache;
          setTickets(cache);
        }
        draftReady.current = true;
        setReady(true);
        if (storedConn) syncNow(storedConn, storedMode);
      } catch (err) {
        if (alive) { setSyncStatus({ error: err.message }); setReady(true); }
      }
    })();
    return () => { alive = false; };
  }, [syncNow]);

  React.useEffect(() => {
    if (!draftReady.current) return;
    saveDraft({ codes, title: scanTitle, category: scanCategory, force711 }).catch(() => {});
  }, [codes, scanTitle, scanCategory, force711]);

  React.useEffect(() => {
    const listener = AppState.addEventListener("change", state => {
      if (state === "active") syncNow();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") syncNow();
    }, 60000);
    return () => { listener.remove(); clearInterval(timer); };
  }, [syncNow]);

  const updateCache = async update => {
    const updated = update(ticketRef.current);
    ticketRef.current = updated;
    setTickets(updated);
    if (connRef.current) await saveTickets(connRef.current.server, updated);
  };

  const fetchLogs = async () => {
    try {
      const data = await mainRequest(connRef.current, "/logs");
      setLogs(data);
    } catch (err) { Alert.alert("讀取紀錄失敗", err.message); }
  };
  React.useEffect(() => {
    if (page === "logs" && connection && !pairing) fetchLogs();
  }, [page, connection, pairing]);

  const onPair = async newConnection => {
    setPairBusy(true);
    try {
      const info = await mainRequest(newConnection, "/info");
      if (info?.mode !== "main") throw Error("這台伺服器目前是輔助模式，請配對真正的 Main");
      await saveConnection(newConnection);
      connRef.current = newConnection;
      setConnection(newConnection);
      setPairing(false);
      setPage("list");
      const cache = await loadTickets(newConnection.server);
      ticketRef.current = cache;
      setTickets(cache);
      await syncNow(newConnection, modeRef.current);
      Alert.alert("配對成功", "手機已連線 Main，不需要登入。");
    } finally { setPairBusy(false); }
  };

  const createCategory = async name => {
    try {
      await mainRequest(connRef.current, "/categories", {
        method: "POST", body: JSON.stringify({ name }),
      });
      setCategories(old => [...new Set([...old, name])].sort((a, b) => a.localeCompare(b, "zh-Hant")));
      return true;
    } catch (err) {
      Alert.alert("分類建立失敗", err.message);
      return false;
    }
  };

  const changeMode = async next => {
    modeRef.current = next;
    setMode(next);
    await saveMode(next);
    await syncNow(connRef.current, next);
  };
  const changeDisplay = async next => {
    setBarcodeMode(next);
    await saveDisplay(next);
  };
  const changeState = async (ticket, state, remaining) => {
    try {
      const updated = await mainRequest(connRef.current, "/tickets/" + ticket.id + "/state", {
        method: "PATCH", body: JSON.stringify({ local_state: state, remaining_amount: remaining ?? null }),
      });
      await updateCache(items => items.map(item => item.id === ticket.id ? updated : item));
    } catch (err) { Alert.alert("更新狀態失敗", err.message); }
  };

  const saveManual = async (fields, photo, old) => {
    setSaving(true);
    try {
      let saved = await mainRequest(connRef.current, old ? "/tickets/" + old.id : "/tickets", {
        method: old ? "PATCH" : "POST", body: JSON.stringify(fields),
      });
      let imageWarning = "";
      if (photo) {
        try {
          const form = new FormData();
          form.append("file", {
            uri: photo.uri,
            name: photo.fileName || "ticket.jpg",
            type: photo.mimeType || "image/jpeg",
          });
          saved = await mainRequest(connRef.current, "/tickets/" + saved.id + "/image", {
            method: "POST", body: form,
          });
        } catch (err) { imageWarning = "票券已儲存，但圖片上傳失敗：" + err.message; }
      }
      await updateCache(items => old
        ? items.map(item => item.id === saved.id ? saved : item)
        : [...items, saved]);
      setEditing(null);
      setPage("list");
      await syncNow();
      if (imageWarning) Alert.alert("部分完成", imageWarning);
    } catch (err) { Alert.alert("票券儲存失敗", err.message); }
    finally { setSaving(false); }
  };

  const addScanCode = raw => {
    const code = String(raw).trim();
    if (!code || code.length > 128 || codesRef.current.has(code) || codesRef.current.size >= 300) return false;
    codesRef.current.add(code);
    setCodes(previous => [...previous, code]);
    return true;
  };
  const removeScanCode = code => {
    codesRef.current.delete(code);
    setCodes(prev => prev.filter(item => item !== code));
  };
  const moveScanCode = (index, by) => setCodes(prev => {
    const output = [...prev];
    const target = index + by;
    if (target < 0 || target >= output.length) return prev;
    [output[index], output[target]] = [output[target], output[index]];
    return output;
  });
  const stopScan = () => {
    if (!scanTitle.trim() && is711Batch(codes)) setScanTitle("7-11商品卡#711");
    setPhase("review");
  };
  const resetScan = async () => {
    codesRef.current.clear();
    setCodes([]);
    setScanTitle("");
    setScanCategory("");
    setForce711(false);
    setPhase("idle");
    await clearDraft();
  };
  const saveScan = async () => {
    setSaving(true);
    try {
      const result = await mainRequest(connRef.current, "/tickets/scan", {
        method: "POST", body: JSON.stringify({
          title: scanTitle.trim(), category: scanCategory || null,
          codes, force_seven_eleven: force711,
        }),
      });
      await updateCache(old => [...old, ...result.items.filter(row => !old.some(item => item.id === row.id))]);
      await resetScan();
      setPage("list");
      await syncNow();
      Alert.alert("已寫入 Main", "新增 " + result.created + " 張票券；略過已存在 " + result.duplicates + " 張。");
    } catch (err) {
      // Deliberately retain review draft on any server, validation or network failure.
      Alert.alert("尚未儲存，草稿已保留", err.message);
    } finally { setSaving(false); }
  };

  const disconnect = async () => {
    await removeConnection();
    connRef.current = null;
    setConnection(null);
    setTickets([]);
    ticketRef.current = [];
    setPage("list");
    setPairing(true);
  };

  const deleteUsed = async () => {
    try {
      const result = await mainRequest(connRef.current, "/tickets/delete-used", { method: "POST" });
      await syncNow();
      Alert.alert("刪除完成", "Main 已刪除 " + result.deleted + " 張已使用票券");
    } catch (err) { Alert.alert("刪除失敗", err.message); }
  };

  if (!ready) return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, justifyContent: "center" }}>
    <Text style={{ textAlign: "center", color: C.text }}>正在讀取本機設定…</Text>
  </SafeAreaView>;

  const needsPair = pairing || !connection;
  return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === "android" ? 12 : 0 }}>
    <StatusBar style="dark" />
    {needsPair ? <View style={{ flex: 1 }}>
      {connection && <Action label="返回票券" variant="secondary" onPress={() => setPairing(false)} />}
      <PairScreen onPair={onPair} busy={pairBusy} />
    </View> : <>
      <View style={{ padding: 14, backgroundColor: "white", borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: C.text, fontSize: 20, fontWeight: "800" }}>KK票券助手</Text>
        <Text style={{ color: C.muted, fontSize: 12 }}>輔助端 · Main 同步</Text>
      </View>
      <View style={{ flex: 1 }}>
        {page === "list" && <TicketsScreen tickets={tickets} categories={categories} connection={connection}
          barcodeMode={barcodeMode} syncStatus={syncStatus} onRefresh={() => syncNow()} onEdit={ticket => {
            setEditing(ticket); setPage("manual");
          }} onChangeState={changeState} />}
        {page === "manual" && <ManualScreen editing={editing} categories={categories} connection={connection}
          onCreateCategory={createCategory} onSave={saveManual} saving={saving}
          onCancel={() => { setEditing(null); setPage("list"); }} />}
        {page === "logs" && <LogsScreen logs={logs} onRefresh={fetchLogs} />}
        {page === "settings" && <SettingsScreen connection={connection} mode={mode} onChangeMode={changeMode}
          display={barcodeMode} onChangeDisplay={changeDisplay} onRefresh={() => syncNow()}
          onRePair={() => setPairing(true)} onDisconnect={disconnect} syncStatus={syncStatus}
          tickets={tickets} onDeleteUsed={deleteUsed} />}
        {page === "scan" && <ScanScreen phase={phase} setPhase={setPhase}
          codes={codes} onCode={addScanCode} onStop={stopScan} onClear={resetScan}
          onRemove={removeScanCode} onMove={moveScanCode}
          title={scanTitle} setTitle={setScanTitle} category={scanCategory} setCategory={setScanCategory}
          categories={categories} onCreateCategory={createCategory} force711={force711} setForce711={setForce711}
          onSave={saveScan} saving={saving} />}
      </View>
      <View style={{ flexDirection: "row", backgroundColor: "white", borderTopWidth: 1, borderTopColor: C.border,
        paddingBottom: Platform.OS === "ios" ? 14 : 4 }}>
        {TABS.map(tab => <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: page === tab.id }}
          onPress={() => { if (tab.id === "manual" && page !== "manual") setEditing(null); setPage(tab.id); }}
          style={{ flex: 1, alignItems: "center", paddingVertical: 10, backgroundColor: page === tab.id ? "#e8f0ff" : "white" }}>
          <Text style={{ fontSize: 22, fontWeight: "800", color: page === tab.id ? C.blue : C.muted }}>{tab.icon}</Text>
          <Text style={{ fontSize: 12, color: page === tab.id ? C.blue : C.text, fontWeight: "700" }}>{tab.name}</Text>
        </Pressable>)}
      </View>
    </>}
  </SafeAreaView>;
}
