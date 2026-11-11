"""Reading zones and writing NDVI results (tables: server/src/bridge/ndviSchema.sql)."""
import json
from datetime import datetime, timedelta, timezone

import psycopg

from . import config


def connect(url=None):
    return psycopg.connect(url or config.PG_URL, autocommit=False)


# The newest columns this worker writes (ndviSchema.sql): the tables are ready only once the
# bridge has added them - on an update both containers start together and the bridge may be later.
NEWEST_COLUMNS = (("ndvi_history", "ndmi_usable"), ("ndvi_maps", "png_water"), ("ndvi_status", "weather_at"))


def tables_ready(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.ndvi_zones') IS NOT NULL AND to_regclass('public.ndvi_status') IS NOT NULL")
        ok = cur.fetchone()[0]
        if ok:
            cur.execute("""SELECT count(*) FROM information_schema.columns
                            WHERE table_schema = 'public' AND (table_name, column_name) IN (%s)"""
                        % ", ".join(["(%s, %s)"] * len(NEWEST_COLUMNS)),
                        [x for pair in NEWEST_COLUMNS for x in pair])
            ok = cur.fetchone()[0] == len(NEWEST_COLUMNS)
    conn.rollback()
    return bool(ok)


def farm_zones(conn, farm_id):
    """{valve: points} for a farm's mapped valves."""
    with conn.cursor() as cur:
        cur.execute("SELECT valve, points FROM ndvi_zones WHERE farm_id = %s ORDER BY valve", (farm_id,))
        rows = cur.fetchall()
    conn.rollback()
    return {int(v): pts for v, pts in rows}


def farms_due(conn, check_hours, now=None):
    """Farms with zones whose last check is older than [check_hours], or that asked for a refresh."""
    now = now or datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT z.farm_id
                 FROM (SELECT DISTINCT farm_id FROM ndvi_zones) z
                 LEFT JOIN ndvi_status s ON s.farm_id = z.farm_id
                WHERE s.farm_id IS NULL OR s.last_check_at IS NULL
                   OR s.refresh_requested IS NOT NULL
                   OR s.last_check_at < %s
                ORDER BY s.refresh_requested NULLS LAST, s.last_check_at NULLS FIRST""",
            (now - timedelta(hours=check_hours),))
        rows = [r[0] for r in cur.fetchall()]
    conn.rollback()
    return rows


def processed_scene_ids(conn, farm_id):
    with conn.cursor() as cur:
        cur.execute("SELECT scene_id FROM ndvi_farm_scenes WHERE farm_id = %s AND status <> 'error'", (farm_id,))
        ids = {r[0] for r in cur.fetchall()}
    conn.rollback()
    return ids


def search_start(conn, farm_id, backfill_days, now=None):
    """Search from the farm's newest processed image (less a little, for late
    catalogue entries), or [backfill_days] back for a farm never processed."""
    now = now or datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute("""SELECT max(sc.acquired_at) FROM ndvi_farm_scenes fs
                         JOIN ndvi_scenes sc USING (scene_id) WHERE fs.farm_id = %s""", (farm_id,))
        last = cur.fetchone()[0]
    conn.rollback()
    if last is None:
        return now - timedelta(days=backfill_days)
    return max(last - timedelta(days=10), now - timedelta(days=backfill_days))


def save_scene_result(conn, farm_id, scene, status, clear_pct, zone_stats=None, png=None, bounds=None, error=None,
                      png_water=None):
    """One image's outcome for one farm, in one transaction."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO ndvi_scenes (scene_id, tile, acquired_at, cloud_cover) VALUES (%s, %s, %s, %s)
                           ON CONFLICT (scene_id) DO NOTHING""",
                        (scene.id, scene.tile, scene.acquired_at, scene.cloud_cover))
            cur.execute("""INSERT INTO ndvi_farm_scenes (farm_id, scene_id, status, clear_pct, error, processed_at)
                           VALUES (%s, %s, %s, %s, %s, now())
                           ON CONFLICT (farm_id, scene_id) DO UPDATE SET status = EXCLUDED.status,
                             clear_pct = EXCLUDED.clear_pct, error = EXCLUDED.error, processed_at = now()""",
                        (farm_id, scene.id, status, clear_pct, error))
            for valve, st in (zone_stats or {}).items():
                if not st["in_swath"] or st["pixels"] == 0:
                    continue
                cur.execute(
                    """INSERT INTO ndvi_history (farm_id, valve, scene_id, acquired_at, mean, min, max, p10, p90, std,
                                                 pixels, valid_pixels, valid_pct, usable, median, weak_spots, weak_pct,
                                                 ndmi_mean, ndmi_p10, ndmi_median, ndmi_veg_pct, ndmi_usable,
                                                 dry_spots, dry_pct)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s,
                               %s, %s, %s, %s, %s, %s::jsonb, %s)
                       ON CONFLICT (farm_id, valve, scene_id) DO UPDATE SET mean = EXCLUDED.mean, min = EXCLUDED.min,
                         max = EXCLUDED.max, p10 = EXCLUDED.p10, p90 = EXCLUDED.p90, std = EXCLUDED.std,
                         pixels = EXCLUDED.pixels, valid_pixels = EXCLUDED.valid_pixels,
                         valid_pct = EXCLUDED.valid_pct, usable = EXCLUDED.usable, median = EXCLUDED.median,
                         weak_spots = EXCLUDED.weak_spots, weak_pct = EXCLUDED.weak_pct,
                         ndmi_mean = EXCLUDED.ndmi_mean, ndmi_p10 = EXCLUDED.ndmi_p10, ndmi_median = EXCLUDED.ndmi_median,
                         ndmi_veg_pct = EXCLUDED.ndmi_veg_pct, ndmi_usable = EXCLUDED.ndmi_usable,
                         dry_spots = EXCLUDED.dry_spots, dry_pct = EXCLUDED.dry_pct""",
                    (farm_id, valve, scene.id, scene.acquired_at, st["mean"], st["min"], st["max"], st["p10"],
                     st["p90"], st["std"], st["pixels"], st["valid_pixels"], st["valid_pct"], st["usable"],
                     st.get("median"), json.dumps(st.get("weak_spots") or []), st.get("weak_pct") or 0.0,
                     st.get("ndmi_mean"), st.get("ndmi_p10"), st.get("ndmi_median"), st.get("ndmi_veg_pct"),
                     bool(st.get("ndmi_usable")), json.dumps(st.get("dry_spots") or []), st.get("dry_pct") or 0.0))
            if png is not None and bounds is not None:
                w, s, e, n = bounds
                cur.execute("""INSERT INTO ndvi_maps (farm_id, scene_id, acquired_at, west, south, east, north, png, png_water)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                               ON CONFLICT (farm_id, scene_id) DO UPDATE SET west = EXCLUDED.west, south = EXCLUDED.south,
                                 east = EXCLUDED.east, north = EXCLUDED.north, png = EXCLUDED.png,
                                 png_water = EXCLUDED.png_water""",
                            (farm_id, scene.id, scene.acquired_at, w, s, e, n, png, png_water))
                cur.execute("""DELETE FROM ndvi_maps WHERE farm_id = %s AND scene_id NOT IN (
                                 SELECT scene_id FROM ndvi_maps WHERE farm_id = %s ORDER BY acquired_at DESC LIMIT %s)""",
                            (farm_id, farm_id, config.KEEP_MAPS))
            if status == "ok":
                cur.execute("""INSERT INTO ndvi_status (farm_id, last_success_at, last_obs_at) VALUES (%s, now(), %s)
                               ON CONFLICT (farm_id) DO UPDATE SET last_success_at = now(),
                                 last_obs_at = GREATEST(ndvi_status.last_obs_at, EXCLUDED.last_obs_at)""",
                            (farm_id, scene.acquired_at))


def mark_checked(conn, farm_id, requested_before, error=None):
    """The catalogue search for a farm is done (clears a refresh asked before it started)."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO ndvi_status (farm_id, last_check_at, last_error, last_error_at)
                   VALUES (%s, now(), %s, CASE WHEN %s::text IS NULL THEN NULL ELSE now() END)
                   ON CONFLICT (farm_id) DO UPDATE SET last_check_at = now(),
                     last_error = EXCLUDED.last_error,
                     last_error_at = COALESCE(EXCLUDED.last_error_at, ndvi_status.last_error_at),
                     refresh_requested = CASE WHEN ndvi_status.refresh_requested <= %s THEN NULL
                                              ELSE ndvi_status.refresh_requested END""",
                (farm_id, error, error, requested_before))


def farms_missing_water(conn, within_days, now=None):
    """Farms with a usable image in the last [within_days] days that was read before leaf
    moisture existed (ndmi_usable not set) - those images are read again once."""
    now = now or datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute("""SELECT DISTINCT farm_id FROM ndvi_history
                        WHERE usable AND ndmi_usable IS NULL AND acquired_at >= %s""",
                    (now - timedelta(days=within_days),))
        rows = [r[0] for r in cur.fetchall()]
    conn.rollback()
    return rows


def farms_with_zones(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT farm_id FROM ndvi_zones ORDER BY farm_id")
        rows = [r[0] for r in cur.fetchall()]
    conn.rollback()
    return rows


def weather_due(conn, farm_id, hours, now=None):
    now = now or datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute("SELECT weather_at FROM ndvi_status WHERE farm_id = %s", (farm_id,))
        row = cur.fetchone()
    conn.rollback()
    return row is None or row[0] is None or row[0] < now - timedelta(hours=hours)


def mark_weather(conn, farm_id, at, error=None):
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO ndvi_status (farm_id, weather_at, weather_error) VALUES (%s, %s, %s)
                           ON CONFLICT (farm_id) DO UPDATE SET weather_at = EXCLUDED.weather_at,
                             weather_error = EXCLUDED.weather_error""", (farm_id, at, error))


