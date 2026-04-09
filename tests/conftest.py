# tests/conftest.py
import sys
import os
from unittest.mock import MagicMock

# Put the project root on sys.path so tests can import tracker, mapper directly
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub ComfyUI-only modules before any test file imports project code
for mod in ("folder_paths", "nodes", "server", "folder_paths.folder_names_and_paths"):
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()
