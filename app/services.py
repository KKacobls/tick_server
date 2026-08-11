from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy.orm import Session

from app.models import ActivityLog, Ticket


def log_activity(
    db: Session,
    action: str,
    detail: str | dict | None = None,
    ticket_id: int | None = None,
) -> None:
    text = detail if isinstance(detail, str) or detail is None else json.dumps(detail, ensure_ascii=False)
    db.add(ActivityLog(ticket_id=ticket_id, action=action, detail=text))
    db.commit()


def ticket_to_dict(t: Ticket) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "barcode_text": t.barcode_text,
        "barcode_text_2": t.barcode_text_2,
        "barcode_image": t.barcode_image,
        "insert_date": t.insert_date.isoformat() if t.insert_date else None,
        "expires_at": t.expires_at.isoformat() if t.expires_at else None,
        "no_expiry": t.no_expiry,
        "expiry_note": t.expiry_note,
        "face_value": t.face_value,
        "remaining_amount": t.remaining_amount,
        "brand_tag": t.brand_tag,
        "local_state": t.local_state,
        "used_at": t.used_at.isoformat() if t.used_at else None,
        "source": t.source,
        "hide_used": t.hide_used,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def sort_key_ticket(t: Ticket) -> tuple:
    """Active first by expires/insert; used at bottom."""
    used_rank = 1 if t.local_state in (1, 2) else 0
    exp = t.expires_at or t.insert_date
    exp_ord = exp.toordinal() if exp else 999999
    return (used_rank, exp_ord, t.id)
