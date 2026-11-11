"""Portable ticket snapshots and audited, read-only main/client synchronization.

Manual imports preserve rows. Explicit mirror synchronization replaces local tickets.
"""
from __future__ import annotations

import base64
from contextlib import closing
import csv
import hashlib
import io
import json
import logging
import math
import sqlite3
import threading
import time
import unicodedata
import uuid
import zipfile
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, parse_qs

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, Response as APIResponse
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, SecretStr, ValidationError
from sqlalchemy import Boolean, DateTime, Integer, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth import get_current_user
from app.config import ROOT, settings
from app.database import Base, SessionLocal, get_db
from app.models import Ticket, ReminderLog
from app.sharing import shared_reader
from app.schemas import TicketResponse
from app.services import log_activity, sort_key_ticket, ticket_to_dict

logger = logging.getLogger(__name__)
FORMAT = "ticket-server/v1"
MAX_BYTES = 32 * 1024 * 1024
MAX_ITEMS = 100000
UPLOADS = (ROOT / settings.paths.uploads).resolve()
pull_lock = threading.Lock()
router = APIRouter()


class ExchangeSettings(Base):
    __tablename__ = "exchange_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[str] = mapped_column(String(36), default=lambda: str(uuid.uuid4()))
    mode: Mapped[str] = mapped_column(String(16), default="main")
    upstream_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    upstream_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    interval_seconds: Mapped[int] = mapped_column(Integer, default=60)
    last_attempt: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_success: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_result: Mapped[str | None] = mapped_column(Text, nullable=True)


class TicketIdentity(Base):
    __tablename__ = "ticket_identities"
    ticket_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sync_uid: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid.uuid4()))


