"""Admin-approved device pairing for the no-login companion app.

The admin creates a QR containing a scoped credential; only its SHA-256
digest is saved. Device access is limited to /api/mobile routes.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth import get_current_user, security
from app.database import Base, get_db
from app.services import log_activity
from app import exchange

router = APIRouter(prefix="/api/mobile", tags=["mobile"])


class MobileDevice(Base):
    __tablename__ = "mobile_devices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class MobileCategory(Base):
    __tablename__ = "mobile_categories"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)


class DeviceRequest(BaseModel):
    name: str = Field(default="手機", min_length=1, max_length=80)


def _info(device: MobileDevice) -> dict:
    return {
        "id": device.id, "name": device.name,
        "created_at": device.created_at.isoformat() + "Z",
        "last_seen_at": device.last_seen_at.isoformat() + "Z" if device.last_seen_at else None,
        "revoked": device.revoked_at is not None,
    }


def require_device(
    creds: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> MobileDevice:
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials.startswith("mob_"):
        raise HTTPException(401, "手機尚未配對 Main")
    digest = hashlib.sha256(creds.credentials.encode()).hexdigest()
    device = db.query(MobileDevice).filter_by(token_hash=digest).first()
    if device is None or device.revoked_at:
        raise HTTPException(401, "裝置授權無效或已撤銷")
    if device.last_seen_at is None or (datetime.utcnow() - device.last_seen_at).total_seconds() > 300:
        device.last_seen_at = datetime.utcnow()
        db.commit()
    return device


@router.get("/devices")
def devices(db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    return [_info(item) for item in db.query(MobileDevice).order_by(MobileDevice.created_at.desc())]


@router.post("/devices", status_code=201)
def create_device(body: DeviceRequest, db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    exchange.protect_main(db)
    token = "mob_" + secrets.token_urlsafe(48)
    item = MobileDevice(
        id=str(uuid.uuid4()), name=body.name.strip() or "手機",
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    log_activity(db, "mobile_pair", {"device_id": item.id, "name": item.name})
    # The raw credential is revealed ONLY ONCE, to the authenticated admin.
    return {**_info(item), "token": token}


@router.post("/devices/{device_id}/revoke")
def revoke_device(device_id: str, db: Session = Depends(get_db), _: str = Depends(get_current_user)):
    device = db.get(MobileDevice, device_id)
    if device is None:
        raise HTTPException(404, "裝置不存在")
    device.revoked_at = datetime.utcnow()
    db.commit()
    log_activity(db, "mobile_revoke", {"device_id": device_id})
    return {"ok": True}


@router.get("/info")
def get_info(db: Session = Depends(get_db), _device: MobileDevice = Depends(require_device)):
    return {"server_id": exchange.runtime(db).server_id, "mode": exchange.runtime(db).mode, "api_version": 1}
