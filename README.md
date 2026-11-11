# Ticket Server 票券管理

FastAPI、SQLite 與手機版網頁。保留票券新增、圖片、雙條碼、狀態切換、搜尋、匯入、操作紀錄及 Discord 到期提醒。

## 安裝與啟動

需要 Python 3.11 以上。

```bash
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows：.venv\Scripts\activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
```

在 `config.yaml` 設定登入帳密及獨立的 `auth.secret_key`，再執行：

```bash
python app.py
```

範例連接埠為 `7004`。Discord 提醒為選用，在本機設定檔填入 Bot Token 與頻道 ID 即可。`TICKET_CONFIG` 環境變數可指定其他設定檔位置。

儲存庫只有程式與設定範例，不包含實際帳密、Token、資料庫、票券圖片或備份，並以 `.gitignore` 排除這些資料。

## 分享、QR Code 與到期

登入後至設定頁，在「分享票券」輸入名稱及有效期限，建立讀取 Token。頁面會顯示可列印的 QR Code、分享網址與 Token 複製框。完整 Token 只在建立時回傳，資料庫僅儲存其雜湊。

分享網址直接回傳精簡 JSON，供機器讀取，不載入展示頁、條碼圖片或重複分組。原始圖片票券仍攜帶原圖，以保持同步完整。Token 到期或撤銷後無法讀取；Token 無法直接修改票券或管理設定。Main 明確開啟輔助上傳後，Token 可送出待審申請，仍須帳密登入接受才會成為正式票券。

分享網址格式為 `https://你的網址/share?token=讀取憑證`。服務在存取日誌前移除這個查詢參數；回應禁止快取及轉送 Referer。同步設定會加密保存憑證，之後以 Authorization header 呼叫 API。舊的 fragment 分享網址仍可作為同步來源輸入。支援 HTTP API 的 App 可使用：

```http
GET /api/v1/tickets
GET /api/v1/snapshot
GET /api/sharing/export?format=txt
Authorization: Bearer <讀取憑證>
```

Token 的建立與撤銷需要原本的帳密登入。

## 文字匯出

登入後的設定頁提供可複製的文字框。相同名稱的票券集中顯示，每張票券的第一、第二條碼各佔一行；不同名稱之間空一行：

```text
必勝客10元
第一張條碼1
第一張條碼2
第二張條碼1
第二張條碼2

統一超商
條碼1
條碼2
```

JSON／ZIP 保留每張票券的完整欄位、狀態與圖片；TXT 提供名稱及條碼。

## Main／輔助模式

新安裝及未設定角色的服務預設都是 Main。需要跟隨另一台 Main 時，在設定選擇「輔助」，貼上 Main 產生的完整分享網址，按「儲存模式」並確認。無須另外輸入 Token。也可在「使用帳號密碼同步」設定 Main 的登入帳密。

輔助模式每次開啟、重新整理、返回頁面或切回 App 都會向 Main 更新票券，不受背景更新間隔限制。背景亦可依設定間隔更新，或按「立即向 Main 更新」。Main 無回應、逾時、拒絕存取或傳回無效資料時，讀取本機保留票券並顯示狀態；不會因此清空資料。

成功取得有效快照時，本機票券完整跟隨 Main：Main 已刪除的票券會消失；Main 明確回傳有效空清單時，本機也會清空。輔助模式禁止本機編輯票券。切回 Main 可停止更新並保留當時資料。

每次實際替換前，系統會在資料庫旁的 `sync_backups/` 建立 SQLite 備份。來源無法連線、Token 到期、快照格式錯誤或寫入失敗時，保留原本票券。來源未變的週期同步不重複建立備份。設定保存的來源憑證會加密，操作紀錄不寫入完整分享網址的憑證。

舊版 client 設定不會自動開始新的整批替換，必須在設定頁重新確認啟用。

還原時先停止服務，再以對應 `sync_backups/before_mirror_*.db` 還原 `data/tickets.db`；同步不會刪除原有圖片檔。還原後重新啟動服務。

## 登入與輔助上傳

管理頁面、程式及文件頁均須先登入；登入頁僅有帳號、密碼及登入。瀏覽器使用 HttpOnly、SameSite=Strict Cookie 保護頁面，寫入 API 仍要求帳號 JWT，分享 Token 不會取得管理權限。登出會清除 Cookie 與本機登入憑證。

Main 設定內開啟「接受輔助上傳申請」，輔助設定開啟「啟用此輔助上傳」。輔助的新增／掃描表單改為送交 Main 審核，支援條碼及圖片。Main 在設定 → 輔助上傳 → 待審上傳中展開內容，接受或拒絕；接受只新增，重複主要條碼略過，不覆蓋既有票券。申請與草稿使用獨立資料表，整批同步不會抹除。離線時保留草稿，回到設定可重送；相同申請編號重送不會重複新增。

下方第二個「新增」使用原本設定中的 JSON／文字匯入介面，舊手動表單已移除。輔助可在此預覽後送交 Main 審核。抽屜按鈕自動換行，設定頁另有登出按鈕。

## 筆記與標題圖片

匯入的條碼文字包含 `http` 時，該標題下的連結及尾端代碼會保留成筆記，不繪製條碼，也不混入首頁票券分類。純文字筆記可在新增頁勾「作為筆記」。筆記分頁依標題分組，支援普通 HTTP(S) 網址及 Markdown 超連結，可編輯或刪除；文字以安全 DOM 顯示，不執行輸入的 HTML。

筆記標題及票券標題均可上傳、替換或移除標題圖片（PNG／JPEG／WebP，最多 5 MB）。同名標題共用圖片。筆記與圖片包含在 JSON／ZIP、分享快照與 Main／輔助同步內；舊資料庫啟動時自動加入欄位，既有 URL 條碼會轉入筆記。

## 免登入條碼頁

`/display` 固定白底，只顯示網址提供的資料，不存入資料庫、不讀取帳號票券或瀏覽器 Token。

單筆：`/display?name=名稱&barcode=1234567890`。

多筆：將以下 JSON 以 `URLSearchParams` 放入 `list` 參數，支援最多 100 筆，也可重複 `list` 參數。條碼使用 CODE128，每組最多 128 字。

```js
const list = [{name: '必勝客10元', barcodes: ['1234567890', 'ABC123']},
              {name: '統一超商', barcode: 'STORE001'}];
const url = '/display?' + new URLSearchParams({list: JSON.stringify(list)});
```

## 測試方式

API、到期／撤銷、權限、備份、同步取代與失敗回復：

```bash
python -m unittest discover -s tests -p 'test_*.py'
```

瀏覽器及 QR 解碼測試另需 Playwright、OpenCV、NumPy：

```bash
pip install playwright opencv-python-headless numpy
playwright install chromium
python tests/ui_sharing.py
```

測試使用暫存資料庫與模擬來源，不會接觸正式票券或傳送 Discord 訊息。
