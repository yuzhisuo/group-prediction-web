import importlib
import os
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ADMIN_TOKEN = "test-admin-token"
ADMIN_HEADERS = {"X-Admin-Token": ADMIN_TOKEN}


def build_client(tmp_path: Path) -> TestClient:
    os.environ["DATABASE_URL"] = f"sqlite:///{tmp_path / 'test.db'}"
    os.environ["ADMIN_TOKEN"] = ADMIN_TOKEN
    sys.modules.pop("main", None)
    module = importlib.import_module("main")
    return TestClient(module.app)


def create_topic(client: TestClient) -> int:
    response = client.post(
        "/api/topics",
        json={
            "title": "周末活动选什么？",
            "red_label": "爬山",
            "blue_label": "电影",
            "creator_id": "creator01",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def submit(client: TestClient, topic_id: int, participant_id: str, side: str, points: int):
    response = client.post(
        "/api/predictions",
        json={
            "topic_id": topic_id,
            "participant_id": participant_id,
            "side": side,
            "points": points,
        },
    )
    assert response.status_code == 201
    return response.json()


def test_health_details_lock_settle_and_delete(tmp_path: Path):
    with build_client(tmp_path) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["admin_configured"] is True
        assert client.get("/").status_code == 200

        topic_id = create_topic(client)
        submit(client, topic_id, "red01", "red", 100)
        submit(client, topic_id, "red02", "red", 50)
        submit(client, topic_id, "blue01", "blue", 150)

        details = client.get(f"/api/topics/{topic_id}/details")
        assert details.status_code == 200
        payload = details.json()
        assert len(payload["predictions"]) == 3
        assert payload["settlement"] is None
        assert payload["red_points"] == 150
        assert payload["blue_points"] == 150

        missing_admin = client.post(f"/api/topics/{topic_id}/lock", json={})
        assert missing_admin.status_code == 403

        lock = client.post(f"/api/topics/{topic_id}/lock", headers=ADMIN_HEADERS, json={})
        assert lock.status_code == 200
        assert lock.json()["status"] == "locked"

        blocked = client.post(
            "/api/predictions",
            json={
                "topic_id": topic_id,
                "participant_id": "late-user",
                "side": "red",
                "points": 20,
            },
        )
        assert blocked.status_code == 409

        settle = client.post(
            f"/api/topics/{topic_id}/settle",
            headers=ADMIN_HEADERS,
            json={"winning_side": "red"},
        )
        assert settle.status_code == 200
        settled = settle.json()
        assert settled["status"] == "settled_red"
        assert settled["winning_side"] == "red"
        rows = {row["participant_id"]: row for row in settled["settlement"]["rows"]}
        assert rows["red01"]["returned_points"] == 200
        assert rows["red01"]["net_change"] == 100
        assert rows["red02"]["returned_points"] == 100
        assert rows["red02"]["net_change"] == 50
        assert rows["blue01"]["returned_points"] == 0
        assert rows["blue01"]["net_change"] == -150
        assert sum(row["returned_points"] for row in rows.values()) == 300

        second_settlement = client.post(
            f"/api/topics/{topic_id}/settle",
            headers=ADMIN_HEADERS,
            json={"winning_side": "blue"},
        )
        assert second_settlement.status_code == 409

        deleted = client.delete(f"/api/topics/{topic_id}", headers=ADMIN_HEADERS)
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True
        assert client.get(f"/api/topics/{topic_id}").status_code == 404


def test_settlement_requires_lock_and_nonempty_winning_side(tmp_path: Path):
    with build_client(tmp_path) as client:
        topic_id = create_topic(client)
        submit(client, topic_id, "red01", "red", 100)

        too_early = client.post(
            f"/api/topics/{topic_id}/settle",
            headers=ADMIN_HEADERS,
            json={"winning_side": "red"},
        )
        assert too_early.status_code == 409

        assert client.post(
            f"/api/topics/{topic_id}/lock", headers=ADMIN_HEADERS, json={}
        ).status_code == 200

        empty_side = client.post(
            f"/api/topics/{topic_id}/settle",
            headers=ADMIN_HEADERS,
            json={"winning_side": "blue"},
        )
        assert empty_side.status_code == 409

        valid = client.post(
            f"/api/topics/{topic_id}/settle",
            headers=ADMIN_HEADERS,
            json={"winning_side": "red"},
        )
        assert valid.status_code == 200
        row = valid.json()["settlement"]["rows"][0]
        assert row["returned_points"] == 100
        assert row["net_change"] == 0
