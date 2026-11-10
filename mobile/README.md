# KK票券助手（Android 優先／iOS 共用）

這是 `tick_server` 的 React Native + Expo 手機 **輔助端**，不會在手機上啟動另一份 Main，也不要求輸入帳號、密碼。所有掃描新增、修改與使用狀態的操作都直接寫進既有 Main 的 SQLite；手機只保留離線檢視快取和未完成掃描草稿。

## 主要功能

- 底部分頁：首頁／新增／紀錄／設定／**掃描**（固定在最右、最下方）。
- 首頁：依名稱收合、關鍵字與分類搜尋、隱藏已使用、顯示 QR Code 或一維 Code128、雙條碼、票券圖片、使用／部分使用／還原、編輯。
- 新增：票券名稱、1～2 組條碼、分類（包含新增分類、不分類）、日期、面額、圖片。
- 紀錄：查看 Main 最近 100 則操作紀錄。
- 掃描：以相機連續辨識常見一維條碼、QR Code；**同一批次重複內容自動略過**，有「停止並整理」、移除、上下排序、繼續掃描、手動補入、文字預覽／複製。輸入名稱和分類後，整批寫入 Main；網路錯誤保留草稿。
- 特例：標題包含 `7-11商品卡`、`#711`，或整批掃描符合 7-11 雙碼特徵時，每兩碼存成**同一張**票券的 `barcode_text` 與 `barcode_text_2`。規則：一個 `7100` 開頭的 16 位數字，搭配一個包含英文字母的 8 碼英數字；先後順序可相反，但每張卡兩碼需相鄰。不確定、缺碼、錯序時不會靜默亂配，必須手動修正。
- 設定 → 同步方式：
  - **完全同步**：手機快取完整反映 Main 的新增／更新／刪除；網路錯誤不清掉快取。
  - **只新增 Main 票券**：保留手機既有快取、不覆蓋舊項目；只追加 Main 新項目。這不是另一台 Main，也不會將快取舊項目回推覆蓋 Main。
- 每次進入前景及每 60 秒（App 在前景時）同步，可手動更新。掃描新增不受此間隔限制，立即 POST 到 Main。

## 首次配對（不登入手機）

1. 在 **Main 伺服器**部署包含 `app/mobile.py`、`app/mobile_auth.py` 和新增網頁設定的版本，重啟 FastAPI（啟動時自動建立 `mobile_devices`、`mobile_categories` 表）。請先設定強密碼、`auth.secret_key`，並經 HTTPS 對外提供服務。
2. **電腦瀏覽器**登入原本 Main 網站 → **設定** → **手機 App 配對**，輸入裝置名稱 → **產生手機配對 QR Code**。
3. **手機 App** 開啟後選「掃描 Main 配對 QR Code」。首次配對後權杖存入 Android Keystore／iOS Keychain（Expo SecureStore）。沒有任何手機登入畫面。注意：一般的「分享票券」QR Code 是唯讀，不可拿來上傳／修改票券。
4. 要停用某台手機，在 Main 的已授權裝置列表按「撤銷此裝置」。不需要變更網頁登入密碼。

**安全**：正式版要求 HTTPS（含有效憑證），不接受純 HTTP 配對，以避免網路中間人竊取長期裝置權杖。QR Code 含可存取 Main 票券的授權憑證，勿截圖公開。只有 Main 管理者能產生和撤銷，資料庫只保存 SHA-256 雜湊，不保存原文權杖。手機解除配對只清除本機權杖；若手機遺失，務必在 Main 撤銷。

## 條碼與資料庫範例

掃完 3 組麥當勞條碼、停止並輸入名稱後，文字預覽是：

```text
【麥當勞】漢堡(好禮即享券)
MDN5955857100094
MDN5988938866230
MDN5959064503853
```

實際 SQLite 儲存為**三張** `tickets` 資料（同名、不同 `barcode_text`）。主站現有文字匯出會自動依名稱合併顯示。

7-11 範例：

```text
7-11商品卡#711
7100016003609284
3CXR4ME8
```

實際 SQLite 儲存為**一張** `tickets` 資料（`barcode_text=7100016003609284`、`barcode_text_2=3CXR4ME8`）。「不分類」沿用主站的 `brand_tag=其他`；自訂分類存在 `mobile_categories`，即使尚無票券也能再次選擇。

## 開發與建置

需求：Node.js 22.13+、Android SDK/API 36（Android 建置）、或 macOS Xcode 26.4+（iOS 建置）。

```bash
cd mobile
npm install
npm run check
npx expo start
# 或用原生 Android 建置
npx expo run:android
# macOS / Xcode 下可用同一份原始碼
npx expo run:ios
```

GitHub Actions 的 **Build KK Ticket Android APK** 工作流程會產生可單獨安裝、不需要 Metro 開發伺服器的 **debug 簽署 APK**。在 GitHub → Actions → 選取完成的建置 → Artifacts → `kk-ticket-android-debug-apk` 下載。Debug APK 僅供測試，正式發行請另設生產簽署與應用程式商店流程。

**限制**：此分支的程式碼已加入，但尚未在實際 Android/iPhone 相機完成硬體端測試。iOS 與 Android 共用程式碼，但 iOS .ipa 需要 macOS／Xcode 以及有效簽署環境；請先以 Android 實機驗證不同紙本與螢幕亮度條碼的辨識效果。
