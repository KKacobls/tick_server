# 票券管理系統

前後端一體：後端 FastAPI + SQLite，前端靜態頁（RWD、條碼、三態點擊、小鍵盤、JSON/手動匯入、搜尋、操作紀錄）。

## 安裝

```bash
cd ticker_server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## 設定（必讀）

1. 複製 `config.example.yaml` 為 `config.yaml`（若尚未存在）。
2. 編輯 **`config.yaml`**：
   - `auth.username` / `auth.password`：登入帳密（明文存於設定檔，請勿提交 git）。
   - `auth.secret_key`：JWT 簽章，正式環境請改掉。
   - `discord.token`：Discord Bot Token；留空則不發提醒。
   - `discord.channel_id`：頻道 ID。
   - `import_defaults.expiry_months`：無 API 期限時，以 `insertDate + N 月` 為預設期限（預設 3）。

## 啟動

```bash
python run.py
```

瀏覽器開啟：`http://localhost:8766`

## 功能摘要

| 功能 | 說明 |
|------|------|
| JSON 匯入 | 略過已兌換；匯入後可編輯表修改名稱、標籤、期限、面額 |
| 手動新增 | 名稱 + 條碼文字 或 圖片（檔案 / Ctrl+V） |
| 列表排序 | 依期限/新增日；已使用排最下（重新載入時） |
| 點擊狀態 | 正常 → 已使用 → 部分剩餘（小鍵盤）→ 正常；每次同步後端 |
| 穩定順序 | 點擊改狀態**不會**重排列表，方便改金額 |
| 提醒 | 有 `expires_at`：到期前 30/14/7/1 天各發一次 DC；無期限：每日摘要種類與張數 |

## 資料欄位（簡化）

- `name` 名稱
- `barcode_text` / `barcode_image` 文字條碼或圖片
- `insert_date` / `expires_at` 日期
- `face_value` / `remaining_amount` 面額與剩餘
- `brand_tag` 大標籤（JSON 自動抽【】，否則「其他」）
- `local_state` 0/1/2
