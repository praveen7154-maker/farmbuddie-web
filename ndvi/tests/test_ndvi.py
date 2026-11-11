"""NDVI worker tests. Pure ones always run; the database ones need
NDVI_TEST_PG (a database whose name ends in "test"), e.g.
NDVI_TEST_PG=postgres://fbtest:fbtest@127.0.0.1:5432/ndvitest python -m pytest tests
"""
import io
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from pyproj import CRS
from rasterio.transform import from_origin

from ndvi_worker import raster, render, stac, store, weather, worker
from ndvi_worker.raster import FarmRaster
from ndvi_worker.stac import Band, Scene

RED = Band(href="red", scale=0.0001, offset=-0.1)
NIR = Band(href="nir", scale=0.0001, offset=-0.1)
UTM = CRS.from_epsg(32643)  # Erode is in UTM 43N


def dn(refl):
    """Reflectance -> digital number for the c1 offset (-0.1) and scale (1e-4)."""
    return np.asarray((np.asarray(refl) + 0.1) / 0.0001, dtype=np.uint16)


def sq(lat, lng, d=0.00055):
    return [{"lat": lat, "lng": lng}, {"lat": lat, "lng": lng + d}, {"lat": lat + d, "lng": lng + d},
            {"lat": lat + d, "lng": lng}]


# ------------------------------------------------------------------ NDVI maths

def test_ndvi_uses_scale_and_offset():
    # red 0.05, nir 0.45 -> 0.8 ; without the offset it would be ~0.67
    nd, valid, cloud, nodata = raster.compute_ndvi(dn([[0.05]]), dn([[0.45]]), np.array([[4]]), RED, NIR)
    assert valid.all() and not cloud.any()
    assert nd[0, 0] == pytest.approx(0.8, abs=1e-4)


def test_cloud_shadow_nodata_and_bad_pixels_are_masked():
    red = dn([[0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]])
    nir = dn([[0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45]])
    red[0, 5] = 0                                   # no data
    red[0, 6] = 500                                 # reflectance -0.05: impossible
    scl = np.array([[4, 3, 8, 9, 10, 4, 4]])        # veg, shadow, cloud, cloud, cirrus
    nd, valid, cloud, nodata = raster.compute_ndvi(red, nir, scl, RED, NIR)
    assert valid.tolist() == [[True, False, False, False, False, False, False]]
    assert cloud.tolist() == [[False, True, True, True, True, False, False]]
    assert nodata.tolist() == [[False, False, False, False, False, True, False]]
    assert np.isnan(nd[0, 1:]).all()


def test_ndvi_always_in_range():
    rng = np.random.default_rng(1)
    red = rng.integers(1, 12000, (50, 50)).astype(np.uint16)
    nir = rng.integers(1, 12000, (50, 50)).astype(np.uint16)
    nd, valid, _, _ = raster.compute_ndvi(red, nir, np.full((50, 50), 4), RED, NIR)
    v = nd[valid]
    assert v.size > 0 and (v >= -1).all() and (v <= 1).all()


# ------------------------------------------------------------------ geometry

def test_pin_or_line_has_no_zone():
    assert raster.zone_polygon([{"lat": 11.45, "lng": 77.68}]) is None
    assert raster.zone_polygon(sq(11.45, 77.68)[:2]) is None
    assert raster.zone_polygon([]) is None


def test_crossing_shape_is_repaired_not_dropped():
    p = sq(11.45, 77.68)
    bowtie = [p[0], p[2], p[1], p[3]]
    poly = raster.zone_polygon(bowtie)
    assert poly is not None and poly.is_valid and poly.area > 0


def test_area():
    a = raster.area_m2(raster.zone_polygon(sq(11.45, 77.68)))
    assert 3500 < a < 3800       # 0.00055 deg ~ 60 m a side


# ------------------------------------------------------------------ zone pixels

