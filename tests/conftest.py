# tests/conftest.py
import sys
import os
from unittest.mock import MagicMock

# Put the project root on sys.path so tests can import tracker, mapper directly
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub ComfyUI-only modules before any test file imports project code
_folder_paths_mock = MagicMock()
_folder_paths_mock.get_user_directory.return_value = "/tmp"
sys.modules["folder_paths"] = _folder_paths_mock
for mod in ("nodes", "server"):
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()
