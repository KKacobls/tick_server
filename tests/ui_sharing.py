import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sys
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).parent))
from test_sharing import app, fresh_database, engine, TEMP, SessionLocal
from app import exchange
from app.models import Ticket
import cv2
import numpy as np
from playwright.sync_api import sync_playwright, expect
import uvicorn

logging.getLogger('httpx').setLevel(logging.WARNING)
fresh_database()
with SessionLocal() as db:
    db.add_all([
        Ticket(name='必勝客10元', barcode_text='PIZZA1', barcode_text_2='PIZZA2'),
        Ticket(name='必勝客10元', barcode_text='PIZZA3', barcode_text_2='PIZZA4'),
        Ticket(name='統一超商', barcode_text='STORE1', barcode_text_2='STORE2'),
    ])
    db.commit()
    source = exchange.snapshot(db)
source['server_id'] = str(uuid.uuid4())
source['tickets'] = source['tickets'][:1]
source['ticket_count'] = 1
source['tickets'][0].update(id=101, name='來源 B 的票券', barcode_text='SOURCE_B1', barcode_text_2='SOURCE_B2')


class SourceHandler(BaseHTTPRequestHandler):
    available = True

    def do_GET(self):
        if not self.available:
            self.send_response(503)
            self.end_headers()
            return
        if self.path != '/api/v1/snapshot' or self.headers.get('Authorization') != 'Bearer tkt_fixture_remote':
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(source).encode())

    def log_message(self, *args):
        pass


remote = ThreadingHTTPServer(('127.0.0.1', 7033), SourceHandler)
threading.Thread(target=remote.serve_forever, daemon=True).start()
server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=7032, lifespan='off', log_level='error'))
thread = threading.Thread(target=server.run, daemon=True)
thread.start()
for _ in range(100):
    if server.started:
        break
    time.sleep(.05)
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:7032')
        page.locator('#login-user').fill('testuser')
        page.locator('#login-pass').fill('testpass')
        page.locator('#login-btn').click()
        expect(page.locator('#app-view')).to_be_visible()
        page.locator('.tab[data-tab="settings"]').click()
        expect(page.locator('#ticket-text-export')).to_have_value(re.compile('必勝客10元\nPIZZA1\nPIZZA2\nPIZZA3\nPIZZA4'))
        page.locator('#share-name').fill('手機')
        page.locator('#share-expiry').fill('2030-01-01T12:00')
        page.locator('#create-share-btn').click()
        expect(page.locator('#share-created')).to_be_visible()
        share_link = page.locator('#share-link').input_value()
        qr_image = page.locator('#share-qr').screenshot()
        qr_matrix = cv2.imdecode(np.frombuffer(qr_image, np.uint8), cv2.IMREAD_COLOR)
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(qr_matrix)
        assert decoded == share_link, 'Generated QR must decode to the actual share URL'
        viewer = context.new_page()
        viewer.on('pageerror', lambda error: errors.append(str(error)))
        viewer.goto(share_link)
        expect(viewer.locator('#reader-status')).to_have_text('3 張票券 · 唯讀')
        expect(viewer.locator('#reader-text')).to_have_value(re.compile('PIZZA1\nPIZZA2\nPIZZA3\nPIZZA4'))
        with viewer.expect_download() as downloaded:
            viewer.locator('#reader-txt').click()
        assert '必勝客10元' in Path(downloaded.value.path()).read_text(encoding='utf-8')
        viewer.evaluate("window.TicketScanner = {saveExport: (data, mime, name) => { window.savedExport = {data, mime, name}; }}")
        viewer.locator('#reader-json').click()
        viewer.wait_for_function('window.savedExport !== undefined')
        exported = viewer.evaluate('window.savedExport')
        import base64
        assert json.loads(base64.b64decode(exported['data']))['ticket_count'] == 3
        assert exported['name'] == 'tickets.json'
        for width in [320, 360, 390, 768]:
            page.set_viewport_size({'width': width, 'height': 850})
            viewer.set_viewport_size({'width': width, 'height': 850})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('admin', width)
            assert viewer.evaluate('document.documentElement.scrollWidth <= innerWidth'), ('reader', width)
        page.locator('#share-token-list button').click()
        viewer.reload()
        expect(viewer.locator('#reader-status')).to_contain_text('到期或已撤銷')
        page.locator('#server-mode').select_option('client')
        page.locator('#main-server-url').fill('http://127.0.0.1:7033/share#token=tkt_fixture_remote')
        page.once('dialog', lambda dialog: dialog.accept())
        with page.expect_response(lambda response: '/api/tickets?' in response.url and response.request.method == 'GET') as replaced:
            page.locator('#save-sync-btn').click()
        assert replaced.value.status == 200
        expect(page.locator('#ticket-text-export')).to_have_value('來源 B 的票券\nSOURCE_B1\nSOURCE_B2')
        with SessionLocal() as db:
            assert [(ticket.id, ticket.name) for ticket in db.query(Ticket)] == [(101, '來源 B 的票券')]
        source['tickets'][0]['name'] = 'Main 下一次開啟的新票券'
        page.reload()
        page.locator('.tab[data-tab="settings"]').click()
        expect(page.locator('#ticket-text-export')).to_have_value('Main 下一次開啟的新票券\nSOURCE_B1\nSOURCE_B2')
        SourceHandler.available = False
        page.reload()
        page.locator('.tab[data-tab="settings"]').click()
        expect(page.locator('#ticket-text-export')).to_have_value('Main 下一次開啟的新票券\nSOURCE_B1\nSOURCE_B2')
        expect(page.locator('#read-only-notice')).to_contain_text('本機保留票券')
        expect(page.locator('#server-mode')).to_have_value('client')
        assert not errors, errors
        browser.close()
        print('PASS sharing/QR/export/mobile; auxiliary refresh on every open; Main unavailable shows retained local tickets')
finally:
    server.should_exit = True
    thread.join(3)
    remote.shutdown()
    engine.dispose()
    TEMP.cleanup()