class AccessLog(Base):
    __tablename__ = "exchange_access_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    path: Mapped[str] = mapped_column(String(256))
    method: Mapped[str] = mapped_column(String(16))
    status_code: Mapped[int] = mapped_column(Integer)
    client_ip: Mapped[str] = mapped_column(String(128))
    user_agent: Mapped[str] = mapped_column(String(512))
    ticket_count: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class SyncLink(Base):
    __tablename__ = "exchange_links"
    __table_args__ = (UniqueConstraint("source_server", "remote_uid"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_server: Mapped[str] = mapped_column(String(36), index=True)
    remote_uid: Mapped[str] = mapped_column(String(36))
    ticket_id: Mapped[int] = mapped_column(Integer, index=True)
    remote_missing: Mapped[bool] = mapped_column(Boolean, default=False)


def runtime(db: Session) -> ExchangeSettings:
    item = db.get(ExchangeSettings, 1)
    if item is None:
        item = ExchangeSettings(id=1)
        db.add(item)
        db.commit()
        db.refresh(item)
    return item


def visible_query(db: Session):
    query = db.query(Ticket)
    if runtime(db).mode == "client":
        missing = select(SyncLink.ticket_id).where(SyncLink.remote_missing.is_(True))
        live = select(SyncLink.ticket_id).where(SyncLink.remote_missing.is_(False))
        query = query.filter(~Ticket.id.in_(missing) | Ticket.id.in_(live))
    return query


def protect_main(db: Session):
    if runtime(db).mode != "main":
        raise HTTPException(409, "輔助模式為唯讀，請在 Main 修改票券。")


class ExchangeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if request.method in ("POST", "PATCH", "PUT", "DELETE") and (
            path.startswith("/api/tickets") or path.startswith("/api/reminders")
        ):
            with SessionLocal() as db:
                if runtime(db).mode == "client":
                    return JSONResponse({"detail": "輔助模式為唯讀，請到 Main 修改。"}, 409)
        if not path.startswith("/api/v1/"):
            return await call_next(request)
        started = time.monotonic()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["Cache-Control"] = "no-store"
            return response
        finally:
            with SessionLocal() as db:
                db.add(AccessLog(
                    token_id=getattr(request.state, "exchange_token_id", None),
                    path=path[:256], method=request.method, status_code=status,
                    client_ip=(request.client.host if request.client else "unknown")[:128],
                    user_agent=request.headers.get("user-agent", "")[:512],
                    ticket_count=getattr(request.state, "exchange_ticket_count", 0),
                    duration_ms=int((time.monotonic() - started) * 1000),
                ))
                db.commit()


def amount_key(value):
    if value is None:
        return None
    number = Decimal(str(value))
    return "0" if number == 0 else format(number.normalize(), "f")


def group_key(item: dict) -> str:
    return json.dumps([
        unicodedata.normalize("NFC", item["name"]).strip(), amount_key(item.get("face_value")),
        item.get("insert_date"), item.get("expires_at"), bool(item.get("no_expiry")),
    ], ensure_ascii=False, separators=(",", ":"))


def group_tickets(items: list[dict]) -> list[dict]:
    buckets = {}
    for item in items:
        key = group_key(item)
        if key not in buckets:
            buckets[key] = {"group_key": key, "name": item["name"], "face_value": item.get("face_value"),
                            "insert_date": item.get("insert_date"), "expires_at": item.get("expires_at"), "tickets": []}
        buckets[key]["tickets"].append(item)
    return [group | {"count": len(group["tickets"]), "active_count": sum(t["local_state"] == 0 for t in group["tickets"])} for group in buckets.values()]


def ticket_items(db: Session) -> list[dict]:
    records = visible_query(db).all()
    records.sort(key=sort_key_ticket)
    identities = {item.ticket_id: item for item in db.query(TicketIdentity)}
    for ticket in records:
        if ticket.id not in identities:
            identities[ticket.id] = TicketIdentity(ticket_id=ticket.id)
            db.add(identities[ticket.id])
    db.commit()
    return [ticket_to_dict(ticket) | {"sync_uid": identities[ticket.id].sync_uid} for ticket in records]


def snapshot(db: Session, compact: bool = False) -> dict:
    state = runtime(db)
    items = ticket_items(db)
    attachments = {}
    size = 0
    for item in items:
        name = item.get("barcode_image")
        if not name or name in attachments:
            continue
        if Path(name).name != name:
            raise HTTPException(409, "票券圖片路徑不合法，請先修正圖片")
        image = UPLOADS / name
        if not image.is_file():
            raise HTTPException(409, "票券圖片遺失，無法產生完整匯出")
        size += image.stat().st_size
        if size > MAX_BYTES // 2:
            raise HTTPException(413, "圖片總量超過可攜式匯出的上限")
        attachments[name] = base64.b64encode(image.read_bytes()).decode()
    payload = {"schema": FORMAT, "server_id": state.server_id, "tickets": items, "attachments": attachments}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    if len(encoded) > MAX_BYTES:
        raise HTTPException(413, "票券快照超過大小上限")
    if compact:
        # TicketResponse fills nullable/default fields back in during synchronization.
        required = {key for key, field in TicketResponse.model_fields.items() if field.is_required()}
        payload['tickets'] = [{key: value for key, value in item.items() if value is not None or key in required}
                              for item in items]
        return payload
    return payload | {"revision": hashlib.sha256(encoded).hexdigest(), "generated_at": datetime.utcnow().isoformat() + "Z",
                      "ticket_count": len(items), "groups": group_tickets(items)}


@router.get("/api/v1/tickets")
def external_tickets(request: Request, response: APIResponse, grouped: bool = False, db: Session = Depends(get_db), _=Depends(shared_reader)):
    db.rollback()
    response.headers['X-Ticket-Sync'] = refresh_auxiliary_on_open()
    items = ticket_items(db)
    request.state.exchange_ticket_count = len(items)
    return {"groups": group_tickets(items), "ticket_count": len(items)} if grouped else items


@router.get("/api/v1/snapshot")
def external_snapshot(request: Request, db: Session = Depends(get_db), _=Depends(shared_reader)):
    db.rollback()
    sync_status = refresh_auxiliary_on_open()
    result = snapshot(db, compact=True)
    etag = '"' + hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest() + '"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-store", 'X-Ticket-Sync': sync_status})
    request.state.exchange_ticket_count = len(result['tickets'])
    return JSONResponse(result, headers={"ETag": etag, "Cache-Control": "no-store", 'X-Ticket-Sync': sync_status})


@router.get("/api/v1/uploads/{filename}")
def external_image(filename: str, db: Session = Depends(get_db), _=Depends(shared_reader)):
    if Path(filename).name != filename or not db.query(Ticket).filter_by(barcode_image=filename).first():
        raise HTTPException(404)
    path = UPLOADS / filename
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "no-store"})


