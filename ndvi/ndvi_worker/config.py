"""Settings, all from the environment (the bridge's own server/.env is reused,
so the worker needs no new secret)."""
import os


def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


# Same database as the bridge (farmbuddie_bridge); the bridge creates the
# NDVI tables at its start (server/src/bridge/ndviSchema.sql).
PG_URL = os.environ.get("NDVI_PG_CONNECTION_STRING") or os.environ.get("BRIDGE_PG_CONNECTION_STRING", "")

# Copernicus Sentinel-2 Level-2A, as the free, public cloud-optimised GeoTIFF
# copy on AWS Open Data (Element 84 Earth Search; no account, no key). The
# "c1" collection is ESA's Collection-1 reprocessing: one consistent
# processing baseline, scale/offset given per band.
STAC_URL = os.environ.get("NDVI_STAC_URL", "https://earth-search.aws.element84.com/v1")
STAC_COLLECTION = os.environ.get("NDVI_STAC_COLLECTION", "sentinel-2-c1-l2a")

# How often every farm is checked for new images (hours). A farm whose zones
# just changed is checked within a minute or two instead.
CHECK_HOURS = _float("NDVI_CHECK_HOURS", 6)
# First check of a farm looks this far back, to give it a history at once.
BACKFILL_DAYS = _int("NDVI_BACKFILL_DAYS", 120)
# Images more cloudy than this over their whole 110 km tile aren't opened at
# all. Kept high on purpose: cloud is judged over the farm itself.
MAX_SCENE_CLOUD = _float("NDVI_MAX_SCENE_CLOUD", 95)
# A zone's reading counts only when at least this % of its pixels are clear.
MIN_CLEAR_PCT = _float("NDVI_MIN_CLEAR_PCT", 60)
# Heatmaps kept per farm (newest first); the numbers are kept for good.
KEEP_MAPS = _int("NDVI_KEEP_MAPS", 12)
POLL_SECONDS = _int("NDVI_POLL_SECONDS", 60)