def synthetic_farm(values, clouds=None, zones_m=None):
    """A 20 x 20 grid of 10 m pixels in UTM with per-zone NDVI."""
    t = from_origin(500000, 1300200, 10, 10)
    h = w = 20
    ndvi = np.full((h, w), 0.2, dtype=np.float32)
    valid = np.ones((h, w), dtype=bool)
    cloud = np.zeros((h, w), dtype=bool)
    from shapely.geometry import box
    zones_m = zones_m or {1: box(500013, 1300013, 500073, 1300073),     # 60 x 60 m, off the pixel grid
                          2: box(500100, 1300010, 500160, 1300070),
                          3: box(500010, 1300100, 500070, 1300160)}
    for v, val in values.items():
        poly = zones_m[v]
        m = raster.geometry_mask([poly], out_shape=(h, w), transform=t, invert=True)
        ndvi[m] = val
    for v in (clouds or []):
        m = raster.geometry_mask([zones_m[v]], out_shape=(h, w), transform=t, invert=True)
        valid[m] = False
        cloud[m] = True
        ndvi[m] = np.nan
    return FarmRaster(crs=UTM, transform=t, ndvi=ndvi, valid=valid, cloud=cloud,
                      nodata=np.zeros((h, w), dtype=bool), zones_native=zones_m)


def test_zone_uses_inner_pixels_only():
    fr = synthetic_farm({1: 0.7, 2: 0.4, 3: 0.55})
    # a neighbour's value on the edge mustn't leak in
    per_zone, farm = raster.analyse(fr, 60)
    assert per_zone[1]["pixels"] == 25           # 6 x 6 pixels, 5 m inset -> 5 x 5
    assert per_zone[1]["mean"] == pytest.approx(0.7)
    assert per_zone[2]["mean"] == pytest.approx(0.4)
    assert per_zone[3]["min"] == per_zone[3]["max"] == pytest.approx(0.55)
    assert all(z["usable"] for z in per_zone.values())
    assert farm["clear_pct"] == 100.0
    assert worker.classify(per_zone, farm) == "ok"


def test_small_zone_falls_back_to_centre_pixels():
    from shapely.geometry import box
    tiny = {1: box(500010, 1300010, 500030, 1300030)}     # 20 x 20 m: inset leaves 1 pixel
    fr = synthetic_farm({1: 0.6}, zones_m=tiny)
    per_zone, _ = raster.analyse(fr, 60)
    assert per_zone[1]["pixels"] == 4 and per_zone[1]["mean"] == pytest.approx(0.6)


def test_cloudy_zone_is_not_usable_but_others_are():
    fr = synthetic_farm({1: 0.7, 2: 0.4, 3: 0.55}, clouds=[2])
    per_zone, farm = raster.analyse(fr, 60)
    assert per_zone[2]["usable"] is False and per_zone[2]["valid_pct"] == 0
    assert per_zone[1]["usable"] and worker.classify(per_zone, farm) == "ok"
    fr = synthetic_farm({1: 0.7, 2: 0.4, 3: 0.55}, clouds=[1, 2, 3])
    per_zone, farm = raster.analyse(fr, 60)
    assert worker.classify(per_zone, farm) == "cloudy"


def test_weak_spot_found_inside_a_zone():
    from shapely.geometry import box
    big = {1: box(500003, 1300003, 500123, 1300123)}          # 120 x 120 m, ~12 x 12 pixels inside
    fr = synthetic_farm({1: 0.72}, zones_m=big)
    # a 3 x 2 pixel weak patch, and a single weak pixel (too small to count)
    fr.ndvi[10:12, 3:6] = 0.40
    fr.ndvi[5, 9] = 0.30
    per_zone, _ = raster.analyse(fr, 60)
    z = per_zone[1]
    assert z["median"] == pytest.approx(0.72)
    assert len(z["weak_spots"]) == 1
    sp = z["weak_spots"][0]
    assert sp["pixels"] == 6 and sp["area_m2"] == 600
    assert sp["mean"] == pytest.approx(0.40) and sp["drop"] == pytest.approx(0.32)
    # the spot's centre is where the patch is (UTM 43N around E 500 km = 75 deg E)
    assert 74.99 < sp["lng"] < 75.01 and 11.7 < sp["lat"] < 11.8
    assert 0 < z["weak_pct"] < 10


