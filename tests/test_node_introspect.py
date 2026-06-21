import os
import sys
from unittest.mock import MagicMock

import node_introspect as ni


_SAMPLE = '''
import folder_paths


class MyCoolNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model": ("MODEL",),
                "strength": ("FLOAT", {"default": 1.5, "min": 0.0}),
                "mode": (["fast", "slow"], {"default": "slow"}),
                "ckpt": (folder_paths.get_filename_list("checkpoints"),),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("out_image", "out_latent")
    CATEGORY = "testing/cool"
    FUNCTION = "run"

    def run(self, image, model, strength, mode, ckpt, mask=None):
        return (image, None)


class DynamicNode:
    @classmethod
    def INPUT_TYPES(cls):
        d = {"required": {}}
        return d
    RETURN_TYPES = ("STRING",)


NODE_CLASS_MAPPINGS = {"My Cool Node": MyCoolNode}
NODE_CLASS_MAPPINGS.update({"Dynamic": DynamicNode})
NODE_DISPLAY_NAME_MAPPINGS = {"My Cool Node": "My Cool Node ✨"}
'''


def _write_pack(tmp_path, body=_SAMPLE, name="nodes.py"):
    ni._INDEX_CACHE.clear()
    f = tmp_path / name
    f.write_text(body)
    return str(tmp_path)


def test_inputs_sockets_widgets_and_defaults(tmp_path):
    pack = _write_pack(tmp_path)
    s = ni.get_node_schema("My Cool Node", pack)
    assert s["parseable"] is True
    assert s["display_name"] == "My Cool Node ✨"
    assert s["category"] == "testing/cool"
    by = {i["name"]: i for i in s["inputs"]}

    # custom types are sockets
    assert by["image"]["type"] == "IMAGE" and by["image"]["widget"] is False
    assert by["model"]["type"] == "MODEL" and by["model"]["widget"] is False
    # primitives + combos are widgets, with defaults
    assert by["strength"]["widget"] is True and by["strength"]["default"] == 1.5
    assert by["mode"]["type"] == "COMBO" and by["mode"]["options"] == ["fast", "slow"]
    assert by["mode"]["default"] == "slow"
    # folder_paths.get_filename_list(...) -> dynamic combo widget, options unknown
    assert by["ckpt"]["type"] == "COMBO" and by["ckpt"]["widget"] is True
    assert by["ckpt"]["options"] is None
    # optional inputs are flagged
    assert by["mask"]["required"] is False and by["image"]["required"] is True


def test_outputs_use_return_names(tmp_path):
    pack = _write_pack(tmp_path)
    s = ni.get_node_schema("My Cool Node", pack)
    assert [(o["name"], o["type"]) for o in s["outputs"]] == [
        ("out_image", "IMAGE"),
        ("out_latent", "LATENT"),
    ]


def test_mapping_update_call_is_merged(tmp_path):
    pack = _write_pack(tmp_path)
    s = ni.get_node_schema("Dynamic", pack)
    assert s["parseable"] is True
    assert s["outputs"] == [{"name": "STRING", "type": "STRING"}]
    assert s["inputs"] == []


def test_unknown_class_type_not_parseable(tmp_path):
    pack = _write_pack(tmp_path)
    s = ni.get_node_schema("Nope", pack)
    assert s["parseable"] is False
    assert s["reason"] == "dynamic_mapping"


def test_no_mapping_reason(tmp_path):
    pack = _write_pack(tmp_path, body="class A:\n    RETURN_TYPES = ('X',)\n")
    s = ni.get_node_schema("A", pack)
    # class_type falls back to the class name even without NODE_CLASS_MAPPINGS
    assert s["parseable"] is True
    s2 = ni.get_node_schema("Missing", pack)
    assert s2["parseable"] is False and s2["reason"] == "no_mapping"


def test_find_disabled_pack_path_strips_version_and_case(tmp_path, monkeypatch):
    cn = tmp_path / "custom_nodes"
    disabled = cn / ".disabled"
    disabled.mkdir(parents=True)
    (disabled / "ComfyMath@nightly").mkdir()

    fp = MagicMock()
    fp.get_folder_paths.return_value = [str(cn)]
    monkeypatch.setitem(sys.modules, "folder_paths", fp)

    found = ni.find_disabled_pack_path("comfymath")
    assert found == os.path.join(str(disabled), "ComfyMath@nightly")
    assert ni.find_disabled_pack_path("not-there") is None


def test_find_disabled_pack_path_rejects_traversal(tmp_path):
    assert ni.find_disabled_pack_path("../evil") is None
    assert ni.find_disabled_pack_path("a/b") is None
    assert ni.find_disabled_pack_path("") is None
