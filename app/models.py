from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Ticket(Base):
    """Simplified ticket: name, barcode, dates, amount."""

    __tablename__ = "tickets"
    __table_args__ = (UniqueConstraint("barcode_text", name="uq_barcode_text"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 名稱
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    # 文字條碼（與圖片二擇一或並存時以文字優先顯示）
    barcode_text: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    # 第二組條碼（例如 7-11 商品卡一張兩組條碼）
    barcode_text_2: Mapped[str | None] = mapped_column(String(128), nullable=True)
    note_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    title_image: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 圖片條碼路徑（相對 uploads）
    barcode_image: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 新增/取得日期
    insert_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    # 兌換期限
    expires_at: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    # 是否無法自動推算期限（需人工注意）
    no_expiry: Mapped[bool] = mapped_column(default=False)
    expiry_note: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # 面額 / 剩餘
    face_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    remaining_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 大標籤（品牌）
    brand_tag: Mapped[str] = mapped_column(String(128), default="其他", index=True)
    # 0=active 1=used 2=partial
    local_state: Mapped[int] = mapped_column(Integer, default=0, index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # json_import | manual_text | manual_image
    source: Mapped[str] = mapped_column(String(32), default="manual_text")
    # 隱藏已使用（仍保留資料，排序在最下）
    hide_used: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class ReminderLog(Base):
    __tablename__ = "reminder_logs"
    __table_args__ = (UniqueConstraint("ticket_id", "days_before", name="uq_reminder_once"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[int] = mapped_column(Integer, index=True)
    days_before: Mapped[int] = mapped_column(Integer)
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ticket_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(64))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
