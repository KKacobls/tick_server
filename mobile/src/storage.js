import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const KEY = "tick_server.mobile_pair";
const MODE = "tick_server.mode";
const DISPLAY = "tick_server.display";
const SCAN = "tick_server.scan_draft";
const ticketsKey = server => "tick_server.tickets." + server;

export async function loadConnection() {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export async function saveConnection(connection) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(connection));
}
export async function removeConnection() {
  await SecureStore.deleteItemAsync(KEY);
}
export async function loadMode() { return (await AsyncStorage.getItem(MODE)) || "mirror"; }
export async function saveMode(mode) { await AsyncStorage.setItem(MODE, mode); }
export async function loadDisplay() { return (await AsyncStorage.getItem(DISPLAY)) || "qr"; }
export async function saveDisplay(mode) { await AsyncStorage.setItem(DISPLAY, mode); }
export async function loadTickets(server) {
  try { return JSON.parse((await AsyncStorage.getItem(ticketsKey(server))) || "[]"); }
  catch { return []; }
}
export async function saveTickets(server, data) {
  await AsyncStorage.setItem(ticketsKey(server), JSON.stringify(data));
}
export async function loadDraft() {
  try { return JSON.parse((await AsyncStorage.getItem(SCAN)) || "{}"); }
  catch { return {}; }
}
export async function saveDraft(draft) {
  await AsyncStorage.setItem(SCAN, JSON.stringify(draft));
}
export async function clearDraft() { await AsyncStorage.removeItem(SCAN); }
