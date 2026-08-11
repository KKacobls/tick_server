from __future__ import annotations

import logging
from collections import Counter
from datetime import date, datetime

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import ReminderLog, Ticket

logger = logging.getLogger(__name__)


def dc_send(message: str) -> bool:
    token = (settings.discord.token or "").strip()
    channel = settings.discord.channel_id
    if not token or not channel:
        logger.info("Discord disabled, skip: %s", message[:80])
        return False
    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.post(
                f"https://discord.com/api/v9/channels/{channel}/messages",
                headers={
                    "Authorization": f"Bot {token}",
                    "Content-Type": "application/json",
                },
                json={"content": message},
            )
        if response.status_code == 200:
            logger.info("DC ok: %s", message[:50])
            return True
        logger.warning("DC fail %s: %s", response.status_code, response.text)
        return False
    except Exception as e:
        logger.error("DC error: %s", e)
        return False


def run_reminders(db: Session) -> None:
    today = date.today()
    days_list = settings.reminder.days_before

    # Per-ticket expiry reminders
    q = (
        db.query(Ticket)
        .filter(Ticket.expires_at.isnot(None))
        .filter(Ticket.no_expiry.is_(False))
        .filter(Ticket.local_state == 0)
    )
    for t in q.all():
        assert t.expires_at is not None
        left = (t.expires_at - today).days
        if left not in days_list:
            continue
        exists = (
            db.query(ReminderLog)
            .filter(ReminderLog.ticket_id == t.id, ReminderLog.days_before == left)
            .first()
        )
        if exists:
            continue
        code = t.barcode_text or "(image)"
        msg = (
            f"[{left}d] {t.brand_tag} | {t.name[:40]} | {code} | "
            f"expires {t.expires_at.isoformat()}"
        )
        if dc_send(msg):
            db.add(ReminderLog(ticket_id=t.id, days_before=left))
            db.commit()

    # No-expiry summary (once per day via special days_before=-1)
    no_date = (
        db.query(Ticket)
        .filter((Ticket.no_expiry.is_(True)) | (Ticket.expires_at.is_(None)))
        .filter(Ticket.local_state == 0)
        .all()
    )
    if no_date:
        sent_today = (
            db.query(ReminderLog)
            .filter(ReminderLog.ticket_id == 0, ReminderLog.days_before == -2)
            .filter(ReminderLog.sent_at >= datetime.combine(today, datetime.min.time()))
            .first()
        )
        if not sent_today:
            counts = Counter(t.brand_tag for t in no_date)
            parts = [f"{k}:{v}" for k, v in counts.most_common()]
            msg = f"[no_expiry] total={len(no_date)} | " + " | ".join(parts)
            if dc_send(msg):
                db.add(ReminderLog(ticket_id=0, days_before=-2))
                db.commit()