@router.get("/api/exchange/export")
def export_tickets(format: Literal["json", "zip", "csv", "txt"] = "json", db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    db.rollback()
    sync_status = refresh_auxiliary_on_open()
    result = snapshot(db)
    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    if format == 'txt':
        content = ticket_text(result['tickets']).encode('utf-8')
        media = 'text/plain; charset=utf-8'
    elif format == "csv":
        output = io.StringIO(newline="")
        columns = ["sync_uid", "name", "face_value", "insert_date", "expires_at", "brand_tag", "barcode_text", "barcode_text_2", "local_state", "remaining_amount", "group_key"]
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        for item in result["tickets"]:
            row = {key: item.get(key) for key in columns}
            row["group_key"] = group_key(item)
            # Spreadsheet programs must not execute imported text as a formula.
            for key in columns:
                if isinstance(row[key], str) and row[key].lstrip().startswith(("=", "+", "-", "@")):
                    row[key] = "'" + row[key]
            writer.writerow(row)
        content = ("\ufeff" + output.getvalue()).encode()
        media = "text/csv; charset=utf-8"
    else:
        content = json.dumps(result, ensure_ascii=False, indent=2).encode()
        media = "application/json"
        if format == "zip":
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("ticket-server.json", content)
            content = output.getvalue()
            media = "application/zip"
    log_activity(db, "export", {"format": format, "tickets": result["ticket_count"], "revision": result["revision"]})
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="tickets_{stamp}.{format}"', "Cache-Control": "no-store", 'X-Ticket-Sync': sync_status})


def ticket_text(items):
    groups = {}
    for item in items:
        codes = groups.setdefault(item['name'], [])
        codes.extend(str(item[key]) for key in ['barcode_text', 'barcode_text_2'] if item.get(key))
    return '\n\n'.join('\n'.join([name, *codes]) for name, codes in groups.items())


@router.get('/api/sharing/export')
def shared_export(format: Literal['json', 'zip', 'csv', 'txt'] = 'txt', db: Session = Depends(get_db), _=Depends(shared_reader)):
    return export_tickets(format, db, 'shared-reader')


class SettingsPatch(BaseModel):
    mode: Literal["main", "client"]
    upstream_url: str | None = None
    upstream_username: str | None = None
    upstream_password: SecretStr | None = None
    confirm_replace: bool = False
    interval_seconds: int = Field(default=60, ge=30, le=86400)


def cipher() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.auth.secret_key.encode()).digest()))


def settings_info(item):
    last_result = json.loads(item.last_result) if item.last_result else None
    if last_result and 'created' not in last_result:
        last_result = None
    return {"mode": item.mode, "server_id": item.server_id, "upstream_url": item.upstream_url,
            "has_upstream_credentials": bool(upstream_credentials(item)), "interval_seconds": item.interval_seconds,
            "last_attempt": item.last_attempt, "last_success": item.last_success, "last_error": item.last_error,
            "last_result": last_result}


def upstream_credentials(item):
    if not item.upstream_secret:
        return {}
    try:
        value = json.loads(cipher().decrypt(item.upstream_secret.encode()).decode())
        if isinstance(value, dict) and (value.get('read_token') or (value.get('username') and value.get('password'))):
            return value
    except (InvalidToken, ValueError):
        pass
    return {}


