"""Notes use the existing ticket dataset so backups, review and mirroring retain them."""
import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import Ticket

router = APIRouter()


def contains_http(value):
    return 'http' in (value or '').lower()


def normalize(fields):
    parts = [fields.get(key) for key in ('barcode_text', 'barcode_text_2') if fields.get(key)]
    if any(contains_http(part) for part in parts):
        fields['note_text'] = '\n'.join([text for text in [fields.get('note_text'), *parts] if text])
    if fields.get('note_text') is not None:
        if len(fields['note_text']) > 20000:
            raise HTTPException(422, '筆記最多 20000 字')
        fields.update(barcode_text=None, barcode_text_2=None, source='note', no_expiry=True, expires_at=None)
    return fields


def inherit_image(db, fields):
    previous = db.query(Ticket).filter(Ticket.name == fields['name'], Ticket.title_image.isnot(None)).first()
    if previous:
        fields['title_image'] = previous.title_image
    return fields


@router.post('/api/titles/image')
async def title_image(name: str = Query(min_length=1, max_length=512), file: UploadFile = File(...),
                      db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    exchange.protect_main(db)
    items = db.query(Ticket).filter(Ticket.name == name).all()
    if not items:
        raise HTTPException(404, '找不到標題')
    content = await file.read(5 * 1024 * 1024 + 1)
    if not content or len(content) > 5 * 1024 * 1024:
        raise HTTPException(413, '圖片最多 5 MB')
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        suffix = '.png'
    elif content.startswith(b'\xff\xd8\xff'):
        suffix = '.jpg'
    elif content.startswith(b'RIFF') and content[8:12] == b'WEBP':
        suffix = '.webp'
    else:
        raise HTTPException(422, '只接受 PNG、JPEG 或 WebP 圖片')
    filename = 'title_' + hashlib.sha256(content).hexdigest() + suffix
    exchange.UPLOADS.mkdir(parents=True, exist_ok=True)
    destination = exchange.UPLOADS / filename
    if not destination.exists():
        destination.write_bytes(content)
    for item in items:
        item.title_image = filename
    db.commit()
    return {'title_image': filename}


@router.delete('/api/titles/image')
def remove_title_image(name: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    exchange.protect_main(db)
    db.query(Ticket).filter(Ticket.name == name).update({'title_image': None})
    db.commit()
    return {'ok': True}


@router.delete('/api/notes/{note_id}')
def delete_note(note_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    from app import exchange
    exchange.protect_main(db)
    note = db.get(Ticket, note_id)
    if not note or note.note_text is None:
        raise HTTPException(404)
    db.query(exchange.SyncLink).filter_by(ticket_id=note_id).delete()
    db.query(exchange.TicketIdentity).filter_by(ticket_id=note_id).delete()
    db.delete(note)
    db.commit()
    return {'ok': True}
