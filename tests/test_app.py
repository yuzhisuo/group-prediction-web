import importlib
import os
import sys
from pathlib import Path

from fastapi.testclient import TestClient


def build_client(tmp_path: Path) -> TestClient:
    os.environ["DATABASE_URL"] = f"sqlite:///{tmp_path / 'test.db'}"
    sys.modules.pop("main", None)
    module = importlib.import_module("main")
    return TestClient(module.app)


def test_health_and_main_flow(tmp_path: Path):
    with build_client(tmp_path) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/").status_code == 200

        topic_response = client.post(
            "/api/topics",
            json={
                "title": "周末活动选什么？",
                "red_label": "爬山",
                "blue_label": "电影",
                "creator_id": "creator01",
            },
        )
        assert topic_response.status_code == 201
        topic_id = topic_response.json()["id"]

        first = client.post(
            "/api/predictions",
            json={
                "topic_id": topic_id,
                "participant_id": "user01",
                "side": "red",
                "points": 100,
            },
        )
        assert first.status_code == 201
        assert first.json()["action"] == "created"

        update = client.post(
            "/api/predictions",
            json={
                "topic_id": topic_id,
                "participant_id": "user01",
                "side": "blue",
                "points": 80,
            },
        )
        assert update.status_code == 201
        assert update.json()["action"] == "updated"

        topic = client.get(f"/api/topics/{topic_id}").json()
        assert topic["red_points"] == 0
        assert topic["blue_points"] == 80
        assert topic["participant_count"] == 1