def test_no_weak_spots_on_a_bare_or_even_field():
    from shapely.geometry import box
    big = {1: box(500003, 1300003, 500123, 1300123)}
    fr = synthetic_farm({1: 0.18}, zones_m=big)                # bare field: nothing is "weak"
    fr.ndvi[10:12, 3:6] = 0.05
    assert raster.analyse(fr, 60)[0][1]["weak_spots"] == []
    fr = synthetic_farm({1: 0.7}, zones_m=big)                 # even crop: small dips aren't spots
    fr.ndvi[10:12, 3:6] = 0.65
    assert raster.analyse(fr, 60)[0][1]["weak_spots"] == []


def test_heatmap_png_covers_zones():
    fr = synthetic_farm({1: 0.75, 2: 0.15, 3: 0.5}, clouds=[3])
    png, (w, s, e, n) = render.render(fr)
    img = Image.open(io.BytesIO(png))
    assert img.mode == "RGBA" and img.width > 0
    assert w < e and s < n and 74.9 < w < 75.1 and 11.6 < s < 11.9   # UTM 43N, E 500 km = 75 deg E
    px = np.array(img)
    colours = {tuple(c) for c in px.reshape(-1, 4) if c[3] > 0}
    assert render.CLOUD_RGBA in colours                     # cloudy zone grey
    assert any(c[1] > c[0] for c in colours)                # a green
    assert any(c[0] > 200 and c[1] < 60 for c in colours)   # a red


def test_big_farm_picture_stays_small():
    from shapely.geometry import box
    t = from_origin(500000, 1310000, 10, 10)
    h = w = 400                                               # a 4 km farm window
    fr = FarmRaster(crs=UTM, transform=t, ndvi=np.full((h, w), 0.6, dtype=np.float32), valid=np.ones((h, w), bool),
                    cloud=np.zeros((h, w), bool), nodata=np.zeros((h, w), bool),
                    zones_native={1: box(500100, 1306100, 503900, 1309900)})
    png, _ = render.render(fr)
    img = Image.open(io.BytesIO(png))
    assert max(img.size) <= 1000 + render.UPSCALE


def test_ramp_ends():
    out = render.ramp(np.array([0.0, 1.0], dtype=np.float32))
    assert tuple(out[0]) == render.STOPS[0][1] and tuple(out[1]) == render.STOPS[-1][1]


# ------------------------------------------------------------------ STAC

def test_search_follows_pages_and_skips_items_without_bands():
    def item(i, day):
        a = {b: {"href": f"https://x/{i}/{b}.tif", "raster:bands": [{"scale": 0.0001, "offset": -0.1, "nodata": 0}]}
             for b in ("red", "nir", "scl")}
        return {"id": f"S{i}", "properties": {"datetime": f"2026-10-{day:02d}T05:25:00Z", "eo:cloud_cover": 10,
                                               "grid:code": "MGRS-43PGN"}, "assets": a}
    pages = [{"features": [item(2, 6), item(1, 1)], "links": [{"rel": "next", "href": "https://s/next", "body": {"next": "t"}}]},
             {"features": [item(3, 11), {"id": "bad", "properties": {"datetime": "2026-10-12T00:00:00Z"}, "assets": {}}],
              "links": []}]
    calls = []

    def post(url, body):
        calls.append((url, body))
        return pages[len(calls) - 1]
    out = stac.search((77.6, 11.4, 77.7, 11.5), datetime(2026, 10, 1, tzinfo=timezone.utc),
                      datetime(2026, 11, 1, tzinfo=timezone.utc), post=post)
    assert [s.id for s in out] == ["S1", "S2", "S3"]
    assert calls[1] == ("https://s/next", {"next": "t"})
    assert out[0].bands["red"].offset == -0.1 and out[0].tile == "MGRS-43PGN"
    assert calls[0][1]["query"]["eo:cloud_cover"]["lt"] > 0


# ------------------------------------------------------------------ database (worker end to end)

PG = os.environ.get("NDVI_TEST_PG")
needs_pg = pytest.mark.skipif(not PG or not PG.rstrip("/").split("/")[-1].endswith("test"),
                              reason="set NDVI_TEST_PG to a *test database")
