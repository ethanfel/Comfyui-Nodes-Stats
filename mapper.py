import logging
import os

logger = logging.getLogger(__name__)


class NodePackageMapper:
    """Maps node class_type names to their source package."""

    def __init__(self):
        self._map = None

    def _build_map(self):
        import nodes

        self._map = {}
        for class_type, node_cls in nodes.NODE_CLASS_MAPPINGS.items():
            module = getattr(node_cls, "RELATIVE_PYTHON_MODULE", None)
            if module:
                # "custom_nodes.PackageName" -> "PackageName"
                # "comfy_extras.nodes_xyz" -> "__builtin__"
                # "comfy_api_nodes.xyz" -> "__builtin__"
                parts = module.split(".")
                if parts[0] == "custom_nodes" and len(parts) > 1:
                    self._map[class_type] = parts[1]
                else:
                    self._map[class_type] = "__builtin__"
            else:
                self._map[class_type] = "__builtin__"

    @property
    def mapping(self):
        if self._map is None:
            self._build_map()
        return self._map

    def get_package(self, class_type):
        return self.mapping.get(class_type, "__unknown__")

    def get_all_packages(self):
        """Return set of all known package names, including zero-node packages."""
        packages = set(self.mapping.values())

        try:
            import nodes
            import folder_paths

            # Get all custom_nodes directories to filter LOADED_MODULE_DIRS
            custom_node_dirs = set()
            for d in folder_paths.get_folder_paths("custom_nodes"):
                custom_node_dirs.add(os.path.normpath(d))

            # LOADED_MODULE_DIRS contains ALL modules (custom nodes, comfy_extras,
            # comfy_api_nodes). We only want custom node packages, identified by
            # their directory being directly inside a custom_nodes directory.
            for module_name, module_dir in nodes.LOADED_MODULE_DIRS.items():
                parent_dir = os.path.normpath(os.path.dirname(module_dir))
                if parent_dir in custom_node_dirs:
                    packages.add(os.path.basename(module_dir))
        except Exception:
            logger.warning("Could not read LOADED_MODULE_DIRS", exc_info=True)

        packages.discard("__builtin__")
        return packages

    def invalidate(self):
        """Force rebuild on next access (e.g. after node reload)."""
        self._map = None


# Folder types that are not model files and should not be tracked
EXCLUDED_FOLDER_TYPES = {
    "loras",
    "configs",
    "custom_nodes",
    "temp",
    "output",
    "input",
    "annotators",
    "assets",
}


class ModelMapper:
    """Tracks which folder_paths model types exist and resolves filenames to types."""

    def __init__(self):
        self._folder_files = None   # {folder_type: frozenset(filenames)}
        self._reverse = None        # {filename: folder_type}

    def _build(self):
        try:
            import folder_paths

            self._folder_files = {}
            for folder_type in folder_paths.folder_names_and_paths:
                if folder_type in EXCLUDED_FOLDER_TYPES:
                    continue
                try:
                    files = folder_paths.get_filename_list(folder_type)
                except Exception:
                    files = []
                if files:
                    self._folder_files[folder_type] = frozenset(files)

            # Reverse map: filename -> folder_type (last write wins on collision)
            self._reverse = {}
            for folder_type, files in self._folder_files.items():
                for f in files:
                    self._reverse[f] = folder_type

        except Exception:
            logger.warning("ModelMapper: failed to build model map", exc_info=True)
            self._folder_files = {}
            self._reverse = {}

    def _ensure(self):
        if self._folder_files is None:
            self._build()

    def get_model_type(self, filename):
        """Return the folder type for a filename, or None if not tracked."""
        self._ensure()
        return self._reverse.get(filename)

    def get_all_models(self):
        """Return {folder_type: [filename, ...]} for all tracked types."""
        self._ensure()
        return {k: sorted(v) for k, v in self._folder_files.items()}

    def extract_models_from_prompt(self, prompt):
        """Scan a prompt dict and return (model_name, model_type) pairs.

        For each node, inspects INPUT_TYPES() to find list-type (folder dropdown)
        inputs, then resolves the selected value against the folder_paths reverse map.
        """
        self._ensure()
        try:
            import nodes as comfy_nodes
        except ImportError:
            return []

        seen = set()
        results = []

        for node_data in prompt.values():
            class_type = node_data.get("class_type")
            node_inputs = node_data.get("inputs", {})
            if not class_type or not node_inputs:
                continue

            node_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
            if node_cls is None:
                continue

            try:
                input_types = node_cls.INPUT_TYPES()
            except Exception:
                continue

            for category in ("required", "optional"):
                for input_name, input_def in input_types.get(category, {}).items():
                    if not isinstance(input_def, (list, tuple)) or not input_def:
                        continue
                    # ComfyUI folder dropdowns have a list as their type
                    if not isinstance(input_def[0], list):
                        continue
                    value = node_inputs.get(input_name)
                    if not isinstance(value, str) or value in seen:
                        continue
                    model_type = self.get_model_type(value)
                    if model_type:
                        seen.add(value)
                        results.append((value, model_type))

        return results

    def invalidate(self):
        """Force rebuild on next access."""
        self._folder_files = None
        self._reverse = None
