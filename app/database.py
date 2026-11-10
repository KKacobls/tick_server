from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import ROOT, settings

_db_url = settings.database.url
if _db_url.startswith("sqlite:///./"):
    rel = _db_url.replace("sqlite:///./", "")
    (ROOT / Path(rel).parent).mkdir(parents=True, exist_ok=True)
    _db_url = "sqlite:///" + (ROOT / rel).resolve().as_posix()

connect_args = {"check_same_thread": False} if _db_url.startswith("sqlite") else {}
engine = create_engine(_db_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