SCHEMA = Path(__file__).resolve().parents[2] / "server" / "src" / "bridge" / "ndviSchema.sql"


@pytest.fixture
def conn():
    c = store.connect(PG)
    with c.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS ndvi_maps, ndvi_history, ndvi_farm_scenes, ndvi_scenes, ndvi_zones, ndvi_status, ndvi_weather CASCADE")
        cur.execute(SCHEMA.read_text())
    c.commit()
    yield c
    c.close()


def scene(i, day, cloud=20.0):
    return Scene(id=f"S2X_TEST_{i}", acquired_at=datetime(2026, 10, day, 5, 25, tzinfo=timezone.utc),
                 cloud_cover=cloud, tile="MGRS-43PGN", bands={"red": RED, "nir": NIR, "scl": Band("scl")})


def put_zones(conn, farm, zones):
    with conn.cursor() as cur:
        for v, pts in zones.items():
            cur.execute("INSERT INTO ndvi_zones (farm_id, valve, points) VALUES (%s, %s, %s::jsonb)",
                        (farm, v, __import__("json").dumps(pts)))
    conn.commit()


@needs_pg
def test_worker_processes_each_image_once(conn):
    put_zones(conn, "0003", {1: sq(11.45, 77.68), 2: sq(11.45, 77.681), 3: sq(11.451, 77.68), 4: sq(11.45, 77.69)[:2]})
    scenes = [scene(1, 1), scene(2, 6), scene(3, 11)]
    cloudy = {"S2X_TEST_2"}
    reads = []

    def search(bbox, start, end):
        assert bbox[0] < 77.68 < bbox[2]
        return scenes

    def read(sc, zones):
        reads.append(sc.id)
        assert set(zones) == {1, 2, 3}                       # the pin-only valve 4 has no zone
        if sc.id == "S2X_TEST_3":
            raise OSError("HTTP 503")
        return synthetic_farm({1: 0.7, 2: 0.4, 3: 0.55}, clouds=[1, 2, 3] if sc.id in cloudy else None)

    now = datetime(2026, 10, 20, tzinfo=timezone.utc)
    res = worker.check_farm(conn, "0003", search=search, read=read, now=now)
    assert res == {"S2X_TEST_1": "ok", "S2X_TEST_2": "cloudy", "S2X_TEST_3": "error"}

    # second round: only the failed image is tried again
    reads.clear()
    scenes.append(scene(4, 16))
    res = worker.check_farm(conn, "0003", search=search, read=lambda sc, z: read(sc, z) if sc.id != "S2X_TEST_3"
                            else synthetic_farm({1: 0.72, 2: 0.41, 3: 0.5}), now=now)
    assert reads == ["S2X_TEST_4"] and res == {"S2X_TEST_3": "ok", "S2X_TEST_4": "ok"}

    with conn.cursor() as cur:
        cur.execute("SELECT weak_spots, median FROM ndvi_history WHERE usable AND valve = 1 LIMIT 1")
        spots, med = cur.fetchone()
        assert spots == [] and med == pytest.approx(0.7)    # an even zone: no weak spots
        cur.execute("SELECT valve, count(*) FILTER (WHERE usable), count(*) FROM ndvi_history GROUP BY valve ORDER BY valve")
        assert cur.fetchall() == [(1, 3, 4), (2, 3, 4), (3, 3, 4)]
        cur.execute("SELECT count(*) FROM ndvi_maps WHERE farm_id = '0003'")
        assert cur.fetchone()[0] == 3
        cur.execute("SELECT last_obs_at, last_check_at IS NOT NULL, last_error FROM ndvi_status WHERE farm_id = '0003'")
        last_obs, checked, err = cur.fetchone()
        assert last_obs == scene(4, 16).acquired_at and checked and err is None
    conn.rollback()


