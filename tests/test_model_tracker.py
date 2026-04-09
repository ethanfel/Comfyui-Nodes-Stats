import pytest
import tempfile
import os
from unittest.mock import patch
from datetime import datetime, timezone, timedelta
from tracker import UsageTracker


@pytest.fixture
def tracker(tmp_path):
    return UsageTracker(db_path=str(tmp_path / "test.db"))


def test_record_and_retrieve_model_usage(tracker):
    tracker.record_model_usage([("dreamshaper.safetensors", "checkpoints")])
    tracker.record_model_usage([("dreamshaper.safetensors", "checkpoints")])

    raw = tracker.get_raw_model_stats()
    assert len(raw) == 1
    assert raw[0]["model_name"] == "dreamshaper.safetensors"
    assert raw[0]["model_type"] == "checkpoints"
    assert raw[0]["count"] == 2


def test_record_multiple_models(tracker):
    tracker.record_model_usage([
        ("dreamshaper.safetensors", "checkpoints"),
        ("vae.safetensors", "vae"),
    ])
    raw = tracker.get_raw_model_stats()
    assert len(raw) == 2


def test_reset_clears_model_usage(tracker):
    tracker.record_model_usage([("model.safetensors", "checkpoints")])
    tracker.reset()
    assert tracker.get_raw_model_stats() == []


def test_empty_models_returns_empty(tracker):
    assert tracker.get_raw_model_stats() == []


def test_get_model_stats_used(tracker):
    tracker.record_model_usage([("model.safetensors", "checkpoints")])
    installed = {"checkpoints": ["model.safetensors"]}
    result = tracker.get_model_stats(installed)
    assert len(result) == 1
    assert result[0]["model_type"] == "checkpoints"
    assert result[0]["models"][0]["status"] == "used"
    assert result[0]["models"][0]["count"] == 1


def test_get_model_stats_never_used_new(tracker):
    installed = {"checkpoints": ["unused.safetensors"]}
    result = tracker.get_model_stats(installed)
    assert result[0]["models"][0]["status"] == "unused_new"
    assert result[0]["models"][0]["count"] == 0


def test_get_model_stats_uninstalled(tracker):
    tracker.record_model_usage([("gone.safetensors", "checkpoints")])
    installed = {}  # no longer on disk
    result = tracker.get_model_stats(installed)
    assert result[0]["models"][0]["status"] == "uninstalled"
    assert result[0]["models"][0]["installed"] is False


def test_get_model_stats_sorted_by_status(tracker):
    tracker.record_model_usage([("active.safetensors", "checkpoints")])
    installed = {"checkpoints": ["active.safetensors", "unused.safetensors"]}
    result = tracker.get_model_stats(installed)
    models = result[0]["models"]
    statuses = [m["status"] for m in models]
    # unused_new (2) comes before used (3) in STATUS_ORDER
    assert statuses.index("unused_new") < statuses.index("used")


def test_get_model_stats_safe_to_remove(tracker):
    """A model last used 70 days ago should be classified safe_to_remove."""
    tracker.record_model_usage([("old.safetensors", "checkpoints")])
    installed = {"checkpoints": ["old.safetensors"]}

    # Patch datetime in tracker so "now" is 70 days after last_seen
    future_now = datetime.now(timezone.utc) + timedelta(days=70)
    with patch("tracker.datetime") as mock_dt:
        mock_dt.now.return_value = future_now
        result = tracker.get_model_stats(installed)

    assert result[0]["models"][0]["status"] == "safe_to_remove"


def test_get_model_stats_consider_removing(tracker):
    """A model last used 40 days ago should be classified consider_removing."""
    tracker.record_model_usage([("medium.safetensors", "checkpoints")])
    installed = {"checkpoints": ["medium.safetensors"]}

    future_now = datetime.now(timezone.utc) + timedelta(days=40)
    with patch("tracker.datetime") as mock_dt:
        mock_dt.now.return_value = future_now
        result = tracker.get_model_stats(installed)

    assert result[0]["models"][0]["status"] == "consider_removing"
