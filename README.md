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

手機掃描 QR Code 可開啟唯讀票券頁，查看條碼、複製文字，並匯出 TXT、JSON 或 ZIP。Token 到期或撤銷後，新讀取與匯出請求會被拒絕；Token 無法新增、修改或刪除票券，也無法管理設定。

分享網址格式為 `https://你的網址/share#token=讀取憑證`。憑證放在 URL fragment，由頁面透過 Authorization header 使用，不放入一般請求網址。支援 HTTP API 的 App 可使用：

```http
GET /api/v1/tickets
GET /api/v1/snapshot
GET /api/sharing/export?format=txt
Authorization: Bearer <讀取憑證>
```

Token 的建立與撤銷需要原本的帳密登入。

## 文字匯出

設定頁及分享頁均有可複製的文字框。相同名稱的票券集中顯示，每張票券的第一、第二條碼各佔一行；不同名稱之間空一行：

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

## 強制同步

在同步設定選擇「強制同步來源」，貼上對方產生的完整分享網址，按「保存並同步」並確認。無須另外輸入 Token。也可在「使用帳號密碼同步」設定來源站的登入帳密。

成功時，本機原有票券會被完整取代：來源已刪除的票券會消失，來源為空清單時本機也會清空。同步模式禁止本機編輯票券；可依間隔自動同步，或按「立即強制同步」。切回「本機管理」可停止同步並保留當時資料。

每次實際替換前，系統會在資料庫旁的 `sync_backups/` 建立 SQLite 備份。來源無法連線、Token 到期、快照格式錯誤或寫入失敗時，保留原本票券。來源未變的週期同步不重複建立備份。設定保存的來源憑證會加密，操作紀錄不寫入完整分享網址的 fragment。

舊版 client 設定不會自動開始新的整批替換，必須在設定頁重新確認啟用。

還原時先停止服務，再以對應 `sync_backups/before_mirror_*.db` 還原 `data/tickets.db`；同步不會刪除原有圖片檔。還原後重新啟動服務。

## 測試

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