@needs_pg
def test_refresh_request_and_schedule(conn):
    put_zones(conn, "0002", {1: sq(11.45, 77.68)})
    now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
    assert store.farms_due(conn, 6, now) == ["0002"]           # never checked
    worker.check_farm(conn, "0002", search=lambda *a: [], read=None, now=now)
    assert store.farms_due(conn, 6, datetime.now(timezone.utc)) == []
    with conn.cursor() as cur:
        cur.execute("UPDATE ndvi_status SET refresh_requested = now() WHERE farm_id = '0002'")
    conn.commit()
    assert store.farms_due(conn, 6, datetime.now(timezone.utc)) == ["0002"]
    worker.check_farm(conn, "0002", search=lambda *a: [], read=None, now=datetime.now(timezone.utc) + timedelta(seconds=5))
    assert store.farms_due(conn, 6, datetime.now(timezone.utc)) == []


@needs_pg
def test_search_failure_is_recorded_and_retried(conn):
    put_zones(conn, "0005", {1: sq(11.45, 77.68)})

    def boom(*a):
        raise OSError("catalogue down")
    assert worker.check_farm(conn, "0005", search=boom, read=None) == {}
    with conn.cursor() as cur:
        cur.execute("SELECT last_error FROM ndvi_status WHERE farm_id = '0005'")
        assert "catalogue down" in cur.fetchone()[0]
    conn.rollback()


@needs_pg
def test_maps_are_pruned(conn, monkeypatch):
    monkeypatch.setattr("ndvi_worker.config.KEEP_MAPS", 2)
    put_zones(conn, "0006", {1: sq(11.45, 77.68)})
    scenes = [scene(i, i) for i in range(1, 5)]
    worker.check_farm(conn, "0006", search=lambda *a: scenes, read=lambda sc, z: synthetic_farm(
        {1: 0.6}, zones_m={1: __import__("shapely.geometry", fromlist=["box"]).box(500010, 1300010, 500070, 1300070)}),
        now=datetime(2026, 10, 20, tzinfo=timezone.utc))
    with conn.cursor() as cur:
        cur.execute("SELECT scene_id FROM ndvi_maps WHERE farm_id = '0006' ORDER BY acquired_at")
        assert [r[0] for r in cur.fetchall()] == ["S2X_TEST_3", "S2X_TEST_4"]
    conn.rollback()


# ------------------------------------------------------------------ leaf moisture (NDMI)

N8 = Band(href="nir08", scale=0.0001, offset=-0.1)
SW = Band(href="swir16", scale=0.0001, offset=-0.1)


def test_ndmi_maths_and_canopy_only():
    # canopy (NDVI 0.8): nir08 0.40, swir 0.20 -> NDMI 0.333 ; bare soil (NDVI 0.1) not read
    ndvi = np.array([[0.8, 0.1]], dtype=np.float32)
    valid = np.array([[True, True]])
    nd, ok = raster.compute_ndmi(dn([[0.40, 0.30]]), dn([[0.20, 0.35]]), valid, ndvi, N8, SW)
    assert ok.tolist() == [[True, False]]
    assert nd[0, 0] == pytest.approx(0.3333, abs=1e-3) and np.isnan(nd[0, 1])


def test_ndmi_never_read_on_cloud_or_nodata():
    ndvi = np.array([[0.8, 0.8, 0.8]], dtype=np.float32)
    valid = np.array([[False, True, True]])          # pixel 0 is cloud
    n8 = dn([[0.40, 0.40, 0.40]])
    n8[0, 2] = 0                                     # no data
    nd, ok = raster.compute_ndmi(n8, dn([[0.2, 0.2, 0.2]]), valid, ndvi, N8, SW)
    assert ok.tolist() == [[False, True, False]]


def with_water(fr, values, dry_box=None, dry_value=None):
    """Give a synthetic farm leaf moisture per zone (and a drier patch)."""
    ndmi = np.full(fr.ndvi.shape, np.nan, dtype=np.float32)
    for v, val in values.items():
        m = raster.geometry_mask([fr.zones_native[v]], out_shape=fr.ndvi.shape, transform=fr.transform, invert=True)
        ndmi[m] = val
    if dry_box is not None:
        m = raster.geometry_mask([dry_box], out_shape=fr.ndvi.shape, transform=fr.transform, invert=True)
        ndmi[m] = dry_value
    ok = fr.valid & np.isfinite(ndmi) & (np.nan_to_num(fr.ndvi, nan=0) >= raster.NDMI_MIN_NDVI)
    fr.ndmi = np.where(ok, ndmi, np.nan).astype(np.float32)
    fr.ndmi_ok = ok
    return fr


