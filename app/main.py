from __future__ import annotations

import logging
import shutil
import uuid
from datetime import date, datetime
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import import_service
from app import exchange
from app import sharing
from app.auth import create_access_token, get_current_user, verify_password
from app.config import ROOT, settings
from app.database import Base, SessionLocal, engine, get_db
from app.models import ActivityLog, Ticket
from app.reminder import run_reminders
from app.schemas import (
    JsonImportCommitRequest,
    JsonImportRequest,
    LoginRequest,
    LogResponse,
    StatePatch,
    TextImportRequest,
    TicketCreate,
    TicketResponse,
    TicketUpdate,
    TokenResponse,
)
from app.services import log_activity, sort_key_ticket, ticket_to_dict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

UPLOAD_ROOT = (ROOT / settings.paths.uploads).resolve()
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Ticket Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class NoCacheForStatic(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path in ("/", "/share") or path.startswith("/js/") or path.startswith("/css/") or path.startswith('/api/sharing'):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
        if path == "/":
            response.headers["Content-Security-Policy"] = "frame-src 'none'; object-src 'none'; base-uri 'self'"
        return response


app.add_middleware(NoCacheForStatic)
app.add_middleware(exchange.ExchangeMiddleware)
app.include_router(exchange.router)
app.include_router(sharing.router)


def _migrate_add_missing_columns():
    with engine.connect() as conn:
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(tickets)"))}
        if "barcode_text_2" not in cols:
            conn.execute(text("ALTER TABLE tickets ADD COLUMN barcode_text_2 VARCHAR(128)"))
            conn.commit()


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    _migrate_add_missing_columns()
    with SessionLocal() as db:
        exchange.runtime(db)
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        _job_reminders,
        "cron",
        hour=settings.reminder.run_hour,
        minute=settings.reminder.run_minute,
        id="daily_reminders",
    )
    scheduler.start()
    scheduler.add_job(exchange.pull_due, "interval", seconds=15, id="ticket_sync", max_instances=1)
    app.state.scheduler = scheduler


@app.on_event("shutdown")
def on_shutdown():
    scheduler = getattr(app.state, "scheduler", None)
    if scheduler and scheduler.running:
        scheduler.shutdown(wait=False)


def _job_reminders():
    db = SessionLocal()
    try:
        if exchange.runtime(db).mode == "main":
            run_reminders(db)
    finally:
        db.close()


