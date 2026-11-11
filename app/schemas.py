from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TicketBase(BaseModel):
    name: str
    note_text: str | None = Field(default=None, max_length=20000)
    barcode_text: str | None = None
    barcode_text_2: str | None = None
    insert_date: date | None = None
    expires_at: date | None = None
    no_expiry: bool = False
    expiry_note: str | None = None
    face_value: float | None = None
    remaining_amount: float | None = None
    brand_tag: str = "其他"
    hide_used: bool = False


class TicketCreate(TicketBase):
    source: str = "manual_text"


class TicketUpdate(BaseModel):
    name: str | None = None
    note_text: str | None = Field(default=None, max_length=20000)
    barcode_text: str | None = None
    barcode_text_2: str | None = None
    insert_date: date | None = None
    expires_at: date | None = None
    no_expiry: bool | None = None
    expiry_note: str | None = None
    face_value: float | None = None
    remaining_amount: float | None = None
    brand_tag: str | None = None
    local_state: int | None = None
    hide_used: bool | None = None


class TicketResponse(TicketBase):
    id: int
    title_image: str | None = None
    barcode_image: str | None = None
    local_state: int
    used_at: datetime | None
    source: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class StatePatch(BaseModel):
    local_state: int
    remaining_amount: float | None = None


class JsonImportRequest(BaseModel):
    payload: dict | list  # raw API body or results array


class TextImportRequest(BaseModel):
    text: str
    as_note: bool = False


class JsonImportCommitItem(BaseModel):
    name: str
    note_text: str | None = Field(default=None, max_length=20000)
    barcode_text: str | None = None
    barcode_text_2: str | None = None
    insert_date: date | None = None
    expires_at: date | None = None
    no_expiry: bool = False
    expiry_note: str | None = None
    face_value: float | None = None
    remaining_amount: float | None = None
    brand_tag: str = "其他"


class JsonImportCommitRequest(BaseModel):
    items: list[JsonImportCommitItem] = Field(default_factory=list)


class LogResponse(BaseModel):
    id: int
    ticket_id: int | None
    action: str
    detail: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