def test_zone_water_reading_and_dry_spot():
    from shapely.geometry import box
    big = {1: box(500000, 1300000, 500120, 1300120)}            # 12 x 12 pixels
    fr = synthetic_farm({1: 0.7}, zones_m=big)
    fr = with_water(fr, {1: 0.30}, dry_box=box(500030, 1300030, 500070, 1300070), dry_value=0.12)
    per_zone, _ = raster.analyse(fr, 60)
    z = per_zone[1]
    assert z["ndmi_usable"] and z["ndmi_veg_pct"] == 100.0
    assert z["ndmi_median"] == pytest.approx(0.30)
    assert len(z["dry_spots"]) == 1 and z["dry_spots"][0]["pixels"] == 16 and z["dry_spots"][0]["drop"] == pytest.approx(0.18, abs=1e-3)
    assert z["dry_pct"] > 0


def test_no_water_reading_on_bare_field_or_without_bands():
    fr = synthetic_farm({1: 0.15, 2: 0.7, 3: 0.7})            # zone 1 bare
    fr = with_water(fr, {1: 0.1, 2: 0.25, 3: 0.25})
    per_zone, _ = raster.analyse(fr, 60)
    assert not per_zone[1]["ndmi_usable"] and per_zone[1]["ndmi_mean"] is None
    assert per_zone[2]["ndmi_usable"]
    plain = synthetic_farm({1: 0.7, 2: 0.7, 3: 0.7})          # image without the water bands
    per_zone, _ = raster.analyse(plain, 60)
    assert all(not z["ndmi_usable"] and z["dry_spots"] == [] for z in per_zone.values())


def test_water_picture():
    fr = with_water(synthetic_farm({1: 0.7, 2: 0.15, 3: 0.6}, clouds=[3]), {1: 0.3, 2: 0.1})
    png, bounds = render.render_water(fr)
    img = np.array(Image.open(io.BytesIO(png)))
    assert img.shape[2] == 4 and (img[..., 3] > 0).any()
    colours = {tuple(px) for px in img.reshape(-1, 4) if px[3] > 0}
    assert render.NO_CANOPY_RGBA in colours                     # bare zone 2 drawn pale
    assert render.CLOUD_RGBA in colours
    assert render.render_water(synthetic_farm({1: 0.7})) == (None, None)


def test_stac_water_bands_are_optional():
    base = {"id": "X", "properties": {"datetime": "2026-10-01T05:25:00Z", "eo:cloud_cover": 3},
            "assets": {b: {"href": b} for b in ("red", "nir", "scl")}}
    assert set(stac.parse_item(base).bands) == {"red", "nir", "scl"}
    base["assets"].update({b: {"href": b, "raster:bands": [{"scale": 0.0001, "offset": -0.1}]} for b in ("nir08", "swir16")})
    s = stac.parse_item(base)
    assert s.bands["swir16"].offset == -0.1 and "nir08" in s.bands


# ------------------------------------------------------------------ weather / ET0

def test_et0_fao56_example():
    # FAO-56 example 18 (Brussels, 6 July): 3.9 mm/day with RHmax/RHmin; mean RH gives ~3.8
    et0, est = weather.et0_pm(datetime(2026, 7, 6).date(), 50.8, 100, 21.5, 12.3, 73.5, 2.078, 22.07)
    assert et0 == pytest.approx(3.85, abs=0.15) and not est
    et0b, est = weather.et0_pm(datetime(2026, 7, 6).date(), 50.8, 100, 21.5, 12.3, 73.5, 2.078, None)
    assert est and 2.5 < et0b < 5.0


