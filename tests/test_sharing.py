from datetime import datetime, timedelta
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
TEMP = tempfile.TemporaryDirectory()
CONFIG = Path(TEMP.name) / 'config.yaml'
CONFIG.write_text(json.dumps({
    'auth': {'username': 'testuser', 'password': 'testpass', 'secret_key': 'fixture-secret'},
    'database': {'url': 'sqlite:///' + str(Path(TEMP.name) / 'tickets.db').replace('\\', '/')},
    'paths': {'uploads': str(Path(TEMP.name) / 'uploads')},
}), encoding='utf-8')
os.environ['TICKET_CONFIG'] = str(CONFIG)
import httpx
from fastapi.testclient import TestClient
from sqlalchemy import event
from app.main import app
from app.database import Base, engine, SessionLocal
from app.models import Ticket
from app import exchange, sharing


def fresh_database():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        exchange.runtime(db)


class SharingTests(unittest.TestCase):
    def setUp(self):
        fresh_database()
        self.client = TestClient(app)
        login = self.client.post('/api/auth/login', json={'username': 'testuser', 'password': 'testpass'})
        self.auth = {'Authorization': 'Bearer ' + login.json()['access_token']}

    @classmethod
    def tearDownClass(cls):
        engine.dispose()
        TEMP.cleanup()

    def add(self, name='Local', code='LOCAL1', code2=None):
        response = self.client.post('/api/tickets', json={'name': name, 'barcode_text': code, 'barcode_text_2': code2, 'face_value': 10}, headers=self.auth)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def share(self):
        response = self.client.post('/api/sharing/tokens', json={'name': 'Phone', 'expires_days': 1}, headers=self.auth)
        self.assertEqual(response.status_code, 201)
        item = response.json()
        return item, {'Authorization': 'Bearer ' + item['token']}

    def remote_snapshot(self):
        self.add('Remote', 'REMOTE1', 'REMOTE2')
        payload = self.client.get('/api/exchange/export?format=json', headers=self.auth).json()
        payload['server_id'] = str(uuid.uuid4())
        payload['tickets'][0]['id'] = 101
        return payload

    def configure_source(self):
        link = 'https://source.example/share#token=tkt_fixture_source'
        body = {'mode': 'client', 'upstream_url': link, 'confirm_replace': True}
        response = self.client.put('/api/exchange/settings', json=body, headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('tkt_fixture_source', response.text)
        self.assertEqual(response.json()['upstream_url'], 'https://source.example')

    def pull(self, payload, status=200, force=True):
        original = httpx.Client

        def source(request):
            self.assertEqual(request.url.path, '/api/v1/snapshot')
            self.assertEqual(request.headers['Authorization'], 'Bearer tkt_fixture_source')
            return httpx.Response(status, json=payload)

        with patch('app.exchange.httpx.Client', side_effect=lambda **kwargs: original(transport=httpx.MockTransport(source), **kwargs)):
            return exchange.pull_once(force=force)

    def test_expiry_revocation_hash_storage_and_no_write_access(self):
        self.add()
        item, reader = self.share()
        self.assertEqual(self.client.get('/api/v1/tickets', headers=reader).status_code, 200)
        self.assertEqual(self.client.post('/api/tickets', json={'name': 'Forbidden'}, headers=reader).status_code, 401)
        self.assertEqual(self.client.post('/api/sharing/tokens', json={}, headers=reader).status_code, 401)
        self.assertEqual(self.client.put('/api/exchange/settings', json={'mode': 'main'}, headers=reader).status_code, 401)
        self.assertNotIn(item['token'], self.client.get('/api/sharing/tokens', headers=self.auth).text)
        with SessionLocal() as db:
            record = db.get(sharing.ReadToken, item['id'])
            self.assertNotEqual(record.digest, item['token'])
            record.expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
        self.assertEqual(self.client.get('/api/v1/snapshot', headers=reader).status_code, 401)
        fresh, reader = self.share()
        self.client.post('/api/sharing/tokens/' + fresh['id'] + '/revoke', headers=self.auth)
        self.assertEqual(self.client.get('/api/sharing/export?format=txt', headers=reader).status_code, 401)
        self.assertEqual(self.client.post('/api/sharing/tokens', json={'expires_at': '2020-01-01T00:00:00Z'}, headers=self.auth).status_code, 422)

    def test_grouped_text_and_all_export_formats(self):
        self.add('必勝客10元', 'PIZZA1', 'PIZZA2')
        self.add('必勝客10元', 'PIZZA3', 'PIZZA4')
        self.add('統一超商', 'STORE1', 'STORE2')
        _, reader = self.share()
        response = self.client.get('/api/sharing/export?format=txt', headers=reader)
        self.assertEqual(response.status_code, 200)
        text = response.text
        self.assertEqual(text.count('必勝客10元'), 1)
        self.assertIn('必勝客10元\nPIZZA1\nPIZZA2\nPIZZA3\nPIZZA4', text)
        self.assertIn('\n\n統一超商\nSTORE1\nSTORE2', text)
        self.assertEqual(self.client.get('/api/sharing/export?format=json', headers=reader).json()['ticket_count'], 3)
        result = self.client.get('/api/sharing/export?format=zip', headers=reader)
        with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
            self.assertEqual(json.loads(archive.read('ticket-server.json'))['ticket_count'], 3)

    def test_full_replacement_preserves_remote_ids_and_has_restore_backup(self):
        payload = self.remote_snapshot()
        self.add('Local only', 'LOCAL_ONLY')
        self.configure_source()
        result = self.pull(payload)
        self.assertEqual(result['received'], 1)
        self.assertEqual(result['deleted'], 2)
        with SessionLocal() as db:
            rows = db.query(Ticket).all()
            self.assertEqual([(row.id, row.name, row.barcode_text, row.barcode_text_2) for row in rows], [(101, 'Remote', 'REMOTE1', 'REMOTE2')])
        backup = Path(TEMP.name) / 'sync_backups' / result['backup']
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM tickets').fetchone()[0], 2)

    def test_empty_source_replaces_all_and_invalid_sources_preserve_local(self):
        payload = self.remote_snapshot()
        self.configure_source()
        invalid = {**payload, 'tickets': [{'id': 99}]}
        with self.assertRaises(Exception):
            self.pull(invalid)
        with SessionLocal() as db:
            self.assertEqual(db.query(Ticket).count(), 1)
        with self.assertRaises(Exception):
            self.pull({}, status=401)
        with SessionLocal() as db:
            self.assertEqual(db.query(Ticket).count(), 1)
        self.pull({**payload, 'tickets': [], 'attachments': {}, 'ticket_count': 0})
        with SessionLocal() as db:
            self.assertEqual(db.query(Ticket).count(), 0)

    def test_unchanged_periodic_sync_does_not_create_repeated_backups(self):
        payload = self.remote_snapshot()
        self.configure_source()
        self.pull(payload)
        backup_dir = Path(TEMP.name) / 'sync_backups'
        before = set(backup_dir.glob('*.db'))
        with SessionLocal() as db:
            exchange.runtime(db).last_attempt = datetime.utcnow() - timedelta(minutes=2)
            db.commit()
        self.pull({**payload, 'generated_at': 'changed timestamp'}, force=False)
        self.assertEqual(set(backup_dir.glob('*.db')), before)

    def test_database_failure_rolls_back_old_tickets(self):
        payload = self.remote_snapshot()
        self.configure_source()

        def fail_insert(mapper, connection, target):
            raise RuntimeError('simulated disk failure')

        event.listen(Ticket, 'before_insert', fail_insert)
        try:
            with self.assertRaises(RuntimeError):
                self.pull(payload)
        finally:
            event.remove(Ticket, 'before_insert', fail_insert)
        with SessionLocal() as db:
            self.assertEqual(db.query(Ticket).count(), 1)
            self.assertEqual(db.query(Ticket).first().id, 1)

    def test_source_validation_confirmation_and_plain_sync_secret_not_stored(self):
        for body in [
            {'mode': 'client', 'upstream_url': 'https://source.example/share#token=tkt_example'},
            {'mode': 'client', 'upstream_url': 'https://source.example'},
            {'mode': 'client', 'upstream_url': 'file:///tmp/data', 'confirm_replace': True},
        ]:
            self.assertEqual(self.client.put('/api/exchange/settings', json=body, headers=self.auth).status_code, 422)
        self.configure_source()
        with SessionLocal() as db:
            state = exchange.runtime(db)
            self.assertNotIn('tkt_fixture_source', state.upstream_secret)
            self.assertNotIn('token=', state.upstream_url)
        self.assertEqual(self.client.get('/api/tickets').status_code, 401)
        self.assertEqual(self.client.get('/api/sharing/tokens').status_code, 401)

    def test_legacy_client_does_not_start_destructive_sync_implicitly(self):
        self.add()
        with SessionLocal() as db:
            state = exchange.runtime(db)
            state.mode = 'client'
            state.last_result = None
            db.commit()
        self.assertEqual(exchange.pull_once(), {'skipped': True})
        with self.assertRaises(Exception):
            exchange.pull_once(force=True)
        with SessionLocal() as db:
            self.assertEqual(db.query(Ticket).count(), 1)

    def test_original_update_state_images_and_manual_import_still_work(self):
        item = self.add()
        key = item['id']
        self.assertEqual(self.client.patch(f'/api/tickets/{key}', json={'name': 'Edited'}, headers=self.auth).status_code, 200)
        result = self.client.patch(f'/api/tickets/{key}/state', json={'local_state': 2, 'remaining_amount': 5}, headers=self.auth)
        self.assertEqual(result.json()['remaining_amount'], 5)
        image = self.client.post(f'/api/tickets/{key}/image', files={'file': ('test.png', b'fixture-image', 'image/png')}, headers=self.auth)
        self.assertEqual(image.status_code, 200)
        _, reader = self.share()
        self.assertEqual(self.client.get('/api/v1/uploads/' + image.json()['barcode_image'], headers=reader).content, b'fixture-image')
        snapshot = self.client.get('/api/exchange/export?format=json', headers=self.auth).json()
        result = self.client.post('/api/exchange/import', json=snapshot, headers=self.auth)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['created'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