@router.get("/api/exchange/settings")
def read_settings(db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    return settings_info(runtime(db))


@router.put("/api/exchange/settings")
def write_settings(body: SettingsPatch, db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    item = runtime(db)
    entered_url = (body.upstream_url or '').strip()
    parts = urlsplit(entered_url)
    query = parse_qs(parts.query)
    if entered_url and (parts.scheme not in ('https', 'http') or not parts.hostname or parts.username or parts.password or set(query) - {'token'}):
        raise HTTPException(422, '來源網址必須是 http(s) 分享網址')
    if parts.path.rstrip('/') not in ('', '/share', '/api/v1/snapshot'):
        raise HTTPException(422, '請貼上對方產生的分享網址')
    url = f'{parts.scheme}://{parts.netloc}' if entered_url else ''
    shared = query.get('token', parse_qs(parts.fragment).get('token', ['']))[0]
    if (parts.fragment or parts.query) and (not shared.startswith('tkt_') or len(shared) > 512):
        raise HTTPException(422, '分享網址缺少有效的讀取 Token')
    username = (body.upstream_username or '').strip()
    password = body.upstream_password.get_secret_value() if body.upstream_password else ''
    if bool(username) != bool(password):
        raise HTTPException(422, '請同時輸入 Main 帳號和密碼')
    supplied = {'read_token': shared} if shared else {'username': username, 'password': password} if username and password else {}
    if url and url != item.upstream_url and item.upstream_secret and not supplied:
        raise HTTPException(422, '來源已改變，請重新貼上完整分享網址')
    if body.mode == 'client' and (not url or not (supplied or upstream_credentials(item))):
        raise HTTPException(422, '請貼上包含讀取 Token 的完整分享網址')
    if body.mode == 'client' and not body.confirm_replace:
        raise HTTPException(422, '請確認以來源票券完整取代本機資料')
    item.mode = body.mode
    item.upstream_url = url or None
    item.interval_seconds = body.interval_seconds
    if supplied:
        item.upstream_secret = cipher().encrypt(json.dumps(supplied).encode()).decode()
    item.last_error = None
    item.last_result = json.dumps({'mirror_enabled': body.mode == 'client' and body.confirm_replace})
    db.commit()
    log_activity(db, "sync_settings", {"mode": item.mode, "upstream_url": item.upstream_url, "interval_seconds": item.interval_seconds})
    return settings_info(item)


def validate_snapshot(payload: dict):
    if not isinstance(payload, dict) or payload.get("schema") != FORMAT:
        raise HTTPException(422, "不支援的票券匯出格式")
    try:
        server_id = str(uuid.UUID(str(payload["server_id"])))
        rows = payload["tickets"]
        if not isinstance(rows, list) or len(rows) > MAX_ITEMS:
            raise ValueError("票券筆數不合法")
        if 'ticket_count' in payload and payload['ticket_count'] != len(rows):
            raise ValueError('來源票券筆數不一致')
        seen_uids, seen_codes = set(), set()
        validated = []
        for row in rows:
            uid = str(uuid.UUID(str(row["sync_uid"])))
            if uid in seen_uids:
                raise ValueError("同一快照不可有重複票券 UID")
            item = TicketResponse.model_validate(row).model_dump(mode="json")
            if not item["name"].strip() or len(item["name"]) > 512 or len(item["brand_tag"]) > 128:
                raise ValueError("票券名稱或標籤不合法")
            if item["local_state"] not in (0, 1, 2):
                raise ValueError("票券狀態不合法")
            for field in ("face_value", "remaining_amount"):
                value = item[field]
                if value is not None and (not math.isfinite(value) or value < 0):
                    raise ValueError("票券金額不合法")
            for field in ("barcode_text", "barcode_text_2"):
                if item[field] and len(item[field]) > 128:
                    raise ValueError("條碼長度超過上限")
            code = item["barcode_text"]
            if code and code in seen_codes:
                raise ValueError("同一快照不可有重複主要條碼")
            if code:
                seen_codes.add(code)
            seen_uids.add(uid)
            validated.append((uid, item))
        attachments = payload.get("attachments", {})
        if not isinstance(attachments, dict):
            raise ValueError("圖片格式不合法")
        images = {}
        size = 0
        for name, encoded in attachments.items():
            if not isinstance(name, str) or Path(name).name != name or "\\" in name or len(name) > 240:
                raise ValueError("圖片路徑不合法")
            content = base64.b64decode(encoded, validate=True)
            size += len(content)
            if len(content) > 10 * 1024 * 1024 or size > MAX_BYTES // 2:
                raise ValueError("圖片超過大小上限")
            images[name] = content
        if any(item["barcode_image"] and item["barcode_image"] not in images for _, item in validated):
            raise ValueError("快照缺少票券圖片，不進行部分匯入")
        return server_id, validated, images
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise HTTPException(422, "票券快照驗證失敗，未修改票券；請檢查資料欄位、UID、條碼及圖片。") from exc


TICKET_FIELDS = tuple(TicketResponse.model_fields)
COMPARE_FIELDS = ("name", "brand_tag", "barcode_text", "barcode_text_2", "insert_date", "expires_at", "no_expiry", "expiry_note", "face_value", "remaining_amount", "local_state", "hide_used")


def apply_snapshot(db: Session, payload: dict, mirror: bool = False):
    source_id, incoming, images = validate_snapshot(payload)
    if mirror and source_id == runtime(db).server_id:
        raise HTTPException(409, "不可從自己同步或匯入自己的快照")
    result = {"received": len(incoming), "created": 0, "updated": 0, "unchanged": 0, "conflicts": [], "archived_missing": 0, "deleted": 0}
    image_names = {}
    UPLOADS.mkdir(parents=True, exist_ok=True)
    for name, content in images.items():
        local_name = "sync_" + hashlib.sha256(content).hexdigest()[:20] + Path(name).suffix[:12]
        destination = UPLOADS / local_name
        if destination.exists():
            if destination.read_bytes() != content:
                raise HTTPException(409, "圖片檔案發生衝突，未覆寫原圖片")
        else:
            with destination.open("xb") as stream:
                stream.write(content)
        image_names[name] = local_name
    seen = set()
    for uid, item in incoming:
        seen.add(uid)
        link = db.query(SyncLink).filter_by(source_server=source_id, remote_uid=uid).first()
        ticket = db.get(Ticket, link.ticket_id) if link else None
        identity = db.query(TicketIdentity).filter_by(sync_uid=uid).first()
        if ticket is None and identity:
            ticket = db.get(Ticket, identity.ticket_id)
        if ticket is None and item["barcode_text"]:
            ticket = db.query(Ticket).filter_by(barcode_text=item["barcode_text"]).first()
        if ticket is not None and link is None:
            current = ticket_to_dict(ticket)
            if any(current.get(field) != item.get(field) for field in COMPARE_FIELDS):
                result["conflicts"].append({"remote_uid": uid, "local_id": ticket.id, "reason": "同身分或條碼已有不同資料，保留本機內容"})
                continue
        fields = {key: value for key, value in item.items() if key != "id"}
        for field in ("insert_date", "expires_at"):
            fields[field] = date.fromisoformat(fields[field]) if fields[field] else None
        for field in ("created_at", "updated_at", "used_at"):
            fields[field] = datetime.fromisoformat(fields[field].replace("Z", "+00:00")).replace(tzinfo=None) if fields[field] else None
        if fields["barcode_image"]:
            fields["barcode_image"] = image_names[fields["barcode_image"]]
        if ticket is None:
            ticket = Ticket(**fields)
            db.add(ticket)
            db.flush()
            if identity is None:
                db.add(TicketIdentity(ticket_id=ticket.id, sync_uid=uid))
            else:
                identity.ticket_id = ticket.id
            result["created"] += 1
        elif link:
            current = ticket_to_dict(ticket)
            comparable = {key: value.isoformat() if isinstance(value, (datetime, date)) else value for key, value in fields.items()}
            if any(current.get(key) != value for key, value in comparable.items()):
                for key, value in fields.items():
                    setattr(ticket, key, value)
                result["updated"] += 1
            else:
                result["unchanged"] += 1
        else:
            result["unchanged"] += 1
        if link is None:
            link = SyncLink(source_server=source_id, remote_uid=uid, ticket_id=ticket.id)
            db.add(link)
        else:
            link.ticket_id = ticket.id
        link.remote_missing = False
    if mirror:
        for link in db.query(SyncLink).filter_by(source_server=source_id):
            if link.remote_uid not in seen:
                link.remote_missing = True
                result["archived_missing"] += 1
    db.commit()
    return result


def replace_snapshot(db: Session, payload: dict):
    source_id, incoming, images = validate_snapshot(payload)
    if source_id == runtime(db).server_id:
        raise HTTPException(409, '不可從自己強制同步')
    ids = [item['id'] for _, item in incoming]
    if len(ids) != len(set(ids)) or any(item <= 0 for item in ids):
        raise HTTPException(422, '來源票券 ID 不合法；本機票券未變更')
    image_names = {}
    UPLOADS.mkdir(parents=True, exist_ok=True)
    for name, content in images.items():
        local_name = 'sync_' + hashlib.sha256(content).hexdigest()[:20] + Path(name).suffix[:12]
        destination = UPLOADS / local_name
        if destination.exists():
            if destination.read_bytes() != content:
                raise HTTPException(409, '圖片衝突；本機票券未變更')
        else:
            with destination.open('xb') as stream:
                stream.write(content)
        image_names[name] = local_name
    database_path = db.get_bind().url.database
    if not database_path or database_path == ':memory:':
        raise HTTPException(409, '強制同步需要可備份的 SQLite 資料庫')
    backup_dir = Path(database_path).resolve().parent / 'sync_backups'
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    backup_path = backup_dir / ('before_mirror_' + datetime.utcnow().strftime('%Y%m%d_%H%M%S_') + uuid.uuid4().hex[:8] + '.db')
    with closing(sqlite3.connect(database_path)) as source, closing(sqlite3.connect(backup_path)) as destination:
        source.backup(destination)
    backup_path.chmod(0o600)
    previous_count = db.query(Ticket).count()
    try:
        db.query(SyncLink).delete(synchronize_session=False)
        db.query(TicketIdentity).delete(synchronize_session=False)
        db.query(ReminderLog).delete(synchronize_session=False)
        db.query(Ticket).delete(synchronize_session=False)
        for uid, item in incoming:
            fields = dict(item)
            for field in ['insert_date', 'expires_at']:
                fields[field] = date.fromisoformat(fields[field]) if fields[field] else None
            for field in ['created_at', 'updated_at', 'used_at']:
                fields[field] = datetime.fromisoformat(fields[field].replace('Z', '+00:00')).replace(tzinfo=None) if fields[field] else None
            if fields['barcode_image']:
                fields['barcode_image'] = image_names[fields['barcode_image']]
            db.add(Ticket(**fields))
            db.add(TicketIdentity(ticket_id=fields['id'], sync_uid=uid))
            db.add(SyncLink(source_server=source_id, remote_uid=uid, ticket_id=fields['id']))
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return {'received': len(incoming), 'created': len(incoming), 'updated': 0,
            'unchanged': 0, 'deleted': previous_count, 'conflicts': [], 'backup': backup_path.name}


@router.post("/api/exchange/import")
def import_snapshot(payload: dict, db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    protect_main(db)
    result = apply_snapshot(db, payload)
    log_activity(db, "snapshot_import", result)
    return result


@router.post("/api/exchange/import-file")
async def import_file(file: UploadFile = File(...), db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    protect_main(db)
    content = await file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise HTTPException(413, "匯入檔案過大")
    try:
        if (file.filename or "").lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if archive.namelist() != ["ticket-server.json"] or archive.getinfo("ticket-server.json").file_size > MAX_BYTES:
                    raise ValueError("請選擇由票券伺服器匯出的 ZIP")
                content = archive.read("ticket-server.json")
        payload = json.loads(content)
    except (ValueError, KeyError, zipfile.BadZipFile) as exc:
        raise HTTPException(422, "匯入檔案格式不正確") from exc
    result = apply_snapshot(db, payload)
    log_activity(db, "snapshot_import", result)
    return result


def pull_once(force=False, on_open=False):
    acquired = pull_lock.acquire(timeout=10) if on_open else pull_lock.acquire(blocking=False)
    if not acquired:
        raise HTTPException(409, "已有同步工作進行中")
    try:
        with SessionLocal() as db:
            state = runtime(db)
            if state.mode != "client":
                if force:
                    raise HTTPException(409, "只有輔助模式可以向 Main 更新")
                return {"skipped": True}
            previous = json.loads(state.last_result) if state.last_result else {}
            if not previous.get('mirror_enabled'):
                if force:
                    raise HTTPException(409, '請先在設定頁確認啟用強制同步；本機票券未變更')
                return {'skipped': True}
            if not force and not on_open and state.last_attempt and (datetime.utcnow() - state.last_attempt).total_seconds() < state.interval_seconds:
                return {"skipped": True}
            state.last_attempt = datetime.utcnow()
            db.commit()
            try:
                credentials = upstream_credentials(state)
                if not credentials:
                    raise ValueError('請重新設定 Main server 帳號密碼')
                url = (state.upstream_url or "") + "/api/v1/snapshot"
                timeout = httpx.Timeout(5, connect=3) if on_open else httpx.Timeout(30, connect=10)
                with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                    raw_token = credentials.get('read_token')
                    if not raw_token:
                        login = client.post((state.upstream_url or '') + '/api/auth/login', json=credentials)
                        if login.status_code != 200:
                            raise ValueError(f'Main server 登入失敗 HTTP {login.status_code}')
                        raw_token = login.json().get('access_token')
                    if not isinstance(raw_token, str) or not raw_token:
                        raise ValueError('Main server 登入回應無效')
                    with client.stream("GET", url, headers={"Authorization": "Bearer " + raw_token}) as response:
                        if response.status_code != 200:
                            raise ValueError(f"Main server 回應 HTTP {response.status_code}")
                        chunks = bytearray()
                        for chunk in response.iter_bytes():
                            chunks.extend(chunk)
                            if len(chunks) > MAX_BYTES:
                                raise ValueError("Main server 快照過大")
                payload = json.loads(chunks)
                if not isinstance(payload, dict):
                    raise ValueError('來源不是有效的票券快照；本機票券未變更')
                validate_snapshot(payload)
                signature = hashlib.sha256(json.dumps({key: payload.get(key) for key in ['schema', 'server_id', 'tickets', 'attachments']}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                if not force and previous.get('source_revision') == signature:
                    result = {**previous, 'unchanged': len(payload.get('tickets', []))}
                else:
                    result = replace_snapshot(db, payload)
                result['source_revision'] = signature
                result['mirror_enabled'] = True
                state = runtime(db)
                state.last_success = datetime.utcnow()
                state.last_error = None
                state.last_result = json.dumps(result, ensure_ascii=False)
                db.commit()
                log_activity(db, "sync_pull", result)
                return result
            except (httpx.HTTPError, ValueError, InvalidToken, HTTPException, SQLAlchemyError, OSError) as exc:
                db.rollback()
                state = runtime(db)
                # Do not persist URLs, headers, response bodies or credentials in errors.
                state.last_error = str(exc.detail)[:200] if isinstance(exc, HTTPException) else str(exc)[:200] if isinstance(exc, ValueError) else "同步連線或登入失敗，請檢查 main server 與帳號密碼"
                db.commit()
                log_activity(db, "sync_error", state.last_error)
                raise HTTPException(502, state.last_error) from exc
    finally:
        pull_lock.release()


def refresh_auxiliary_on_open():
    with SessionLocal() as db:
        state = runtime(db)
        if state.mode != 'client':
            return 'main'
        previous = json.loads(state.last_result) if state.last_result else {}
        if not previous.get('mirror_enabled'):
            return 'cached'
    try:
        result = pull_once(on_open=True)
        return 'cached' if result.get('skipped') else 'updated'
    except Exception:
        logger.warning('Main unavailable during auxiliary open; serving retained local tickets')
        return 'cached'


def pull_due():
    try:
        pull_once()
    except Exception:
        logger.warning("Scheduled ticket synchronization did not complete; see sync status")


@router.post("/api/exchange/pull")
def pull_now(_: str = Depends(get_current_user)):
    return pull_once(force=True)