def test_power_parsing_skips_missing_days_and_estimates_sun():
    days = {"20261101": 1, "20261102": 1, "20261103": 1}
    data = {"geometry": {"coordinates": [78.0, 11.4, 316.0]},
            "parameters": {"ALLSKY_SFC_SW_DWN": {"units": "MJ/m^2/day"}},
            "properties": {"parameter": {
                "PRECTOTCORR": {"20261101": 4.4, "20261102": 12.0, "20261103": -999.0},
                "T2M_MAX": {"20261101": 31.0, "20261102": 30.0, "20261103": -999.0},
                "T2M_MIN": {"20261101": 22.0, "20261102": 23.0, "20261103": -999.0},
                "RH2M": {"20261101": 80.0, "20261102": 85.0, "20261103": -999.0},
                "WS2M": {"20261101": 1.0, "20261102": 1.1, "20261103": -999.0},
                "ALLSKY_SFC_SW_DWN": {"20261101": 18.0, "20261102": -999.0, "20261103": -999.0}}}}
    seen = []
    rows = weather.fetch_daily(11.4, 78.0, datetime(2026, 11, 1).date(), datetime(2026, 11, 3).date(),
                               get=lambda url: seen.append(url) or data)
    assert "PRECTOTCORR" in seen[0] and "latitude=11.4000" in seen[0]
    assert [r["day"].isoformat() for r in rows] == ["2026-11-01", "2026-11-02"]
    assert rows[0]["rain_mm"] == 4.4 and not rows[0]["rs_estimated"] and rows[1]["rs_estimated"]
    assert all(1.0 < r["et0_mm"] < 7.0 for r in rows)
    assert len(days) == 3


@needs_pg
def test_water_columns_weather_and_backfill(conn):
    from shapely.geometry import box
    put_zones(conn, "0003", {1: sq(11.45, 77.68)})
    sc = scene(5, 2)
    sc.bands.update({"nir08": N8, "swir16": SW})

    def read(s, zones):
        fr = synthetic_farm({1: 0.7}, zones_m={1: box(500000, 1300000, 500120, 1300120)})
        return with_water(fr, {1: 0.28})

    now = datetime(2026, 10, 20, tzinfo=timezone.utc)
    worker.check_farm(conn, "0003", search=lambda b, s, e: [sc], read=read, now=now)
    with conn.cursor() as cur:
        cur.execute("SELECT ndmi_usable, ndmi_median, dry_spots FROM ndvi_history WHERE valve = 1")
        usable, med, dry = cur.fetchone()
        assert usable and med == pytest.approx(0.28) and dry == []
        cur.execute("SELECT png_water IS NOT NULL FROM ndvi_maps")
        assert cur.fetchone()[0]
        # a row read before leaf moisture existed -> the farm is re-read once
        cur.execute("UPDATE ndvi_history SET ndmi_usable = NULL")
    conn.commit()
    assert store.farms_missing_water(conn, 110, now=now) == ["0003"]
    store.forget_farm_images(conn, "0003")
    assert store.processed_scene_ids(conn, "0003") == set()

    # weather: fetched, stored, then not again within WEATHER_HOURS
    def fetch(url):
        return {"geometry": {"coordinates": [77.68, 11.45, 200]}, "properties": {"parameter": {
            "PRECTOTCORR": {"20261019": 3.0}, "T2M_MAX": {"20261019": 31.0}, "T2M_MIN": {"20261019": 22.0},
            "RH2M": {"20261019": 70.0}, "WS2M": {"20261019": 1.5}, "ALLSKY_SFC_SW_DWN": {"20261019": 19.0}}}}
    assert worker.update_weather(conn, "0003", fetch=fetch, now=now) == 1
    assert worker.update_weather(conn, "0003", fetch=fetch, now=now + timedelta(hours=1)) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT day, rain_mm, et0_mm > 0 FROM ndvi_weather WHERE farm_id = '0003'")
        assert cur.fetchall() == [(datetime(2026, 10, 19).date(), 3.0, True)]
    conn.rollback()
    # a failed fetch is recorded, not raised
    assert worker.update_weather(conn, "0003", fetch=lambda u: (_ for _ in ()).throw(OSError("503")),
                                 now=now + timedelta(days=1)) == 0


@needs_pg
def test_tables_ready_needs_newest_columns(conn):
    assert store.tables_ready(conn)
    with conn.cursor() as cur:
        cur.execute("ALTER TABLE ndvi_status DROP COLUMN weather_at")
    conn.commit()
    assert not store.tables_ready(conn)    # an older schema: wait for the bridge to update it
