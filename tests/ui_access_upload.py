"""Real Main and auxiliary browser workflow, isolated from production."""
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode
import cv2
import numpy as np
from playwright.sync_api import sync_playwright, expect
import requests

ROOT = Path(__file__).resolve().parents[1]
temporary = tempfile.TemporaryDirectory()
folder = Path(temporary.name)
processes = {}


def start(name, port):
    config = folder / (name + '.json')
    config.write_text(json.dumps({'auth': {'username': 'testuser', 'password': 'testpass', 'secret_key': name + '-fixture'},
        'database': {'url': 'sqlite:///' + str(folder / (name + '.db')).replace('\\', '/')},
        'paths': {'uploads': str(folder / (name + '-uploads'))}}), encoding='utf-8')
    env = {**os.environ, 'TICKET_CONFIG': str(config), 'PYTHONUTF8': '1'}
    code = f'from app.main import app; from app.database import Base,engine; Base.metadata.create_all(engine); import uvicorn; uvicorn.run(app,host="127.0.0.1",port={port},lifespan="off",log_level="error")'
    process = subprocess.Popen([sys.executable, '-c', code], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    processes[name] = process
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(name + ' startup failed')
        try:
            if requests.get(f'http://127.0.0.1:{port}/login', timeout=.2).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(.05)
    raise RuntimeError('startup timeout')


def count(name):
    with closing(sqlite3.connect(folder / (name + '.db'))) as db:
        return db.execute('select count(*) from tickets').fetchone()[0]


def login(page, port):
    page.goto(f'http://127.0.0.1:{port}')
    expect(page).to_have_url(re.compile('/login$'))
    assert page.locator('#manual-form').count() == 0
    if port == 7032:
        page.screenshot(path=str(ROOT.parents[1] / 'outputs/ticket_login_preview.png'))
    page.locator('#login-user').fill('testuser')
    page.locator('#login-pass').fill('testpass')
    page.locator('#login-btn').click()
    expect(page.locator('#app-view')).to_be_visible()


def settings(page):
    page.locator('.tab[data-tab="settings"]').click()
    expect(page.locator('#auxiliary-enabled')).to_be_enabled()


def propose(page, code):
    page.evaluate('(code) => window.acceptTicketScan(code)', code)
    expect(page.locator('#tab-manual')).to_be_visible()
    page.locator('#manual-form input[name="name"]').fill('手機新增 ' + code)
    page.locator('#manual-form button[type="submit"]').click()


try:
    start('main', 7032)
    start('phone', 7033)
    auth = requests.post('http://127.0.0.1:7032/api/auth/login', json={'username': 'testuser', 'password': 'testpass'}).json()['access_token']
    requests.post('http://127.0.0.1:7032/api/tickets', headers={'Authorization': 'Bearer ' + auth}, json={'name': '原票券', 'barcode_text': 'ORIGINAL1'}).raise_for_status()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        main = browser.new_context(viewport={'width': 1100, 'height': 1000}).new_page()
        phone = browser.new_context(viewport={'width': 390, 'height': 844}).new_page()
        public = browser.new_context(viewport={'width': 320, 'height': 700}).new_page()
        errors = []
        for page in (main, phone, public):
            page.on('pageerror', lambda error: errors.append(str(error)))
        login(main, 7032)
        settings(main)
        main.locator('#share-name').fill('手機')
        main.locator('#create-share-btn').click()
        expect(main.locator('#share-created')).to_be_visible()
        share_link = main.locator('#share-link').input_value()
        qr = cv2.imdecode(np.frombuffer(main.locator('#share-qr').screenshot(), np.uint8), cv2.IMREAD_COLOR)
        assert cv2.QRCodeDetector().detectAndDecode(qr)[0] == share_link
        response = public.goto(share_link)
        assert response.headers['content-type'].startswith('application/json')
        assert len(response.json()['tickets']) == 1 and 'groups' not in response.json()
        assert public.locator('canvas,svg,button').count() == 0
        main.locator('#auxiliary-enabled').check()
        expect(main.locator('#auxiliary-status')).to_have_text('已儲存')
        login(phone, 7033)
        settings(phone)
        phone.locator('#server-mode').select_option('client')
        phone.locator('#main-server-url').fill(share_link)
        phone.once('dialog', lambda dialog: dialog.accept())
        phone.locator('#save-sync-btn').click()
        expect(phone.locator('#exchange-status')).to_have_text('模式已儲存。')
        phone.locator('#auxiliary-enabled').check()
        expect(phone.locator('#auxiliary-status')).to_have_text('已儲存')
        propose(phone, 'PHONE123')
        expect(phone.locator('#auxiliary-status')).to_have_text('已送交 Main 審核')
        assert count('main') == 1 and count('phone') == 1
        main.locator('#auxiliary-review').evaluate('(element) => element.open = true')
        main.locator('#auxiliary-refresh').click()
        expect(main.locator('#auxiliary-count')).to_have_text('1')
        request = main.locator('.upload-request').first
        request.locator('summary').click()
        expect(request.locator('pre')).to_contain_text('PHONE123')
        request.get_by_role('button', name='接受', exact=True).click()
        expect(main.locator('#auxiliary-count')).to_have_text('0')
        assert count('main') == 2
        phone.reload()
        expect(phone.locator('#app-view')).to_be_visible()
        expect(phone.locator('#tab-list')).to_contain_text('手機新增 PHONE123')
        assert count('phone') == 2
        propose(phone, 'REJECT123')
        expect(phone.locator('#auxiliary-status')).to_have_text('已送交 Main 審核')
        main.locator('#auxiliary-refresh').click()
        expect(main.locator('#auxiliary-count')).to_have_text('1')
        request = main.locator('.upload-request').first
        request.locator('summary').click()
        request.get_by_role('button', name='拒絕', exact=True).click()
        expect(main.locator('#auxiliary-count')).to_have_text('0')
        assert count('main') == 2
        processes['main'].terminate()
        processes['main'].wait(10)
        phone.reload()
        expect(phone.locator('#read-only-notice')).to_contain_text('本機保留')
        assert count('phone') == 2
        phone.on('dialog', lambda dialog: dialog.accept())
        propose(phone, 'OFFLINE123')
        expect(phone.locator('#auxiliary-drafts')).to_contain_text('OFFLINE123')
        phone.reload()
        settings(phone)
        expect(phone.locator('#auxiliary-drafts')).to_contain_text('OFFLINE123')
        start('main', 7032)
        phone.locator('#auxiliary-drafts').get_by_role('button', name='重送').click()
        expect(phone.locator('#auxiliary-drafts')).to_be_hidden()
        main.locator('#auxiliary-refresh').click()
        expect(main.locator('#auxiliary-count')).to_have_text('1')
        assert count('main') == 2
        observed = []
        public.on('request', lambda request: observed.append(request.url))
        items = [{'name': '<img src=x onerror=alert(1)>', 'barcodes': ['1234567890', 'ABC-123']}, {'name': '統一超商', 'barcode': 'STORE001'}]
        public.goto('http://127.0.0.1:7032/display?' + urlencode({'list': json.dumps(items)}))
        expect(public.locator('article')).to_have_count(2)
        expect(public.locator('svg')).to_have_count(3)
        assert public.locator('svg > rect').first.evaluate('(element) => getComputedStyle(element).fill') == 'rgb(255, 255, 255)'
        assert public.locator('img').count() == 0
        assert public.evaluate('getComputedStyle(document.body).backgroundColor') == 'rgb(255, 255, 255)'
        for width in (320, 390, 768):
            public.set_viewport_size({'width': width, 'height': 800})
            assert public.evaluate('document.documentElement.scrollWidth <= innerWidth')
        public.goto('http://127.0.0.1:7032/display?' + urlencode([('list', json.dumps(items[0])), ('list', json.dumps(items[1]))]))
        expect(public.locator('article')).to_have_count(2)
        public.goto('http://127.0.0.1:7032/display?' + urlencode({'name': '必勝客', 'barcode': '12345'}))
        expect(public.locator('svg')).to_have_count(1)
        public.screenshot(path=str(ROOT.parents[1] / 'outputs/ticket_display_preview.png'))
        assert not any('/api/' in url for url in observed)
        assert not errors, errors
        browser.close()
    print('PASS: two-server approval/rejection, login, JSON QR, offline draft/retry, mirror fallback, white mobile list display')
finally:
    for process in processes.values():
        if process.poll() is None:
            process.terminate()
            process.wait(10)
    temporary.cleanup()
