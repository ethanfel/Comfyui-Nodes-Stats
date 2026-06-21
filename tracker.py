import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)


def _default_db_path():
    """Store the DB in ComfyUI's user directory so it survives extension reinstalls."""
    try:
        import folder_paths

        user_dir = folder_paths.get_user_directory()
        db_dir = os.path.join(user_dir, "nodes_stats")
        os.makedirs(db_dir, exist_ok=True)
        return os.path.join(db_dir, "usage_stats.db")
    except Exception:
        # Fallback to extension directory if folder_paths is unavailable
        return os.path.join(os.path.dirname(__file__), "usage_stats.db")


DB_PATH = _default_db_path()
_OLD_DB_PATH = os.path.join(os.path.dirname(__file__), "usage_stats.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS node_usage (
    class_type TEXT PRIMARY KEY,
    package TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    class_types TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
    model_name TEXT PRIMARY KEY,
    model_type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_packages (
    package TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL,
    last_use_day TEXT NOT NULL,
    last_boot_day TEXT NOT NULL,
    unused_boot_days INTEGER NOT NULL DEFAULT 0,
    budget INTEGER NOT NULL DEFAULT 7
);

CREATE INDEX IF NOT EXISTS idx_node_usage_package ON node_usage(package);
CREATE INDEX IF NOT EXISTS idx_prompt_log_timestamp ON prompt_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_model_usage_type ON model_usage(model_type);
"""


# Packages excluded from stats (management/meta tools, not real workflow nodes)
# Compared case-insensitively since directory names vary by how users clone/symlink
EXCLUDED_PACKAGES = {
    "comfyui-manager",
    "comfyui-nodes-stats",
}


DEFAULT_TRIAL_BUDGET = 7


def _classify_age(timestamp, one_month_ago, two_months_ago, recent_status):
    """Classify an ISO timestamp into a removal tier.

    Shared by node-package and model classification so both age the same way.

    timestamp: ISO string of the relevant activity — last_seen for items that
        have been used, or the tracking start time for never-used items. A
        None timestamp is treated as recent (not enough history to judge).
    recent_status: status to return when the timestamp is recent — "used" for
        items with recorded usage, "unused_new" for never-used items.
    """
    if timestamp is None:
        return recent_status
    if timestamp < two_months_ago:
        return "safe_to_remove"
    if timestamp < one_month_ago:
        return "consider_removing"
    return recent_status


class UsageTracker:
    def __init__(self, db_path=DB_PATH):
        self._db_path = db_path
        self._lock = threading.Lock()
        self._initialized = False

    def _ensure_db(self):
        """Create tables on first use. Called under self._lock."""
        if self._initialized:
            return
        self._migrate_old_db()
        conn = sqlite3.connect(self._db_path)
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()
        self._initialized = True

    def _migrate_old_db(self):
        """Move DB from old extension-local path to the new user directory."""
        if self._db_path == _OLD_DB_PATH:
            return
        if not os.path.exists(_OLD_DB_PATH):
            return
        if os.path.exists(self._db_path):
            # New location already has data, skip migration
            return
        try:
            import shutil
            shutil.move(_OLD_DB_PATH, self._db_path)
            logger.info("nodes-stats: migrated DB to %s", self._db_path)
        except Exception:
            logger.warning("nodes-stats: failed to migrate old DB", exc_info=True)

    def _connect(self):
        return sqlite3.connect(self._db_path)

    def record_usage(self, class_types, mapper):
        """Record usage of a set of class_types from a single prompt execution."""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                for ct in class_types:
                    package = mapper.get_package(ct)
                    conn.execute(
                        """INSERT INTO node_usage (class_type, package, count, first_seen, last_seen)
                           VALUES (?, ?, 1, ?, ?)
                           ON CONFLICT(class_type) DO UPDATE SET
                               count = count + 1,
                               last_seen = excluded.last_seen""",
                        (ct, package, now, now),
                    )
                conn.execute(
                    "INSERT INTO prompt_log (timestamp, class_types) VALUES (?, ?)",
                    (now, json.dumps(list(class_types))),
                )
                conn.commit()
            finally:
                conn.close()

    def record_model_usage(self, models):
        """Record usage of model files from a single prompt.

        models: list of (model_name, model_type) tuples
        """
        if not models:
            return
        now = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                for model_name, model_type in models:
                    conn.execute(
                        """INSERT INTO model_usage (model_name, model_type, count, first_seen, last_seen)
                           VALUES (?, ?, 1, ?, ?)
                           ON CONFLICT(model_name) DO UPDATE SET
                               count = count + 1,
                               last_seen = excluded.last_seen,
                               model_type = excluded.model_type""",
                        (model_name, model_type, now, now),
                    )
                conn.commit()
            finally:
                conn.close()

    def get_raw_model_stats(self):
        """Return raw per-model usage rows from DB."""
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT model_name, model_type, count, first_seen, last_seen "
                    "FROM model_usage ORDER BY count DESC"
                ).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()

    def get_node_stats(self):
        """Return raw per-node usage data."""
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT class_type, package, count, first_seen, last_seen FROM node_usage ORDER BY count DESC"
                ).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()

    def get_package_stats(self, mapper):
        """Aggregate per-package stats combining DB data with known nodes."""
        node_stats = self.get_node_stats()

        # Build per-package data from DB
        packages = {}
        for row in node_stats:
            pkg = row["package"]
            if pkg not in packages:
                packages[pkg] = {
                    "package": pkg,
                    "total_executions": 0,
                    "used_nodes": 0,
                    "nodes": [],
                    "last_seen": None,
                }
            entry = packages[pkg]
            entry["total_executions"] += row["count"]
            entry["used_nodes"] += 1
            entry["nodes"].append(row)
            if entry["last_seen"] is None or row["last_seen"] > entry["last_seen"]:
                entry["last_seen"] = row["last_seen"]

        # Count total registered nodes per package from mapper
        node_counts = {}
        for ct, pkg in mapper.mapping.items():
            node_counts.setdefault(pkg, 0)
            node_counts[pkg] += 1

        # Also include zero-node packages from LOADED_MODULE_DIRS
        for pkg in mapper.get_all_packages():
            if pkg not in node_counts:
                node_counts[pkg] = 0

        # Merge: ensure every known package appears
        for pkg, total in node_counts.items():
            if pkg not in packages:
                packages[pkg] = {
                    "package": pkg,
                    "total_executions": 0,
                    "used_nodes": 0,
                    "nodes": [],
                    "last_seen": None,
                }
            packages[pkg]["total_nodes"] = total

        # Packages only in DB (not in mapper) are uninstalled/disabled
        # node_counts already includes all packages from mapper + get_all_packages()
        installed_packages = set(node_counts.keys())
        for pkg, entry in packages.items():
            if "total_nodes" not in entry:
                entry["total_nodes"] = entry["used_nodes"]
            entry["installed"] = pkg in installed_packages

        # Classify packages by usage recency
        now = datetime.now(timezone.utc)
        one_month_ago = (now - timedelta(days=30)).isoformat()
        two_months_ago = (now - timedelta(days=60)).isoformat()
        tracking_start = self._get_first_prompt_time()

        for entry in packages.values():
            if not entry["installed"]:
                entry["status"] = "uninstalled"
            elif entry["total_executions"] > 0:
                # Used packages: classify by last_seen recency
                entry["status"] = _classify_age(
                    entry["last_seen"], one_month_ago, two_months_ago, "used"
                )
            else:
                # Never-used packages: classify by how long we've been tracking
                entry["status"] = _classify_age(
                    tracking_start, one_month_ago, two_months_ago, "unused_new"
                )

        result = [p for p in packages.values() if p["package"].lower() not in EXCLUDED_PACKAGES]
        result.sort(key=lambda p: p["total_executions"])
        return result

    def get_model_stats(self, installed_by_type):
        """Return per-type grouped model stats with tier classification.

        installed_by_type: {model_type: [model_name, ...]} from ModelMapper
        """
        db_rows = self.get_raw_model_stats()
        db_models = {r["model_name"]: r for r in db_rows}

        now = datetime.now(timezone.utc)
        one_month_ago = (now - timedelta(days=30)).isoformat()
        two_months_ago = (now - timedelta(days=60)).isoformat()
        tracking_start = self._get_first_prompt_time()

        STATUS_ORDER = {
            "safe_to_remove": 0,
            "consider_removing": 1,
            "unused_new": 2,
            "used": 3,
            "uninstalled": 4,
        }

        result_by_type = {}

        # Process installed models
        for model_type, filenames in installed_by_type.items():
            entries = []
            for model_name in filenames:
                if model_name in db_models:
                    row = db_models[model_name]
                    last_seen = row["last_seen"]
                    status = _classify_age(
                        last_seen, one_month_ago, two_months_ago, "used"
                    )
                    entry = {
                        "model_name": model_name,
                        "model_type": model_type,
                        "count": row["count"],
                        "first_seen": row["first_seen"],
                        "last_seen": last_seen,
                        "installed": True,
                        "status": status,
                    }
                else:
                    status = _classify_age(
                        tracking_start, one_month_ago, two_months_ago, "unused_new"
                    )
                    entry = {
                        "model_name": model_name,
                        "model_type": model_type,
                        "count": 0,
                        "first_seen": None,
                        "last_seen": None,
                        "installed": True,
                        "status": status,
                    }
                entries.append(entry)
            result_by_type[model_type] = entries

        # Add uninstalled (in DB but not on disk)
        installed_names = {
            name for names in installed_by_type.values() for name in names
        }
        for model_name, row in db_models.items():
            if model_name not in installed_names:
                model_type = row["model_type"]
                result_by_type.setdefault(model_type, []).append({
                    "model_name": model_name,
                    "model_type": model_type,
                    "count": row["count"],
                    "first_seen": row["first_seen"],
                    "last_seen": row["last_seen"],
                    "installed": False,
                    "status": "uninstalled",
                })

        # Sort each type's models by status tier then name
        result = []
        for model_type in sorted(result_by_type):
            models = result_by_type[model_type]
            models.sort(key=lambda m: (STATUS_ORDER.get(m["status"], 5), m["model_name"]))
            result.append({"model_type": model_type, "models": models})

        return result

    def _get_first_prompt_time(self):
        """Return the timestamp of the earliest recorded prompt, or None."""
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT MIN(timestamp) FROM prompt_log"
                ).fetchone()
                return row[0] if row and row[0] else None
            finally:
                conn.close()

    def start_trial(self, package, budget=DEFAULT_TRIAL_BUDGET):
        """Begin/restart a temporary-enable trial. The enable day is not counted."""
        now = datetime.now(timezone.utc)
        today = now.date().isoformat()
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                conn.execute(
                    """INSERT INTO trial_packages
                       (package, enabled_at, last_use_day, last_boot_day, unused_boot_days, budget)
                       VALUES (?, ?, ?, ?, 0, ?)
                       ON CONFLICT(package) DO UPDATE SET
                           enabled_at = excluded.enabled_at,
                           last_use_day = excluded.last_use_day,
                           last_boot_day = excluded.last_boot_day,
                           unused_boot_days = 0,
                           budget = excluded.budget""",
                    (package, now.isoformat(), today, today, budget),
                )
                conn.commit()
            finally:
                conn.close()

    def get_trials(self):
        """Return trial rows with computed days_remaining/expired."""
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT package, enabled_at, last_use_day, last_boot_day, "
                    "unused_boot_days, budget FROM trial_packages"
                ).fetchall()
            finally:
                conn.close()
        result = []
        for r in rows:
            d = dict(r)
            d["days_remaining"] = max(0, d["budget"] - d["unused_boot_days"])
            d["expired"] = d["unused_boot_days"] >= d["budget"]
            result.append(d)
        return result

    def reset(self):
        """Clear all tracked data."""
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                conn.execute("DELETE FROM node_usage")
                conn.execute("DELETE FROM prompt_log")
                conn.execute("DELETE FROM model_usage")
                conn.commit()
            finally:
                conn.close()
