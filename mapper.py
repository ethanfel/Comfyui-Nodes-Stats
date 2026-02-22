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
                parts = module.split(".", 1)
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
