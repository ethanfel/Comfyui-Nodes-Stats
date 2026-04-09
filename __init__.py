import logging
import threading

from aiohttp import web
from server import PromptServer

from .mapper import NodePackageMapper, ModelMapper
from .tracker import UsageTracker

logger = logging.getLogger(__name__)

NODE_CLASS_MAPPINGS = {}
WEB_DIRECTORY = "./js"

mapper = NodePackageMapper()
tracker = UsageTracker()
model_mapper = ModelMapper()


def on_prompt_handler(json_data):
    """Called on every prompt submission. Extracts class_types and queues recording."""
    try:
        prompt = json_data.get("prompt", {})
        class_types = set()
        for node_id, node_data in prompt.items():
            ct = node_data.get("class_type")
            if ct:
                class_types.add(ct)
        if class_types:
            # Pass the full prompt to the thread — model extraction (which calls
            # INPUT_TYPES() on every node) happens off the main request thread.
            threading.Thread(
                target=_record_prompt,
                args=(class_types, prompt),
                daemon=True,
            ).start()
    except Exception:
        logger.warning("nodes-stats: error recording usage", exc_info=True)
    return json_data


def _record_prompt(class_types, prompt):
    try:
        tracker.record_usage(class_types, mapper)
    except Exception:
        logger.warning("nodes-stats: error recording node usage", exc_info=True)
    try:
        models = model_mapper.extract_models_from_prompt(prompt)
        if models:
            tracker.record_model_usage(models)
    except Exception:
        logger.warning("nodes-stats: error recording model usage", exc_info=True)


PromptServer.instance.add_on_prompt_handler(on_prompt_handler)


routes = PromptServer.instance.routes


@routes.get("/nodes-stats/packages")
async def get_package_stats(request):
    try:
        stats = tracker.get_package_stats(mapper)
        return web.json_response(stats)
    except Exception:
        logger.error("nodes-stats: error getting package stats", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)


@routes.get("/nodes-stats/usage")
async def get_node_stats(request):
    try:
        stats = tracker.get_node_stats()
        return web.json_response(stats)
    except Exception:
        logger.error("nodes-stats: error getting node stats", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)


@routes.get("/nodes-stats/models")
async def get_model_stats(request):
    try:
        installed_by_type = model_mapper.get_all_models()
        stats = tracker.get_model_stats(installed_by_type)
        return web.json_response(stats)
    except Exception:
        logger.error("nodes-stats: error getting model stats", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)


@routes.post("/nodes-stats/reset")
async def reset_stats(request):
    try:
        tracker.reset()
        mapper.invalidate()
        model_mapper.invalidate()
        return web.json_response({"status": "ok"})
    except Exception:
        logger.error("nodes-stats: error resetting stats", exc_info=True)
        return web.json_response({"error": "internal error"}, status=500)
