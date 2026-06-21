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


def _ahead(days):
    return datetime.now(timezone.utc) + timedelta(days=days)


def test_tick_increments_only_on_new_day(tracker):
    tracker.start_trial("Pack")          # enable day, counter 0
    tracker.tick_boot_days()             # same day -> no change
    assert tracker.get_trials()[0]["unused_boot_days"] == 0

    with patch("tracker.datetime") as m:
        m.now.return_value = _ahead(1)
        tracker.tick_boot_days()         # new day -> 1
        tracker.tick_boot_days()         # same (mocked) day -> still 1
    assert tracker.get_trials()[0]["unused_boot_days"] == 1


def test_tick_reaches_expiry(tracker):
    tracker.start_trial("Pack")
    for d in range(1, DEFAULT_TRIAL_BUDGET + 1):
        with patch("tracker.datetime") as m:
            m.now.return_value = _ahead(d)
            tracker.tick_boot_days()
    t = tracker.get_trials()[0]
    assert t["unused_boot_days"] == DEFAULT_TRIAL_BUDGET
    assert t["expired"] is True
    assert t["days_remaining"] == 0
