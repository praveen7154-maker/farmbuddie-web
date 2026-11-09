"""Checking each mapped farm for new Sentinel-2 images and processing them."""
import logging
import time
from datetime import datetime, timezone

from . import config, raster, render, stac, store

log = logging.getLogger("ndvi")


def zones_lonlat(points_by_valve):
    """{valve: points} -> {valve: lon/lat polygon}, skipping valves with no area (pin / line)."""
    out = {}
    for valve, pts in points_by_valve.items():
        poly = raster.zone_polygon(pts)
        if poly is not None:
            out[valve] = poly
    return out


def classify(per_zone, farm):
    """An image's outcome for the farm: ok / cloudy / no_data."""
    if not farm["in_swath"]:
        return "no_data"
    if any(z["usable"] for z in per_zone.values()):
        return "ok"
    return "cloudy"


def process_scene(conn, farm_id, scene, zones, read=raster.read_farm, min_clear_pct=None):
    min_clear = config.MIN_CLEAR_PCT if min_clear_pct is None else min_clear_pct
    try:
        fr = read(scene, zones)
        per_zone, farm = raster.analyse(fr, min_clear)
        status = classify(per_zone, farm)
        png = bounds = None
        if status == "ok":
            png, bounds = render.render(fr)
        store.save_scene_result(conn, farm_id, scene, status, farm["clear_pct"],
                                per_zone if status != "no_data" else None, png, bounds)
        log.info("farm %s %s %s: %s, clear %.0f%%", farm_id, scene.id, scene.acquired_at.date(), status,
                 farm["clear_pct"])
        return status
    except Exception as e:  # noqa: BLE001 - one bad image mustn't stop the rest
        conn.rollback()
        log.warning("farm %s %s: %s", farm_id, scene.id, e)
        store.save_scene_result(conn, farm_id, scene, "error", None, error=str(e)[:500])
        return "error"


def check_farm(conn, farm_id, search=stac.search, read=raster.read_farm, now=None, backfill_days=None):
    """Search for images the farm hasn't seen yet and process them, oldest first."""
    now = now or datetime.now(timezone.utc)
    started = now
    zones = zones_lonlat(store.farm_zones(conn, farm_id))
    if not zones:
        store.mark_checked(conn, farm_id, started, error="no valve zone with 3 or more points")
        return {}
    try:
        start = store.search_start(conn, farm_id, backfill_days or config.BACKFILL_DAYS, now)
        scenes = search(raster.bbox_lonlat(zones), start, now)
    except Exception as e:  # noqa: BLE001 - catalogue down: try again next round
        conn.rollback()
        log.warning("farm %s: search failed: %s", farm_id, e)
        store.mark_checked(conn, farm_id, started, error=f"search failed: {e}"[:500])
        return {}
    done = store.processed_scene_ids(conn, farm_id)
    results = {}
    for scene in scenes:
        if scene.id in done:
            continue
        results[scene.id] = process_scene(conn, farm_id, scene, zones, read=read)
    store.mark_checked(conn, farm_id, started)
    return results


def run_forever():
    conn = store.connect()
    while not store.tables_ready(conn):
        log.info("waiting for the bridge to create the NDVI tables")
        time.sleep(30)
    log.info("NDVI worker started: check every %.1f h, backfill %d days", config.CHECK_HOURS, config.BACKFILL_DAYS)
    while True:
        try:
            for farm_id in store.farms_due(conn, config.CHECK_HOURS):
                check_farm(conn, farm_id)
        except Exception as e:  # noqa: BLE001 - e.g. the database restarted
            log.warning("round failed: %s", e)
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            time.sleep(30)
            conn = store.connect()
        time.sleep(config.POLL_SECONDS)
