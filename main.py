from __future__ import annotations

import os
import re
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    create_engine,
    func,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def normalize_database_url(raw_url: str | None) -> str:
    """Use SQLite locally and psycopg 3 for PostgreSQL in the cloud."""
    if not raw_url:
        return f"sqlite:///{BASE_DIR / 'prediction_points.db'}"
    if raw_url.startswith("postgres://"):
        return raw_url.replace("postgres://", "postgresql+psycopg://", 1)
    if raw_url.startswith("postgresql://"):
        return raw_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return raw_url


DATABASE_URL = normalize_database_url(os.getenv("DATABASE_URL"))
IS_SQLITE = DATABASE_URL.startswith("sqlite")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Topic(Base):
    __tablename__ = "topics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    red_label: Mapped[str] = mapped_column(String(40), nullable=False)
    blue_label: Mapped[str] = mapped_column(String(40), nullable=False)
    creator_id: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="open", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    predictions: Mapped[list["Prediction"]] = relationship(
        back_populates="topic", cascade="all, delete-orphan"
    )


class Prediction(Base):
    __tablename__ = "predictions"
    __table_args__ = (
        UniqueConstraint("topic_id", "participant_id", name="uq_topic_participant"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    topic_id: Mapped[int] = mapped_column(ForeignKey("topics.id"), nullable=False, index=True)
    participant_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    topic: Mapped[Topic] = relationship(back_populates="predictions")


CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value: str) -> str:
    value = CONTROL_CHARS.sub("", value).strip()
    value = re.sub(r"\s+", " ", value)
    if not value:
        raise ValueError("字段不能为空")
    return value


class TopicCreate(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    red_label: str = Field(min_length=1, max_length=40)
    blue_label: str = Field(min_length=1, max_length=40)
    creator_id: str = Field(min_length=2, max_length=32)

    @field_validator("title", "red_label", "blue_label", "creator_id")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return clean_text(value)

    @field_validator("blue_label")
    @classmethod
    def labels_must_differ(cls, value: str, info):
        red_label = info.data.get("red_label")
        if red_label and value == red_label:
            raise ValueError("红方和蓝方名称不能相同")
        return value


class PredictionCreate(BaseModel):
    topic_id: int = Field(gt=0)
    participant_id: str = Field(min_length=2, max_length=32)
    side: Literal["red", "blue"]
    points: int = Field(gt=0, le=1000)

    @field_validator("participant_id")
    @classmethod
    def validate_participant(cls, value: str) -> str:
        return clean_text(value)


class SimpleRateLimiter:
    """Small single-process limiter suitable for a beginner deployment."""

    def __init__(self) -> None:
        self.events: dict[str, deque[float]] = defaultdict(deque)
        self.lock = Lock()

    def check(self, key: str, limit: int, window_seconds: int) -> None:
        now = time.monotonic()
        cutoff = now - window_seconds
        with self.lock:
            queue = self.events[key]
            while queue and queue[0] < cutoff:
                queue.popleft()
            if len(queue) >= limit:
                raise HTTPException(status_code=429, detail="操作过于频繁，请稍后再试")
            queue.append(now)


rate_limiter = SimpleRateLimiter()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []
        self.lock = Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        with self.lock:
            self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        with self.lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)

    async def broadcast_json(self, payload: dict) -> None:
        with self.lock:
            connections = list(self.active_connections)
        stale: list[WebSocket] = []
        for connection in connections:
            try:
                await connection.send_json(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.disconnect(connection)


manager = ConnectionManager()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def topic_snapshot(db: Session, topic: Topic) -> dict:
    totals = db.execute(
        select(
            func.coalesce(func.sum(Prediction.points).filter(Prediction.side == "red"), 0),
            func.coalesce(func.sum(Prediction.points).filter(Prediction.side == "blue"), 0),
            func.count(Prediction.id),
        ).where(Prediction.topic_id == topic.id)
    ).one()

    red_points = int(totals[0] or 0)
    blue_points = int(totals[1] or 0)
    participant_count = int(totals[2] or 0)
    total_points = red_points + blue_points

    if total_points == 0:
        red_ratio = blue_ratio = 50.0
        red_coefficient = blue_coefficient = 0.0
    else:
        red_ratio = round(red_points / total_points * 100, 1)
        blue_ratio = round(blue_points / total_points * 100, 1)
        red_coefficient = round(total_points / red_points, 2) if red_points else 0.0
        blue_coefficient = round(total_points / blue_points, 2) if blue_points else 0.0

    created_at = topic.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)

    return {
        "id": topic.id,
        "title": topic.title,
        "red_label": topic.red_label,
        "blue_label": topic.blue_label,
        "creator_id": topic.creator_id,
        "status": topic.status,
        "created_at": created_at.isoformat(),
        "red_points": red_points,
        "blue_points": blue_points,
        "total_points": total_points,
        "participant_count": participant_count,
        "red_ratio": red_ratio,
        "blue_ratio": blue_ratio,
        "red_coefficient": red_coefficient,
        "blue_coefficient": blue_coefficient,
    }


def all_topic_snapshots(db: Session) -> list[dict]:
    topics = db.scalars(select(Topic).order_by(Topic.id.desc()).limit(200)).all()
    return [topic_snapshot(db, topic) for topic in topics]


async def broadcast_topics() -> None:
    with SessionLocal() as db:
        payload = {"type": "topics_updated", "topics": all_topic_snapshots(db)}
    await manager.broadcast_json(payload)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title=os.getenv("APP_NAME", "群聊积分预测"),
    description="虚拟积分娱乐预测网页；积分不具备货币价值。",
    version="2.0.0",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "font-src 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'self'"
    )
    return response


