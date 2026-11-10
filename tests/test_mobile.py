import unittest

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.mobile import ScanBatch, _existing_code, import_scan, pair_codes
from app.mobile_auth import DeviceRequest, MobileDevice, create_device, require_device, revoke_device
from app.models import Ticket
from fastapi.security import HTTPAuthorizationCredentials


class MobileTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, autoflush=False)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_many_ordinary_codes_become_individual_tickets(self):
        raw = ["MDN5955857100094", "MDN5988938866230", "MDN5959064503853"]
        pairs, dual = pair_codes("【麥當勞】漢堡(好禮即享券)", raw + raw[:1])
        self.assertFalse(dual)
        self.assertEqual(pairs, [(code, None) for code in raw])
        output = import_scan(ScanBatch(title="【麥當勞】漢堡(好禮即享券)", codes=raw), self.db, object())
        self.assertEqual(output["created"], 3)
        self.assertEqual(self.db.query(Ticket).count(), 3)
        self.assertTrue(all(item.brand_tag == "其他" for item in self.db.query(Ticket)))

    def test_711_dual_codes_normal_and_reverse(self):
        pair = ["7100016003609284", "3CXR4ME8"]
        self.assertEqual(pair_codes("7-11商品卡#711", pair), ([(pair[0], pair[1])], True))
        self.assertEqual(pair_codes("7-11商品卡#711", pair[::-1]), ([(pair[0], pair[1])], True))
        result = import_scan(ScanBatch(title="7-11商品卡#711", codes=pair, category="7-11"), self.db, object())
        self.assertEqual(result["created"], 1)
        self.assertEqual(self.db.query(Ticket).one().barcode_text_2, pair[1])
        self.assertEqual(self.db.query(Ticket).one().brand_tag, "7-11")

    def test_711_incomplete_or_ambiguous_never_silently_merges(self):
        with self.assertRaises(HTTPException):
            pair_codes("7-11商品卡", ["7100016003609284"])
        pairs, dual = pair_codes("一般票券", ["1234567890123456", "ABC12345"])
        self.assertFalse(dual)
        self.assertEqual(len(pairs), 2)

    def test_duplicate_secondary_code_skipped(self):
        self.db.add(Ticket(name="先前", barcode_text="7100016003609284", barcode_text_2="3CXR4ME8"))
        self.db.commit()
        self.assertIsNotNone(_existing_code(self.db, "3CXR4ME8"))
        output = import_scan(
            ScanBatch(title="7-11商品卡", codes=["7100016003609284", "3CXR4ME8"]),
            self.db, object(),
        )
        self.assertEqual(output["created"], 0)
        self.assertEqual(output["duplicates"], 1)
        self.assertEqual(self.db.query(Ticket).count(), 1)

    def test_device_is_scoped_and_revocable(self):
        data = create_device(DeviceRequest(name="安卓"), self.db, "admin")
        self.assertTrue(data["token"].startswith("mob_"))
        row = self.db.query(MobileDevice).one()
        self.assertNotIn(data["token"], row.token_hash)
        auth = HTTPAuthorizationCredentials(scheme="Bearer", credentials=data["token"])
        self.assertEqual(require_device(auth, self.db).id, data["id"])
        revoke_device(data["id"], self.db, "admin")
        with self.assertRaises(HTTPException):
            require_device(auth, self.db)


if __name__ == "__main__":
    unittest.main()
