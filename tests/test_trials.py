import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from tracker import UsageTracker, DEFAULT_TRIAL_BUDGET


@pytest.fixture
def tracker(tmp_path):
    return UsageTracker(db_path=str(tmp_path / "test.db"))


def test_start_trial_initializes(tracker):
    tracker.start_trial("Some-Pack")
    trials = tracker.get_trials()
    assert len(trials) == 1
    t = trials[0]
    assert t["package"] == "Some-Pack"
    assert t["unused_boot_days"] == 0
    assert t["budget"] == DEFAULT_TRIAL_BUDGET
    assert t["days_remaining"] == DEFAULT_TRIAL_BUDGET
    assert t["expired"] is False


def test_start_trial_is_idempotent_resets(tracker):
    tracker.start_trial("Some-Pack")
    tracker.start_trial("Some-Pack")
    assert len(tracker.get_trials()) == 1
