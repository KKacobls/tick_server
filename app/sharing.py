"""Expiring, revocable read access. Share links keep their secret in the fragment."""
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth import get_current_user, security
from app.database import Base, get_db

router = APIRouter()


class ReadToken(Base):
    __tablename__ = 'sharing_tokens'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(128))
    digest: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    prefix: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TokenCreate(BaseModel):
    name: str = Field(default='分享連結', max_length=128)
    expires_days: int = Field(default=30, ge=1, le=3650)
    expires_at: datetime | None = None


def token_info(item):
    now = datetime.utcnow()
    return {'id': item.id, 'name': item.name, 'prefix': item.prefix,
            'created_at': item.created_at.isoformat() + 'Z', 'expires_at': item.expires_at.isoformat() + 'Z',
            'revoked': item.revoked_at is not None, 'expired': item.expires_at <= now}


def shared_reader(request: Request, credentials=Depends(security), db: Session = Depends(get_db)):
    if credentials is None or credentials.scheme.lower() != 'bearer':
        raise HTTPException(401, '請提供讀取 Token')
    raw = credentials.credentials
    if not raw.startswith('tkt_'):
        return get_current_user(credentials)
    item = db.query(ReadToken).filter_by(digest=hashlib.sha256(raw.encode()).hexdigest()).first()
    if not item or item.revoked_at or item.expires_at <= datetime.utcnow():
        raise HTTPException(401, '讀取 Token 無效、已到期或已撤銷')
    request.state.exchange_token_id = item.id
    return item.id


@router.get('/api/sharing/tokens')
def list_tokens(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return [token_info(item) for item in db.query(ReadToken).order_by(ReadToken.created_at.desc())]


@router.post('/api/sharing/tokens', status_code=201)
def create_token(body: TokenCreate, db: Session = Depends(get_db), _=Depends(get_current_user)):
    expiry = body.expires_at
    if expiry is not None:
        if expiry.tzinfo is None:
            raise HTTPException(422, '有效期限須包含時區')
        expiry = expiry.astimezone(timezone.utc).replace(tzinfo=None)
    else:
        expiry = datetime.utcnow() + timedelta(days=body.expires_days)
    if expiry <= datetime.utcnow():
        raise HTTPException(422, '有效期限必須晚於現在')
    raw = 'tkt_' + secrets.token_urlsafe(32)
    item = ReadToken(name=body.name.strip() or '分享連結', digest=hashlib.sha256(raw.encode()).hexdigest(),
                     prefix=raw[:12], expires_at=expiry)
    db.add(item)
    db.commit()
    db.refresh(item)
    return {**token_info(item), 'token': raw}


@router.post('/api/sharing/tokens/{token_id}/revoke')
def revoke_token(token_id: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    item = db.get(ReadToken, token_id)
    if item is None:
        raise HTTPException(404, '找不到 Token')
    item.revoked_at = datetime.utcnow()
    db.commit()
    return {'ok': True}