@app.post("/api/auth/login", response_model=TokenResponse)
def login(body: LoginRequest):
    if body.username != settings.auth.username or not verify_password(
        body.password, settings.auth.password
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return TokenResponse(access_token=create_access_token(body.username))


@app.get("/api/tickets", response_model=list[TicketResponse])
def list_tickets(
    q: str | None = Query(None, description="search name/brand/barcode"),
    include_hidden_used: bool = Query(True),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    query = exchange.visible_query(db)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (Ticket.name.ilike(like))
            | (Ticket.brand_tag.ilike(like))
            | (Ticket.barcode_text.ilike(like))
            | (Ticket.barcode_text_2.ilike(like))
        )
    items = query.all()
    items.sort(key=sort_key_ticket)
    if not include_hidden_used:
        items = [t for t in items if not (t.hide_used and t.local_state in (1, 2))]
    return items


@app.post("/api/tickets", response_model=TicketResponse)
def create_ticket(
    body: TicketCreate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    if body.barcode_text:
        dup = db.query(Ticket).filter(Ticket.barcode_text == body.barcode_text).first()
        if dup:
            raise HTTPException(status_code=409, detail="Barcode already exists")
    t = Ticket(**body.model_dump())
    db.add(t)
    db.commit()
    db.refresh(t)
    log_activity(db, "save", f"存入 {t.name}", t.id)
    return t


@app.patch("/api/tickets/{ticket_id}", response_model=TicketResponse)
def update_ticket(
    ticket_id: int,
    body: TicketUpdate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Not found")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(t, k, v)
    t.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(t)
    log_activity(db, "update", data, t.id)
    return t


@app.patch("/api/tickets/{ticket_id}/state", response_model=TicketResponse)
def patch_state(
    ticket_id: int,
    body: StatePatch,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Not found")
    if body.local_state not in (0, 1, 2):
        raise HTTPException(status_code=400, detail="local_state must be 0|1|2")
    prev_state = t.local_state
    t.local_state = body.local_state
    if body.local_state == 0:
        t.used_at = None
        t.remaining_amount = None
    elif body.local_state == 1:
        t.used_at = datetime.utcnow()
        t.remaining_amount = None
    else:
        t.used_at = datetime.utcnow()
        if body.remaining_amount is not None:
            t.remaining_amount = body.remaining_amount
    t.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(t)
    log_activity(
        db,
        "state",
        {
            "id": t.id,
            "name": t.name,
            "barcode": t.barcode_text,
            "from": prev_state,
            "to": body.local_state,
            "remaining": t.remaining_amount,
        },
        t.id,
    )
    return t


def _build_import_preview(db: Session, rows: list, field_fn) -> dict:
    preview_items: list[dict] = []
    skipped = 0
    for idx, row in enumerate(rows):
        fields = field_fn(row) if not isinstance(row, tuple) else field_fn(*row)
        if not fields:
            preview_items.append(
                {
                    "temp_id": idx,
                    "status": "skipped",
                    "reason": "invalid_or_used",
                    "ticket": None,
                    "existing_ticket": None,
                }
            )
            skipped += 1
            continue
        bc = fields.get("barcode_text")
        existing = None
        if bc:
            existing = db.query(Ticket).filter(Ticket.barcode_text == bc).first()
        if existing:
            preview_items.append(
                {
                    "temp_id": idx,
                    "status": "duplicate",
                    "reason": "barcode_exists",
                    "ticket": fields,
                    "existing_ticket": ticket_to_dict(existing),
                }
            )
            continue
        preview_items.append(
            {
                "temp_id": idx,
                "status": "new",
                "reason": "",
                "ticket": fields,
                "existing_ticket": None,
            }
        )
    return {
        "summary": {
            "total": len(rows),
            "new": sum(1 for x in preview_items if x["status"] == "new"),
            "duplicate": sum(1 for x in preview_items if x["status"] == "duplicate"),
            "skipped": skipped,
        },
        "items": preview_items,
    }


@app.post("/api/tickets/import-json")
def import_json_preview(
    body: JsonImportRequest,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    rows = import_service.normalize_import_payload(body.payload)
    return _build_import_preview(db, rows, import_service.row_to_ticket_fields)


@app.post("/api/tickets/import-text")
def import_text_preview(
    body: TextImportRequest,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    pairs = import_service.parse_text_import(body.text)
    if not pairs:
        raise HTTPException(status_code=400, detail="無法解析文字格式")
    return _build_import_preview(db, pairs, import_service.text_row_to_ticket_fields)


@app.post("/api/tickets/import-json-commit")
def import_json_commit(
    body: JsonImportCommitRequest,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    created, duplicates = 0, 0
    created_items: list[dict] = []
    duplicate_items: list[dict] = []
    for item in body.items:
        payload = item.model_dump()
        bc = payload.get("barcode_text")
        if bc:
            existing = db.query(Ticket).filter(Ticket.barcode_text == bc).first()
            if existing:
                duplicates += 1
                duplicate_items.append(ticket_to_dict(existing))
                continue
        t = Ticket(**payload, source=payload.get("source") or "json_import")
        db.add(t)
        db.flush()
        created_items.append(ticket_to_dict(t))
        log_activity(db, "save", f"存入 {t.name}", t.id)
        created += 1
    db.commit()
    log_activity(
        db,
        "import_json_commit",
        {
            "created": created,
            "duplicates": duplicates,
            "items": [{"id": x["id"], "name": x["name"], "barcode": x["barcode_text"]} for x in created_items],
            "existing_items": [{"id": x["id"], "name": x["name"], "barcode": x["barcode_text"]} for x in duplicate_items],
        },
    )
    return {
        "created": created,
        "duplicates": duplicates,
        "items": created_items,
        "existing_items": duplicate_items,
    }


@app.post("/api/tickets/{ticket_id}/image", response_model=TicketResponse)
async def upload_image(
    ticket_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    t = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Not found")
    ext = Path(file.filename or "img.png").suffix or ".png"
    name = f"{ticket_id}_{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_ROOT / name
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    t.barcode_image = name
    t.source = "manual_image" if not t.barcode_text else t.source
    t.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(t)
    log_activity(db, "upload_image", {"file": name}, t.id)
    return t


@app.post("/api/tickets/with-image", response_model=TicketResponse)
async def create_with_image(
    name: str = Query(...),
    brand_tag: str = Query("其他"),
    insert_date: date | None = Query(None),
    expires_at: date | None = Query(None),
    face_value: float | None = Query(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    t = Ticket(
        name=name,
        brand_tag=brand_tag,
        insert_date=insert_date,
        expires_at=expires_at,
        face_value=face_value,
        no_expiry=expires_at is None and insert_date is None,
        source="manual_image",
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    dest = UPLOAD_ROOT / f"{t.id}_{uuid.uuid4().hex}.png"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    t.barcode_image = dest.name
    db.commit()
    db.refresh(t)
    log_activity(db, "save", f"存入 {t.name}", t.id)
    return t


@app.get("/api/uploads/{filename}")
def get_upload(
    filename: str,
    _: str = Depends(get_current_user),
):
    path = UPLOAD_ROOT / filename
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path)


@app.get("/api/logs", response_model=list[LogResponse])
def get_logs(
    limit: int = Query(100, le=500),
    q: str | None = Query(None, description="搜尋 detail / action"),
    action: str | None = Query(None, description="篩選動作類型"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    query = db.query(ActivityLog)
    if action:
        query = query.filter(ActivityLog.action == action)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (ActivityLog.detail.ilike(like)) | (ActivityLog.action.ilike(like))
        )
    return query.order_by(ActivityLog.created_at.desc()).limit(limit).all()


@app.post("/api/reminders/run")
def reminders_run_manual(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    run_reminders(db)
    return {"ok": True}


@app.post("/api/tickets/delete-used")
def delete_used_tickets(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    # 只刪除確定已使用且無剩餘金額的票券
    targets = (
        db.query(Ticket)
        .filter(Ticket.local_state == 1)
        .all()
    )
    deleted = 0
    deleted_names: list[str] = []
    for t in targets:
        log_activity(db, "delete", f"刪除 {t.name}", t.id)
        deleted += 1
        deleted_names.append(t.name)
        db.delete(t)
    db.commit()
    if deleted:
        log_activity(db, "delete_used", {"deleted": deleted, "names": deleted_names[:30]})
    return {"deleted": deleted}


if STATIC_DIR.is_dir():

    @app.get("/")
    def index_page():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get('/share')
    def share_page():
        return FileResponse(STATIC_DIR / 'share.html', headers={'Referrer-Policy': 'no-referrer'})

    app.mount("/css", StaticFiles(directory=str(STATIC_DIR / "css")), name="css")
    app.mount("/js", StaticFiles(directory=str(STATIC_DIR / "js")), name="js")
