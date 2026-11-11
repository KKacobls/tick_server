"""Access boundaries and the pending -> approved upload workflow."""
import base64
import json
import logging
import unittest
from unittest.mock import patch
import uuid

from test_sharing import fresh_database, app, engine, SessionLocal, TEMP
from fastapi.testclient import TestClient
import httpx
from app import auxiliary, exchange
from app.models import Ticket

logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpx2').setLevel(logging.WARNING)


class AccessUploadTests(unittest.TestCase):
    def setUp(self):
        fresh_database()
        self.client = TestClient(app)
        result = self.client.post('/api/auth/login', json={'username': 'testuser', 'password': 'testpass'})
        self.auth = {'Authorization': 'Bearer ' + result.json()['access_token']}
        self.token = self.client.post('/api/sharing/tokens', json={}, headers=self.auth).json()
        self.reader = {'Authorization': 'Bearer ' + self.token['token']}

    @classmethod
    def tearDownClass(cls):
        engine.dispose()

    def proposal(self, code='PHONE1'):
        return {'id': str(uuid.uuid4()), 'source_name': '手機', 'tickets': [{'name': '手機掃描', 'barcode_text': code}], 'images': {}}

    def enable(self):
        self.assertEqual(self.client.put('/api/auxiliary/settings', headers=self.auth, json={'enabled': True}).status_code, 200)

    def count(self):
        with SessionLocal() as db:
            return db.query(Ticket).count()

    def test_page_gate_cookie_logout_and_public_display(self):
        anonymous = TestClient(app, follow_redirects=False)
        for path in ('/', '/js/app.js', '/css/style.css', '/docs', '/openapi.json'):
            response = anonymous.get(path)
            self.assertEqual(response.status_code, 303, path)
            self.assertEqual(response.headers['location'], '/login')
            self.assertNotIn('manual-form', response.text)
        self.assertEqual(anonymous.get('/api/tickets').status_code, 401)
        for path in ('/login', '/display?list=[]', '/js/display.js', '/js/vendor/JsBarcode.all.min.js'):
            self.assertEqual(anonymous.get(path).status_code, 200)
        self.assertEqual(self.client.get('/').status_code, 200)
        cookie = self.client.cookies['ticket_session']
        self.assertTrue(cookie)
        login = anonymous.post('/api/auth/login', json={'username': 'testuser', 'password': 'testpass'})
        self.assertIn('HttpOnly', login.headers['set-cookie'])
        self.assertIn('SameSite=strict', login.headers['set-cookie'])
        anonymous.post('/api/auth/logout')
        self.assertEqual(anonymous.get('/').status_code, 303)
        secure = TestClient(app, base_url='https://testserver')
        result = secure.post('/api/auth/login', json={'username': 'testuser', 'password': 'testpass'})
        self.assertIn('Secure', result.headers['set-cookie'])

    def test_json_only_share_compact_and_sync_compatible(self):
        self.client.post('/api/tickets', headers=self.auth, json={'name': '必勝客', 'barcode_text': 'PIZZA'})
        anonymous = TestClient(app)
        response = anonymous.get('/share', params={'token': self.token['token']})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers['content-type'].startswith('application/json'))
        data = response.json()
        self.assertNotIn('groups', data)
        self.assertNotIn('generated_at', data)
        exchange.validate_snapshot(data)
        self.assertEqual(len(data['tickets']), 1)
        self.assertNotIn(self.token['token'], response.text)
        legacy_size = len(json.dumps(self.client.get('/api/exchange/export?format=json', headers=self.auth).json()))
        self.assertLess(len(response.content), legacy_size)
        result = self.client.put('/api/exchange/settings', headers=self.auth, json={
            'mode': 'client', 'confirm_replace': True, 'upstream_url': 'https://main.example/share?token=tkt_fixture_query'})
        self.assertEqual(result.status_code, 200)
        self.assertNotIn('tkt_fixture_query', result.text)
        self.client.post('/api/sharing/tokens/' + self.token['id'] + '/revoke', headers=self.auth)
        self.assertEqual(anonymous.get('/share', params={'token': self.token['token']}).status_code, 401)

    def test_pending_requires_main_approval_and_is_idempotent(self):
        body = self.proposal()
        self.assertEqual(self.client.post('/api/auxiliary/requests', headers=self.reader, json=body).status_code, 403)
        self.enable()
        self.assertEqual(self.client.post('/api/auxiliary/requests', json=body).status_code, 401)
        self.assertEqual(self.client.post('/api/auxiliary/requests', headers=self.reader, json=body).status_code, 202)
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.client.get('/api/auxiliary/requests', headers=self.reader).status_code, 401)
        self.assertEqual(len(self.client.get('/api/auxiliary/requests', headers=self.auth).json()), 1)
        route = '/api/auxiliary/requests/' + body['id'] + '/accept'
        self.assertEqual(self.client.post(route, headers=self.reader).status_code, 401)
        accepted = self.client.post(route, headers=self.auth)
        self.assertEqual(accepted.json()['result']['created'], 1)
        self.assertEqual(self.count(), 1)
        self.assertEqual(self.client.post(route, headers=self.auth).json()['status'], 'accepted')
        self.assertEqual(self.count(), 1)
        # An identical network retry returns the existing accepted request.
        self.assertEqual(self.client.post('/api/auxiliary/requests', headers=self.reader, json=body).json()['status'], 'accepted')
        body['tickets'][0]['name'] = 'Tampered'
        self.assertEqual(self.client.post('/api/auxiliary/requests', headers=self.reader, json=body).status_code, 409)
        duplicate = self.proposal()
        self.client.post('/api/auxiliary/requests', headers=self.reader, json=duplicate)
        result = self.client.post('/api/auxiliary/requests/' + duplicate['id'] + '/accept', headers=self.auth)
        self.assertEqual(result.json()['result']['skipped'], 1)
        self.assertEqual(self.count(), 1)
        rejected = self.proposal('REJECT')
        self.client.post('/api/auxiliary/requests', headers=self.reader, json=rejected)
        self.client.post('/api/auxiliary/requests/' + rejected['id'] + '/reject', headers=self.auth)
        self.assertEqual(self.count(), 1)

    def test_image_validation_review_and_atomic_rollback(self):
        self.enable()
        body = self.proposal()
        body['tickets'][0]['barcode_text'] = None
        body['images'] = {'0': base64.b64encode(b'<svg onload=alert(1)>').decode()}
        self.assertEqual(self.client.post('/api/auxiliary/requests', headers=self.reader, json=body).status_code, 422)
        image = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlV1XcAAAAASUVORK5CYII=')
        body['images'] = {'0': base64.b64encode(image).decode()}
        self.assertEqual(self.client.post('/api/auxiliary/requests', headers=self.reader, json=body).status_code, 202)
        image_url = '/api/auxiliary/requests/' + body['id'] + '/images/0'
        self.assertEqual(self.client.get(image_url, headers=self.reader).status_code, 401)
        self.assertEqual(self.client.get(image_url, headers=self.auth).content, image)
        with patch('app.auxiliary.Ticket', side_effect=RuntimeError('database failure')):
            with self.assertRaises(RuntimeError):
                self.client.post('/api/auxiliary/requests/' + body['id'] + '/accept', headers=self.auth)
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.client.get('/api/auxiliary/requests', headers=self.auth).json()[0]['status'], 'pending')
        self.client.post('/api/auxiliary/requests/' + body['id'] + '/accept', headers=self.auth)
        self.assertEqual(self.count(), 1)

    def test_auxiliary_forwarding_offline_draft_and_no_local_ticket_write(self):
        self.client.put('/api/exchange/settings', headers=self.auth, json={
            'mode': 'client', 'confirm_replace': True, 'upstream_url': 'https://main.example/share?token=tkt_fixture_main'})
        body = self.proposal()
        self.assertEqual(self.client.post('/api/auxiliary/submit', headers=self.auth, json=body).status_code, 403)
        self.enable()
        original = httpx.Client
        def unavailable(request):
            raise httpx.ConnectError('offline')
        with patch('app.auxiliary.httpx.Client', side_effect=lambda **kwargs: original(transport=httpx.MockTransport(unavailable), **kwargs)):
            self.assertEqual(self.client.post('/api/auxiliary/submit', headers=self.auth, json=body).status_code, 502)
        self.assertEqual(self.count(), 0)
        self.assertEqual(len(self.client.get('/api/auxiliary/drafts', headers=self.auth).json()), 1)
        def upstream(request):
            self.assertEqual(request.url.path, '/api/auxiliary/requests')
            self.assertEqual(request.headers['authorization'], 'Bearer tkt_fixture_main')
            self.assertEqual(json.loads(request.content)['id'], body['id'])
            return httpx.Response(202, json={'id': body['id'], 'status': 'pending'})
        with patch('app.auxiliary.httpx.Client', side_effect=lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs)):
            self.assertEqual(self.client.post('/api/auxiliary/submit', headers=self.auth, json=body).status_code, 202)
        self.assertEqual(self.count(), 0)
        self.assertEqual(self.client.get('/api/auxiliary/drafts', headers=self.auth).json(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
