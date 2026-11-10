"""Mobile companion endpoints. The phone is always an auxiliary client.

Read/write operations target the existing Main SQLite database. A separate
device credential is required, never the web admin password or share token.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import exchange, import_service
from app.config import ROOT, settings
from app.database import get_db
from app.mobile_auth import MobileCategory, MobileDevice, require_device
from app.models import ActivityLog, Ticket
from app.schemas import StatePatch, TicketCreate, TicketUpdate
from app.services import log_activity, sort_key_ticket, ticket_to_dict

router = APIRouter(prefix="/api/mobile", tags=["mobile"])
SEVEN_NAME = re.compile(r"7\s*[-－]\s*11\s*商品卡|#711", re.I)
SEVEN_PRIMARY = re.compile(r"^7100\d{12}$")
SEVEN_SECONDARY = re.compile(r"^(?=.*[a-zA-Z])[a-zA-Z0-9]{8}$")
MAX_CODES = 300


class ScanBatch(BaseModel):
    title: str = Field(min_length=1, max_length=512)
    category: str | None = Field(default=None, max_length=128)
    codes: list[str] = Field(min_length=1, max_length=MAX_CODES)
    force_seven_eleven: bool = False

    @field_validator("title")
    @classmethod
    def clean_title(cls, value):
        if not value.strip():
            raise ValueError("請輸入票券名稱")
        return value.strip()


class CategoryRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)


def unique_codes(raw: list[str]) -> list[str]:
    result, seen = [], set()
    for item in raw:
        value = item.strip()
        if not value or len(value) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise HTTPException(422, "條碼必須是 1～128 字元且不可包含換行或控制字元")
        if value not in seen:
            result.append(value)
            seen.add(value)
    return result


def is_seven_pair(a: str, b: str) -> bool:
    return (
        bool(SEVEN_PRIMARY.fullmatch(a)) and bool(SEVEN_SECONDARY.fullmatch(b))
    ) or (
        bool(SEVEN_PRIMARY.fullmatch(b)) and bool(SEVEN_SECONDARY.fullmatch(a))
    )


def pair_codes(title: str, raw: list[str], force=False) -> tuple[list[tuple[str, str | None]], bool]:
    codes = unique_codes(raw)
    explicit = force or bool(SEVEN_NAME.search(title))
    recognized = len(codes) % 2 == 0 and all(
        is_seven_pair(codes[i], codes[i + 1]) for i in range(0, len(codes), 2)
    )
    if explicit or recognized:
        if not recognized:
            raise HTTPException(422, "7-11 商品卡需依序掃兩個條碼：7100 開頭的 16 位主碼和含字母的 8 位副碼。可在儲存前調整順序。")
        paired = []
        for i in range(0, len(codes), 2):
            a, b = codes[i:i + 2]
            paired.append((a, b) if SEVEN_PRIMARY.fullmatch(a) else (b, a))
        return paired, True
    return [(code, None) for code in codes], False


def _existing_code(db: Session, *codes: str | None) -> Ticket | None:
    values = [code for code in codes if code]
    if not values:
        return None
    return db.query(Ticket).filter(
        or_(Ticket.barcode_text.in_(values), Ticket.barcode_text_2.in_(values))
    ).first()


@router.get("/tickets")
def get_tickets(db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    tickets = exchange.visible_query(db).all()
    tickets.sort(key=sort_key_ticket)
    return [ticket_to_dict(ticket) for ticket in tickets]


@router.get("/categories")
def categories(db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    configured = {c.name for c in db.query(MobileCategory)}
    existing = {str(row[0]).strip() for row in db.query(Ticket.brand_tag).distinct() if row[0]}
    return sorted((configured | existing) - {"", "其他"}, key=str.casefold)


@router.post("/categories", status_code=201)
def create_category(body: CategoryRequest, db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    exchange.protect_main(db)
    name = body.name.strip()
    if not name or name == "其他":
        raise HTTPException(422, "請輸入其他分類名稱")
    if db.query(MobileCategory).filter_by(name=name).first() is None:
        db.add(MobileCategory(name=name))
        db.commit()
    return {"name": name}


@router.post("/tickets/scan", status_code=201)
def import_scan(body: ScanBatch, db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    """Atomic session import. One ticket per code, or one ticket per #711 pair."""
    exchange.protect_main(db)
    pairs, dual = pair_codes(body.title, body.codes, body.force_seven_eleven)
    tag = (body.category or "").strip() or "其他"
    if tag != "其他" and db.query(MobileCategory).filter_by(name=tag).first() is None:
        db.add(MobileCategory(name=tag))
    created, duplicates = [], []
    for primary, secondary in pairs:
        if _existing_code(db, primary, secondary):
            duplicates.append(primary)
            continue
        fields = import_service.text_row_to_ticket_fields(body.title, primary, secondary)
        fields["brand_tag"] = tag
        fields["source"] = "mobile_scan"
        item = Ticket(**fields)
        db.add(item)
        db.flush()  # also catches a duplicate inside this transaction
        created.append(ticket_to_dict(item))
    db.commit()
    if created:
        log_activity(db, "mobile_scan", {
            "name": body.title, "category": tag, "created": len(created),
            "duplicates": len(duplicates), "double_barcode": dual,
        })
    return {"created": len(created), "duplicates": len(duplicates),
            "duplicate_codes": duplicates, "double_barcode": dual, "items": created}