def save_weather(conn, farm_id, days, at):
    """Upsert daily weather rows, and note the fetch."""
    with conn.transaction():
        with conn.cursor() as cur:
            for d in days:
                cur.execute("""INSERT INTO ndvi_weather (farm_id, day, rain_mm, et0_mm, tmax, tmin, rh, wind, rs, rs_estimated, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                               ON CONFLICT (farm_id, day) DO UPDATE SET rain_mm = EXCLUDED.rain_mm, et0_mm = EXCLUDED.et0_mm,
                                 tmax = EXCLUDED.tmax, tmin = EXCLUDED.tmin, rh = EXCLUDED.rh, wind = EXCLUDED.wind,
                                 rs = EXCLUDED.rs, rs_estimated = EXCLUDED.rs_estimated, fetched_at = EXCLUDED.fetched_at""",
                            (farm_id, d["day"], d["rain_mm"], d["et0_mm"], d["tmax"], d["tmin"], d["rh"], d["wind"],
                             d["rs"], d["rs_estimated"], at))
            cur.execute("""INSERT INTO ndvi_status (farm_id, weather_at, weather_error) VALUES (%s, %s, NULL)
                           ON CONFLICT (farm_id) DO UPDATE SET weather_at = EXCLUDED.weather_at, weather_error = NULL""",
                        (farm_id, at))


def forget_farm_images(conn, farm_id):
    """Make the next check re-read every image for the farm (e.g. after the worker learns something new)."""
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("DELETE FROM ndvi_farm_scenes WHERE farm_id = %s", (farm_id,))
            # ...and check it in the next round, not at its next scheduled check (hours away).
            cur.execute("""INSERT INTO ndvi_status (farm_id, refresh_requested) VALUES (%s, now())
                           ON CONFLICT (farm_id) DO UPDATE SET refresh_requested = now()""", (farm_id,))
