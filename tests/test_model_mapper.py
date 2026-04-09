import pytest
from unittest.mock import patch, MagicMock
from mapper import ModelMapper


FAKE_FOLDER_NAMES = {
    "checkpoints": ([], {}),
    "vae": ([], {}),
    "loras": ([], {}),
    "configs": ([], {}),
}

FAKE_FILES = {
    "checkpoints": ["dream.safetensors", "v15.ckpt"],
    "vae": ["vae.safetensors"],
    "loras": ["style.safetensors"],
}


def _make_mapper():
    # conftest.py already put a MagicMock in sys.modules["folder_paths"],
    # so we can configure it directly here.
    import folder_paths as fp
    fp.folder_names_and_paths = FAKE_FOLDER_NAMES
    fp.get_filename_list.side_effect = lambda t: FAKE_FILES.get(t, [])
    m = ModelMapper()
    m._build()
    return m


def test_get_model_type_known():
    m = _make_mapper()
    assert m.get_model_type("dream.safetensors") == "checkpoints"
    assert m.get_model_type("vae.safetensors") == "vae"


def test_loras_excluded():
    m = _make_mapper()
    assert m.get_model_type("style.safetensors") is None


def test_get_all_models():
    m = _make_mapper()
    all_models = m.get_all_models()
    assert "checkpoints" in all_models
    assert "vae" in all_models
    assert "loras" not in all_models
    assert "dream.safetensors" in all_models["checkpoints"]


def test_unknown_filename_returns_none():
    m = _make_mapper()
    assert m.get_model_type("nonexistent.ckpt") is None


def test_extract_models_from_prompt(monkeypatch):
    m = _make_mapper()

    fake_node_cls = MagicMock()
    fake_node_cls.INPUT_TYPES.return_value = {
        "required": {
            "ckpt_name": (["dream.safetensors", "v15.ckpt"],),
            "steps": ("INT", {"default": 20}),
        }
    }

    fake_prompt = {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "dream.safetensors", "steps": 20},
        }
    }

    import nodes as comfy_nodes
    monkeypatch.setattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {"CheckpointLoaderSimple": fake_node_cls})
    results = m.extract_models_from_prompt(fake_prompt)

    assert ("dream.safetensors", "checkpoints") in results


def test_extract_models_skips_non_list_inputs(monkeypatch):
    m = _make_mapper()

    fake_node_cls = MagicMock()
    fake_node_cls.INPUT_TYPES.return_value = {
        "required": {
            "text": ("STRING", {}),
        }
    }
    fake_prompt = {"1": {"class_type": "CLIPTextEncode", "inputs": {"text": "hello"}}}

    import nodes as comfy_nodes
    monkeypatch.setattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {"CLIPTextEncode": fake_node_cls})
    results = m.extract_models_from_prompt(fake_prompt)

    assert results == []
