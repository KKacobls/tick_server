import base64
import json
import unittest
import uuid
from test_sharing import fresh_database, app, SessionLocal, engine
from fastapi.testclient import TestClient
from app import exchange, import_service
from app.models import Ticket
from sqlalchemy import text

SAMPLE = 'Edenred數位即享卡50元&#x20;\n[https://txp.rs/v/A24kx64iL](https://txp.rs/v/A24kx64iL) 1674\n&#x20;[https://txp.rs/v/FBL7ns90G](https://txp.rs/v/FBL7ns90G) 1368'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlV1XcAAAAASUVORK5CYII=')


class NotesTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        engine.dispose()

    def setUp(self):
        fresh_database()
        self.client = TestClient(app)
        login = self.client.post('/api/auth/login', json={'username': 'testuser', 'password': 'testpass'})
        self.auth = {'Authorization': 'Bearer ' + login.json()['access_token']}

    def preview(self, text=SAMPLE, as_note=False):
        result = self.client.post('/api/tickets/import-text', headers=self.auth, json={'text': text, 'as_note': as_note})
        self.assertEqual(result.status_code, 200)
        return result.json()

    def save(self, fields):
        result = self.client.post('/api/tickets/import-json-commit', headers=self.auth, json={'items': fields})
        self.assertEqual(result.status_code, 200)
        return result.json()

    def test_example_links_and_codes_preserved_as_one_note_no_barcode(self):
        preview = self.preview()
        self.assertEqual(preview['summary']['new'], 1)
        note = preview['items'][0]['ticket']
        self.assertEqual(note['name'], 'Edenred數位即享卡50元')
        self.assertIn('A24kx64iL', note['note_text'])
        self.assertIn('FBL7ns90G', note['note_text'])
        self.assertIn('1674', note['note_text'])
        self.assertIn('1368', note['note_text'])
        self.assertIsNone(note['barcode_text'])
        self.assertEqual(self.save([note])['created'], 1)
        self.assertEqual(self.preview()['summary']['duplicate'], 1)
        self.assertEqual(self.save([note])['duplicates'], 1)
        result = self.client.get('/api/tickets', headers=self.auth).json()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['note_text'], note['note_text'])

    def test_mixed_import_barcode_rules_and_forced_plain_note(self):
        preview = self.preview(SAMPLE + '\n票券\nABC123\nDEF456')
        self.assertEqual(preview['summary']['new'], 3)
        self.assertEqual(sum(item['ticket'].get('note_text') is not None for item in preview['items']), 1)
        self.assertEqual(self.preview('備忘\n明天帶雨傘\n1234', as_note=True)['items'][0]['ticket']['note_text'], '明天帶雨傘\n1234')
        pairs = import_service.parse_text_import('7-11商品卡\n7100123456\n1234')
        self.assertEqual(pairs, [('7-11商品卡', '7100123456', '1234')])
        json_preview = self.client.post('/api/tickets/import-json', headers=self.auth, json={'payload': {'goodsName': '連結券', 'eticketNo': 'https://example.com/v/1 1234'}}).json()
        self.assertIsNone(json_preview['items'][0]['ticket']['barcode_text'])
        self.assertIn('https://example.com', json_preview['items'][0]['ticket']['note_text'])

    def test_title_image_export_and_mirror_roundtrip_notes(self):
        self.save([self.preview()['items'][0]['ticket']])
        name = self.client.get('/api/tickets', headers=self.auth).json()[0]['name']
        self.assertEqual(self.client.post('/api/titles/image', params={'name': name}, files={'file': ('a.svg', b'<svg/>')}, headers=self.auth).status_code, 422)
        image = self.client.post('/api/titles/image', params={'name': name}, files={'file': ('a.png', PNG, 'image/png')}, headers=self.auth)
        self.assertEqual(image.status_code, 200)
        filename = image.json()['title_image']
        self.assertEqual(self.client.get('/api/uploads/' + filename, headers=self.auth).content, PNG)
        share = self.client.post('/api/sharing/tokens', headers=self.auth, json={}).json()
        reader = {'Authorization': 'Bearer ' + share['token']}
        self.assertEqual(self.client.get('/api/v1/uploads/' + filename, headers=reader).content, PNG)
        payload = self.client.get('/api/v1/snapshot', headers=reader).json()
        self.assertEqual(base64.b64decode(payload['attachments'][filename]), PNG)
        payload['server_id'] = str(uuid.uuid4())
        with SessionLocal() as db:
            exchange.replace_snapshot(db, payload)
            row = db.query(Ticket).one()
            self.assertIn('1674', row.note_text)
            self.assertIsNone(row.barcode_text)
            self.assertEqual((exchange.UPLOADS / row.title_image).read_bytes(), PNG)
        exported = self.client.get('/api/exchange/export?format=txt', headers=self.auth)
        self.assertIn('1368', exported.text)

    def test_auxiliary_notes_stay_pending_until_main_approval(self):
        self.client.put('/api/auxiliary/settings', headers=self.auth, json={'enabled': True})
        share = self.client.post('/api/sharing/tokens', headers=self.auth, json={}).json()
        reader = {'Authorization': 'Bearer ' + share['token']}
        body = {'tickets': [{'name': '手機連結', 'barcode_text': 'https://example.com/v/a 1234'}]}
        pending = self.client.post('/api/auxiliary/requests', headers=reader, json=body)
        self.assertEqual(pending.status_code, 202)
        self.assertEqual(self.client.get('/api/tickets', headers=self.auth).json(), [])
        self.client.post('/api/auxiliary/requests/' + pending.json()['id'] + '/accept', headers=self.auth)
        row = self.client.get('/api/tickets', headers=self.auth).json()[0]
        self.assertEqual(row['note_text'], body['tickets'][0]['barcode_text'])
        self.assertIsNone(row['barcode_text'])

    def test_existing_database_migration_preserves_url_and_is_repeatable(self):
        from app.main import _migrate_add_missing_columns
        with engine.begin() as connection:
            connection.execute(text('ALTER TABLE tickets DROP COLUMN note_text'))
            connection.execute(text('ALTER TABLE tickets DROP COLUMN title_image'))
            connection.execute(text("INSERT INTO tickets (name,barcode_text,barcode_text_2,brand_tag,no_expiry,local_state,source,hide_used,created_at,updated_at) VALUES ('Old','https://example.com/v/1','1674','Other',0,0,'manual_text',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
        _migrate_add_missing_columns()
        _migrate_add_missing_columns()
        with SessionLocal() as db:
            item = db.query(Ticket).one()
            self.assertEqual(item.note_text, 'https://example.com/v/1\n1674')
            self.assertIsNone(item.barcode_text)
            self.assertIsNone(item.barcode_text_2)
            self.assertIsNone(item.title_image)


if __name__ == '__main__':
    unittest.main(verbosity=2)