@app.get("/", include_in_schema=False)
def homepage() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> dict:
    with engine.connect() as connection:
        connection.execute(select(1))
    return {"ok": True, "mode": "virtual_points_only", "database": "sqlite" if IS_SQLITE else "postgres"}


@app.get("/api/topics")
def list_topics(db: Session = Depends(get_db)) -> list[dict]:
    return all_topic_snapshots(db)


@app.get("/api/topics/{topic_id}")
def get_topic(topic_id: int, db: Session = Depends(get_db)) -> dict:
    topic = db.get(Topic, topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail="预测题不存在")
    return topic_snapshot(db, topic)


@app.post("/api/topics", status_code=201)
async def create_topic(
    payload: TopicCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    rate_limiter.check(f"topic:{client_ip(request)}", limit=8, window_seconds=60)
    topic = Topic(**payload.model_dump())
    db.add(topic)
    db.commit()
    db.refresh(topic)
    result = topic_snapshot(db, topic)
    await broadcast_topics()
    return result


@app.post("/api/predictions", status_code=201)
async def create_or_update_prediction(
    payload: PredictionCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    rate_limiter.check(f"prediction:{client_ip(request)}", limit=30, window_seconds=60)
    topic = db.get(Topic, payload.topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail="预测题不存在")
    if topic.status != "open":
        raise HTTPException(status_code=409, detail="该预测题已关闭")

    prediction = db.scalar(
        select(Prediction).where(
            Prediction.topic_id == payload.topic_id,
            Prediction.participant_id == payload.participant_id,
        )
    )
    action = "created"
    if prediction is None:
        prediction = Prediction(**payload.model_dump())
        db.add(prediction)
    else:
        prediction.side = payload.side
        prediction.points = payload.points
        prediction.updated_at = datetime.now(timezone.utc)
        action = "updated"

    db.commit()
    db.refresh(prediction)
    result = {
        "action": action,
        "prediction_id": prediction.id,
        "topic": topic_snapshot(db, topic),
        "notice": "虚拟积分仅用于娱乐展示，不具备货币价值。",
    }
    await broadcast_topics()
    return result


@app.websocket("/ws/topics")
async def topics_websocket(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        with SessionLocal() as db:
            await websocket.send_json(
                {"type": "topics_updated", "topics": all_topic_snapshots(db)}
            )
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
        try:
            await websocket.close()
        except Exception:
            pass
