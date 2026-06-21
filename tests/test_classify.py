from datetime import datetime, timezone, timedelta

from tracker import _classify_age


def _thresholds():
    now = datetime.now(timezone.utc)
    return (
        (now - timedelta(days=30)).isoformat(),
        (now - timedelta(days=60)).isoformat(),
    )


def _ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def test_recent_used():
    one, two = _thresholds()
    assert _classify_age(_ago(5), one, two, "used") == "used"


def test_recent_unused_new():
    one, two = _thresholds()
    assert _classify_age(_ago(5), one, two, "unused_new") == "unused_new"


def test_consider_removing_window():
    one, two = _thresholds()
    assert _classify_age(_ago(40), one, two, "used") == "consider_removing"
    assert _classify_age(_ago(40), one, two, "unused_new") == "consider_removing"


def test_safe_to_remove_window():
    one, two = _thresholds()
    assert _classify_age(_ago(70), one, two, "used") == "safe_to_remove"
    assert _classify_age(_ago(70), one, two, "unused_new") == "safe_to_remove"


def test_none_timestamp_is_recent():
    one, two = _thresholds()
    # No history yet -> treated as recent, never a removal candidate
    assert _classify_age(None, one, two, "unused_new") == "unused_new"
    assert _classify_age(None, one, two, "used") == "used"
