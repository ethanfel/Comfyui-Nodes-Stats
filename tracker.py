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

CREATE INDEX IF NOT EXISTS idx_node_usage_package ON node_usage(package);
CREATE INDEX IF NOT EXISTS idx_prompt_log_timestamp ON prompt_log(timestamp);
"""


# Packages excluded from stats (management/meta tools, not real workflow nodes)
# Compared case-insensitively since directory names vary by how users clone/symlink
EXCLUDED_PACKAGES = {
    "comfyui-manager",
    "comfyui-nodes-stats",
}


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
                if entry["last_seen"] < two_months_ago:
                    entry["status"] = "safe_to_remove"
                elif entry["last_seen"] < one_month_ago:
                    entry["status"] = "consider_removing"
                else:
                    entry["status"] = "used"
            else:
                # Never-used packages: classify by how long we've been tracking
                if tracking_start is None:
                    entry["status"] = "unused_new"
                elif tracking_start < two_months_ago:
                    entry["status"] = "safe_to_remove"
                elif tracking_start < one_month_ago:
                    entry["status"] = "consider_removing"
                else:
                    entry["status"] = "unused_new"

        result = [p for p in packages.values() if p["package"].lower() not in EXCLUDED_PACKAGES]
        result.sort(key=lambda p: p["total_executions"])
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

    def reset(self):
        """Clear all tracked data."""
        with self._lock:
            self._ensure_db()
            conn = self._connect()
            try:
                conn.execute("DELETE FROM node_usage")
                conn.execute("DELETE FROM prompt_log")
                conn.commit()
            finally:
                conn.close()
