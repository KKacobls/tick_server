from __future__ import annotations

import re
import html
from datetime import date, datetime
from typing import Any

from dateutil.relativedelta import relativedelta

from app.config import settings

RE_BRAND = re.compile(r"【([^】]+)】")
RE_FACE = re.compile(r"(\d+)\s*元")
RE_CHINESE = re.compile(r"[\u4e00-\u9fff]")
RE_ALNUM_ONLY = re.compile(r"^[A-Za-z0-9]+$")
RE_DUAL_BARCODE_TITLE = re.compile(r"7-11商品卡")
RE_DUAL_BARCODE_HEAD = re.compile(r"^7100\d+$")


def parse_date(value: str | None) -> date | None:
    if not value or not str(value).strip():
        return None
    s = str(value).strip().replace("-", "/")
    for fmt in ("%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            continue
    return None


def extract_brand(name: str) -> str:
    m = RE_BRAND.search(name or "")
    return m.group(1).strip() if m else "其他"


def extract_face_value(name: str) -> float | None:
    m = RE_FACE.search(name or "")
    return float(m.group(1)) if m else None


def default_expiry(insert: date | None) -> tuple[date | None, bool, str]:
    """insert + N months; returns (expires_at, no_expiry, note)."""
    if insert is None:
        return None, True, "no_insert_date"
    months = settings.import_defaults.expiry_months
    exp = insert + relativedelta(months=months)
    return exp, False, f"insert+{months}m"


def parse_expiry_from_row(row: dict[str, Any]) -> tuple[date | None, bool, str]:
    flag = str(row.get("promoFlag", ""))
    if flag == "1" and row.get("etkPromoEndDate"):
        d = parse_date(row["etkPromoEndDate"])
        return d, d is None, "etk_promo_end"
    if flag == "2" and row.get("redemptionPeriodDate"):
        d = parse_date(row["redemptionPeriodDate"])
        return d, d is None, "redemption_period"
    insert = parse_date(row.get("insertDate"))
    return default_expiry(insert)


def should_import_row(row: dict[str, Any]) -> bool:
    if str(row.get("eticketStatus", "")) == "30":
        return False
    if row.get("eticketStatusDesc") == "已兌換":
        return False
    if row.get("expired") is True:
        return False
    return True


def row_to_ticket_fields(row: dict[str, Any]) -> dict[str, Any] | None:
    if not should_import_row(row):
        return None
    name = (row.get("goodsName") or "").strip()
    if not name:
        return None
    barcode = (row.get("eticketNo") or "").strip() or None
    insert = parse_date(row.get("insertDate"))
    expires, no_exp, note = parse_expiry_from_row(row)
    brand = extract_brand(name)
    face = extract_face_value(name)
    variant = (row.get("goodsDtInfo") or "").strip()
    display_name = f"{name} ({variant})" if variant else name
    return {
        "name": display_name,
        "barcode_text": barcode,
        "insert_date": insert,
        "expires_at": expires,
        "no_expiry": no_exp,
        "expiry_note": note,
        "face_value": face,
        "remaining_amount": None,
        "brand_tag": brand,
        "source": "json_import",
    }


def _split_dual_pair(a: str, b: str) -> tuple[str, str]:
    """回傳 (主碼, 副碼)：7100 開頭的長碼優先當主碼，否則較長的當主碼。"""
    a_head = bool(RE_DUAL_BARCODE_HEAD.match(a))
    b_head = bool(RE_DUAL_BARCODE_HEAD.match(b))
    if a_head and not b_head:
        return a, b
    if b_head and not a_head:
        return b, a
    return (a, b) if len(a) >= len(b) else (b, a)


def parse_text_import(text: str, as_note: bool = False) -> list[tuple]:
    """含中文的行為標題，僅英數的行為條碼，歸屬於上一個標題。
    標題含「7-11商品卡」者，條碼兩兩一組（一張卡兩組條碼，7100 開頭的長碼當主碼）。
    """
    text = html.unescape(text).replace('\xa0', ' ')
    if as_note:
        lines = text.strip().splitlines()
        return [(lines[0].strip(), '\n'.join(lines[1:]).strip() or lines[0].strip(), True)] if lines else []
    pairs: list[tuple] = []
    current_title: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        if current_title and buffer:
            if any('http' in line.lower() for line in buffer):
                pairs.append((current_title, '\n'.join(buffer), True))
            elif RE_DUAL_BARCODE_TITLE.search(current_title):
                i = 0
                while i < len(buffer):
                    if i + 1 < len(buffer):
                        primary, secondary = _split_dual_pair(buffer[i], buffer[i + 1])
                        pairs.append((current_title, primary, secondary))
                        i += 2
                    else:
                        pairs.append((current_title, buffer[i]))
                        i += 1
            else:
                for code in buffer:
                    pairs.append((current_title, code))
        buffer = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if 'http' in line.lower():
            if not current_title:
                current_title = '筆記'
            buffer.append(line)
            continue
        if RE_ALNUM_ONLY.match(line):
            if current_title:
                buffer.append(line)
            continue
        if RE_CHINESE.search(line):
            flush()
            current_title = line
    flush()
    return pairs


def text_row_to_ticket_fields(
    title: str, barcode: str, barcode_2: str | bool | None = None
) -> dict[str, Any] | None:
    title = (title or "").strip()
    barcode = (barcode or "").strip()
    if barcode_2 is True or 'http' in barcode.lower():
        return {'name': title, 'note_text': barcode, 'barcode_text': None, 'barcode_text_2': None,
                'brand_tag': extract_brand(title), 'no_expiry': True, 'source': 'note'}
    barcode_2 = (barcode_2 or "").strip() or None
    if not title or not barcode:
        return None
    insert = date.today()
    expires, no_exp, note = default_expiry(insert)
    brand = extract_brand(title)
    face = extract_face_value(title)
    return {
        "name": title,
        "barcode_text": barcode,
        "barcode_text_2": barcode_2,
        "insert_date": insert,
        "expires_at": expires,
        "no_expiry": no_exp,
        "expiry_note": note,
        "face_value": face,
        "remaining_amount": None,
        "brand_tag": brand,
        "source": "text_import",
    }


def normalize_import_payload(payload: dict | list) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if "results" in payload and isinstance(payload["results"], list):
            return payload["results"]
        return [payload]
    return []