@router.post("/tickets", status_code=201)
def create_ticket(body: TicketCreate, db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    exchange.protect_main(db)
    if not body.name.strip() or not (body.barcode_text or body.barcode_text_2):
        raise HTTPException(422, "名稱和條碼必填")
    if _existing_code(db, body.barcode_text, body.barcode_text_2):
        raise HTTPException(409, "條碼已存在")
    fields = body.model_dump()
    fields["name"] = fields["name"].strip()
    fields["source"] = "mobile_manual"
    ticket = Ticket(**fields)
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    log_activity(db, "save", "手機新增 " + ticket.name, ticket.id)
    return ticket_to_dict(ticket)


@router.patch("/tickets/{ticket_id}")
def update_ticket(ticket_id: int, body: TicketUpdate, db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    exchange.protect_main(db)
    ticket = db.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(404, "找不到票券")
    changes = body.model_dump(exclude_unset=True)
    if "name" in changes and not (changes["name"] or "").strip():
        raise HTTPException(422, "名稱不得為空")
    for key in ("barcode_text", "barcode_text_2"):
        if changes.get(key):
            found = _existing_code(db, changes[key])
            if found and found.id != ticket_id:
                raise HTTPException(409, "條碼已存在")
    for name, value in changes.items():
        setattr(ticket, name, value)
    ticket.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(ticket)
    log_activity(db, "update", {"ticket_id": ticket_id, "keys": list(changes)})
    return ticket_to_dict(ticket)


@router.patch("/tickets/{ticket_id}/state")
def update_state(ticket_id: int, body: StatePatch, db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    exchange.protect_main(db)
    if body.local_state not in (0, 1, 2):
        raise HTTPException(422, "狀態須為 0、1 或 2")
    ticket = db.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(404, "找不到票券")
    ticket.local_state = body.local_state
    ticket.used_at = datetime.utcnow() if body.local_state else None
    ticket.remaining_amount = body.remaining_amount if body.local_state == 2 else None
    ticket.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(ticket)
    log_activity(db, "state", {"ticket_id": ticket_id, "state": body.local_state})
    return ticket_to_dict(ticket)


@router.post("/tickets/delete-used")
def delete_used(db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    exchange.protect_main(db)
    targets = db.query(Ticket).filter(Ticket.local_state == 1).all()
    for ticket in targets:
        db.delete(ticket)
    db.commit()
    if targets:
        log_activity(db, "delete_used", {"count": len(targets), "via": "mobile"})
    return {"deleted": len(targets)}


@router.get("/logs")
def get_logs(db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    logs = db.query(ActivityLog).order_by(ActivityLog.created_at.desc()).limit(100).all()
    return [{"id": row.id, "action": row.action, "detail": row.detail,
             "created_at": row.created_at.isoformat() + "Z"} for row in logs]


@router.get("/uploads/{filename}")
def get_image(filename: str, db: Session = Depends(get_db), _dev: MobileDevice = Depends(require_device)):
    if Path(filename).name != filename or db.query(Ticket).filter_by(barcode_image=filename).first() is None:
        raise HTTPException(404, "找不到圖片")
    base = (ROOT / settings.paths.uploads).resolve()
    path = (base / filename).resolve()
    if not path.is_relative_to(base) or not path.is_file():
        raise HTTPException(404, "找不到圖片")
    return FileResponse(path)


@router.post("/tickets/{ticket_id}/image")
async def upload_image(ticket_id: int, file: UploadFile = File(...), db: Session = Depends(get_db),
                       _dev: MobileDevice = Depends(require_device)):
    exchange.protect_main(db)
    ticket = db.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(404, "找不到票券")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(422, "圖片格式僅支援 JPG、PNG 或 WebP")
    data = await file.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "圖片不得超過 5MB")
    folder = (ROOT / settings.paths.uploads).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    name = str(ticket.id) + "_" + uuid.uuid4().hex + ext
    (folder / name).write_bytes(data)
    ticket.barcode_image = name
    ticket.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(ticket)
    return ticket_to_dict(ticket)
