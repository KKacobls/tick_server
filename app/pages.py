"""Browser session gate and public data-only/display endpoints."""
import hashlib
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth import get_current_user
from app.config import ROOT
from app.database import get_db
from app.sharing import ReadToken

router = APIRouter()
COOKIE = 'ticket_session'
PUBLIC_FILES = {'/js/login.js', '/js/display.js', '/css/login.css', '/css/display.css',
                '/js/vendor/JsBarcode.all.min.js', '/js/vendor/qrcode.min.js'}


def authenticated(request):
    raw = request.cookies.get(COOKIE)
    header = request.headers.get('authorization', '')
    if header.lower().startswith('bearer '):
        raw = header[7:]
    if not raw:
        return False
    try:
        get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials=raw))
        return True
    except HTTPException:
        return False


class PageGate(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        # Remove share secrets from the ASGI scope before the access logger sees it.
        if path == '/share':
            request.state.share_token = request.query_params.get('token', '')
            request.scope['query_string'] = b''
            del request._query_params
        public = path in {'/login', '/display', '/share', '/api/auth/login', '/api/auth/logout'} or path in PUBLIC_FILES
        if not public and not path.startswith('/api/') and request.method != 'OPTIONS' and not authenticated(request):
            return RedirectResponse('/login', status_code=303)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        if path in ('/login', '/display', '/share'):
            style = "'self' 'unsafe-inline'" if path == '/display' else "'self'"
            response.headers['Content-Security-Policy'] = f"default-src 'self'; script-src 'self'; style-src {style}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"
        return response


@router.get('/login')
def login_page(request: Request):
    if authenticated(request):
        return RedirectResponse('/', status_code=303)
    return FileResponse(ROOT / 'static/login.html')


@router.post('/api/auth/logout')
def logout():
    response = JSONResponse({'ok': True})
    response.delete_cookie(COOKIE)
    return response


@router.get('/display')
def display_page():
    return FileResponse(ROOT / 'static/display.html')


@router.get('/share')
def machine_share(request: Request, db: Session = Depends(get_db)):
    raw = getattr(request.state, 'share_token', '')
    item = db.query(ReadToken).filter_by(digest=hashlib.sha256(raw.encode()).hexdigest()).first() if raw.startswith('tkt_') else None
    if not item or item.revoked_at or item.expires_at <= datetime.utcnow():
        raise HTTPException(401, '分享網址無效或已到期')
    from app import exchange
    db.rollback()
    sync = exchange.refresh_auxiliary_on_open()
    result = exchange.snapshot(db, compact=True)
    return JSONResponse(result, headers={'X-Ticket-Sync': sync})
