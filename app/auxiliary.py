"""Auxiliary proposals stay separate from live tickets until Main approves."""
import base64
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import threading
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth import get_current_user
from app.database import Base, get_db
from app.models import Ticket
from app.schemas import TicketCreate
from app.sharing import shared_reader

router = APIRouter()
review_lock = threading.Lock()
MAX_UPLOAD = 4 * 1024 * 1024


class UploadSettings(Base):
    __tablename__ = 'auxiliary_upload_settings'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)


class UploadRequest(Base):
    __tablename__ = 'auxiliary_upload_requests'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_name: Mapped[str] = mapped_column(String(128))
    source_key: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default='pending', index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)


class UploadConfig(BaseModel):
    enabled: bool


class Proposal(BaseModel):
    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    source_name: str = Field(default='輔助裝置', min_length=1, max_length=128)
    tickets: list[TicketCreate] = Field(min_length=1, max_length=100)
    # An optional base64 image per ticket, keyed by its list index.
    images: dict[str, str] = Field(default_factory=dict)


def config(db):
    item = db.get(UploadSettings, 1)
    if item is None:
        item = UploadSettings(id=1, enabled=False)
        db.add(item)
        db.commit()
    return item


def validated_payload(body):
    from app import notes
    payload = body.model_dump(mode='json')
    if len(json.dumps(payload).encode()) > MAX_UPLOAD:
        raise HTTPException(413, '上傳資料超過 4 MB')
    for index, ticket in enumerate(body.tickets):
        normalized = notes.normalize(ticket.model_dump(mode='json'))
        payload['tickets'][index] = normalized
        if not ticket.name.strip() or len(ticket.name) > 512 or len(ticket.brand_tag) > 128:
            raise HTTPException(422, '名稱或標籤不合法')
        if not ticket.barcode_text and not ticket.note_text and str(index) not in body.images:
            raise HTTPException(422, '票券需要條碼或圖片')
        for code in (ticket.barcode_text, ticket.barcode_text_2):
            if code and not notes.contains_http(code) and len(code) > 128:
                raise HTTPException(422, '條碼最多 128 字')
        for value in (ticket.face_value, ticket.remaining_amount):
            if value is not None and (not math.isfinite(value) or value < 0):
                raise HTTPException(422, '金額不合法')
    for index, encoded in body.images.items():
        if index not in {str(i) for i in range(len(body.tickets))}:
            raise HTTPException(422, '圖片索引不合法')
        try:
            content = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise HTTPException(422, '圖片格式不合法')
        if not content or len(content) > 2 * 1024 * 1024:
            raise HTTPException(413, '單張圖片最多 2 MB')
        if not (content.startswith(b'\x89PNG\r\n\x1a\n') or content.startswith(b'\xff\xd8\xff') or content.startswith(b'RIFF') and content[8:12] == b'WEBP'):
            raise HTTPException(422, '只接受 PNG、JPEG 或 WebP 圖片')
    return payload


@router.get('/api/auxiliary/settings')
def read_config(db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    return {'enabled': config(db).enabled, 'mode': exchange.runtime(db).mode}


@router.put('/api/auxiliary/settings')
def save_config(body: UploadConfig, db: Session = Depends(get_db), _=Depends(get_current_user)):
    item = config(db)
    item.enabled = body.enabled
    db.commit()
    return {'enabled': item.enabled}


@router.post('/api/auxiliary/requests', status_code=202)
def receive(body: Proposal, request: Request, db: Session = Depends(get_db), reader=Depends(shared_reader)):
    from app import exchange
    exchange.protect_main(db)
    if not config(db).enabled:
        raise HTTPException(403, 'Main 未開啟輔助上傳')
    payload = validated_payload(body)
    source_key = hashlib.sha256(str(reader).encode()).hexdigest()
    existing = db.get(UploadRequest, str(body.id))
    if existing:
        if existing.source_key != source_key or json.loads(existing.payload) != payload:
            raise HTTPException(409, '申請編號已被使用')
        return {'id': existing.id, 'status': existing.status}
    if db.query(UploadRequest).filter_by(source_key=source_key, status='pending').count() >= 100:
        raise HTTPException(429, '待審申請已滿')
    item = UploadRequest(id=str(body.id), source_name=body.source_name, source_key=source_key,
                         payload=json.dumps(payload, ensure_ascii=False), status='pending')
    db.add(item)
    db.commit()
    return {'id': item.id, 'status': item.status}


@router.get('/api/auxiliary/requests')
def requests_list(db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    exchange.protect_main(db)
    return [{'id': item.id, 'source_name': item.source_name, 'status': item.status,
             'created_at': item.created_at.isoformat() + 'Z',
             'tickets': json.loads(item.payload)['tickets'],
             'image_indices': list(json.loads(item.payload)['images'])}
            for item in db.query(UploadRequest).filter_by(status='pending').order_by(UploadRequest.created_at)]


@router.get('/api/auxiliary/requests/{request_id}/images/{index}')
def request_image(request_id: str, index: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    from fastapi.responses import Response
    from app import exchange
    exchange.protect_main(db)
    item = db.get(UploadRequest, request_id)
    encoded = json.loads(item.payload)['images'].get(index) if item else None
    if not encoded:
        raise HTTPException(404)
    content = base64.b64decode(encoded)
    mime = 'image/png' if content.startswith(b'\x89PNG') else 'image/jpeg' if content.startswith(b'\xff\xd8') else 'image/webp'
    return Response(content, media_type=mime)


@router.post('/api/auxiliary/requests/{request_id}/{decision}')
def review(request_id: str, decision: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    exchange.protect_main(db)
    if decision not in ('accept', 'reject'):
        raise HTTPException(404)
    with review_lock:
        item = db.get(UploadRequest, request_id)
        if not item:
            raise HTTPException(404)
        if item.status != 'pending':
            return {'status': item.status, 'result': json.loads(item.result) if item.result else None}
        created, skipped = 0, 0
        if decision == 'accept':
            payload = validated_payload(Proposal.model_validate_json(item.payload))
            for index, data in enumerate(payload['tickets']):
                body = TicketCreate.model_validate(data)
                if body.note_text is not None and db.query(Ticket).filter_by(name=body.name, note_text=body.note_text).first():
                    skipped += 1
                    continue
                if body.barcode_text and db.query(Ticket).filter_by(barcode_text=body.barcode_text).first():
                    skipped += 1
                    continue
                fields = body.model_dump()
                fields['source'] = 'note' if body.note_text is not None else 'auxiliary_approved'
                from app import notes
                fields = notes.inherit_image(db, fields)
                encoded = payload['images'].get(str(index))
                if encoded:
                    content = base64.b64decode(encoded)
                    suffix = '.png' if content.startswith(b'\x89PNG') else '.jpg' if content.startswith(b'\xff\xd8') else '.webp'
                    name = 'approved_' + hashlib.sha256(content).hexdigest() + suffix
                    exchange.UPLOADS.mkdir(parents=True, exist_ok=True)
                    path = exchange.UPLOADS / name
                    if not path.exists():
                        path.write_bytes(content)
                    fields['barcode_image'] = name
                db.add(Ticket(**fields))
                db.flush()
                created += 1
        item.status = 'accepted' if decision == 'accept' else 'rejected'
        item.reviewed_at = datetime.utcnow()
        item.result = json.dumps({'created': created, 'skipped': skipped})
        db.commit()
        return {'status': item.status, 'result': json.loads(item.result)}


@router.post('/api/auxiliary/submit', status_code=202)
def submit(body: Proposal, db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    state = exchange.runtime(db)
    if state.mode != 'client' or not config(db).enabled:
        raise HTTPException(403, '請先啟用輔助上傳')
    payload = validated_payload(body)
    credentials = exchange.upstream_credentials(state)
    if not state.upstream_url or not credentials:
        raise HTTPException(409, '請先設定 Main')
    # Persist a retryable draft separately; ordinary mirror pulls cannot erase it.
    existing = db.get(UploadRequest, str(body.id))
    if existing and json.loads(existing.payload) != payload:
        raise HTTPException(409, '申請編號已被使用')
    if not existing:
        existing = UploadRequest(id=str(body.id), source_name=body.source_name, source_key=state.server_id,
                                 payload=json.dumps(payload, ensure_ascii=False), status='draft')
        db.add(existing)
        db.commit()
    try:
        with httpx.Client(timeout=httpx.Timeout(10, connect=3), follow_redirects=False) as client:
            raw = credentials.get('read_token')
            if not raw:
                login = client.post(state.upstream_url + '/api/auth/login', json=credentials)
                login.raise_for_status()
                raw = login.json()['access_token']
            response = client.post(state.upstream_url + '/api/auxiliary/requests', json=payload,
                                   headers={'Authorization': 'Bearer ' + raw})
            response.raise_for_status()
            result = response.json()
            if result.get('id') != str(body.id) or result.get('status') not in ('pending', 'accepted', 'rejected'):
                raise ValueError('invalid response')
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(502, 'Main 尚未接受上傳；草稿已保留，可重送')
    existing.status = 'sent'
    db.commit()
    return result


@router.get('/api/auxiliary/drafts')
def drafts(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return [json.loads(item.payload) for item in db.query(UploadRequest).filter_by(status='draft')]
