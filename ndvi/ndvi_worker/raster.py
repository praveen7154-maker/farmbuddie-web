"""NDVI from Sentinel-2 L2A: reading only the farm's pixels, cloud masking,
and per irrigation-zone statistics.

NDVI = (B08 - B04) / (B08 + B04), on surface reflectance
(digital number x scale + offset, both from the image's own metadata).
"""
import math
from dataclasses import dataclass, field

import numpy as np
import rasterio
import shapely
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.transform import array_bounds
from rasterio.windows import Window, from_bounds
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.ops import unary_union

# Scene classification (SCL) classes that are a real view of the ground:
# 4 vegetation, 5 bare soil, 6 water, 7 unclassified. Everything else is
# masked: 0 no data, 1 saturated / defective, 2 dark or topographic shadow,
# 3 cloud shadow, 8 / 9 cloud (medium / high), 10 thin cirrus, 11 snow.
SCL_CLEAR = (4, 5, 6, 7)
SCL_CLOUD = (3, 8, 9, 10)

# Satellite positions are good to about half a pixel, so a zone's own pixels
# are the ones whose centre is at least this far inside its edge (edge
# pixels mix in the neighbour's crop or the bund). A zone too small for that
# falls back to every pixel whose centre is inside it.
INSET_M = 5.0
MIN_PIXELS = 4

# The window read around the farm, beyond its zones (m).
MARGIN_M = 30.0

GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.TIF,.tiff",
    GDAL_HTTP_MULTIRANGE="YES",
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
    GDAL_HTTP_MAX_RETRY="3",
    GDAL_HTTP_RETRY_DELAY="2",
    VSI_CACHE="TRUE",
    AWS_NO_SIGN_REQUEST="YES",
)


# ---------------------------------------------------------------- geometry

def zone_polygon(points):
    """App boundary points [{lat, lng}, ...] -> a valid lon/lat polygon, or None.

    Fewer than 3 points (a valve marked with a pin or a line) has no area,
    so no NDVI. A shape tapped in a crossing order is repaired, not dropped.
    """
    pts = [(float(p["lng"]), float(p["lat"])) for p in (points or [])
           if p is not None and "lat" in p and "lng" in p]
    if len(pts) < 3:
        return None
    try:
        poly = Polygon(pts)
    except Exception:  # noqa: BLE001 - degenerate input
        return None
    if not poly.is_valid:
        poly = make_valid(poly)
        parts = [g for g in getattr(poly, "geoms", [poly]) if isinstance(g, (Polygon, MultiPolygon))]
        poly = unary_union(parts) if parts else None
    if poly is None or poly.is_empty or poly.area == 0:
        return None
    return poly


def to_crs(geom, crs):
    t = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    return shapely.transform(geom, lambda x, y: t.transform(x, y), interleaved=False)


def area_m2(lonlat_poly):
    """Area of a lon/lat polygon in square metres (local UTM zone)."""
    c = lonlat_poly.centroid
    zone = int((c.x + 180) // 6) + 1
    epsg = (32600 if c.y >= 0 else 32700) + zone
    return float(to_crs(lonlat_poly, f"EPSG:{epsg}").area)


# ---------------------------------------------------------------- NDVI

def compute_ndvi(red_dn, nir_dn, scl, red_band, nir_band):
    """-> (ndvi with NaN where not valid, valid mask, cloud mask, no-data mask)."""
    red_dn = np.asarray(red_dn)
    nir_dn = np.asarray(nir_dn)
    scl = np.asarray(scl)
    nodata = (red_dn == red_band.nodata) | (nir_dn == nir_band.nodata) | (scl == 0)
    red = red_dn.astype(np.float32) * red_band.scale + red_band.offset
    nir = nir_dn.astype(np.float32) * nir_band.scale + nir_band.offset
    with np.errstate(divide="ignore", invalid="ignore"):
        ndvi = (nir - red) / (nir + red)
    valid = (~nodata) & np.isin(scl, SCL_CLEAR) & (red > 0) & (nir > 0) & np.isfinite(ndvi) \
        & (ndvi >= -1.0) & (ndvi <= 1.0)
    cloud = (~nodata) & np.isin(scl, SCL_CLOUD)
    return np.where(valid, ndvi, np.nan).astype(np.float32), valid, cloud, nodata


def zone_mask(poly_native, transform, shape):
    """Pixels belonging to a zone (polygon already in the image's CRS)."""
    inner = poly_native.buffer(-INSET_M)
    if not inner.is_empty:
        m = geometry_mask([inner], out_shape=shape, transform=transform, invert=True)
        if m.sum() >= MIN_PIXELS:
            return m
    m = geometry_mask([poly_native], out_shape=shape, transform=transform, invert=True)
    if m.sum() == 0:   # smaller than one pixel: the pixel(s) it touches
        m = geometry_mask([poly_native], out_shape=shape, transform=transform, invert=True, all_touched=True)
    return m


def zone_stats(ndvi, valid, nodata, mask, min_clear_pct):
    pixels = int(mask.sum())
    seen = mask & ~nodata                  # inside the image's swath
    vals = ndvi[mask & valid]
    out = {"pixels": pixels, "valid_pixels": int(vals.size),
           "valid_pct": round(100.0 * vals.size / pixels, 1) if pixels else 0.0,
           "in_swath": bool(seen.any()),
           "mean": None, "min": None, "max": None, "p10": None, "p90": None, "std": None}
    if vals.size:
        out.update(mean=round(float(vals.mean()), 4), min=round(float(vals.min()), 4),
                   max=round(float(vals.max()), 4), p10=round(float(np.percentile(vals, 10)), 4),
                   p90=round(float(np.percentile(vals, 90)), 4), std=round(float(vals.std()), 4))
    out["usable"] = bool(vals.size >= min(MIN_PIXELS, pixels) and vals.size > 0
                         and out["valid_pct"] >= min_clear_pct)
    return out


# ---------------------------------------------------------------- reading

def _snap(win):
    """A fractional window -> whole pixels covering it."""
    c0, r0 = math.floor(win.col_off), math.floor(win.row_off)
    c1, r1 = math.ceil(win.col_off + win.width), math.ceil(win.row_off + win.height)
    return Window(c0, r0, max(1, c1 - c0), max(1, r1 - r0))


@dataclass
class FarmRaster:
    crs: object
    transform: object
    ndvi: np.ndarray
    valid: np.ndarray
    cloud: np.ndarray
    nodata: np.ndarray
    zones_native: dict = field(default_factory=dict)   # valve -> polygon in crs


def read_farm(scene, zones_lonlat, opener=rasterio.open):
    """Read red / NIR / SCL for the farm's zones only, and compute NDVI.

    [zones_lonlat]: {valve: lon/lat polygon}. Range requests fetch just the
    image blocks covering the farm (a few hundred KB, not the ~1 GB product).
    """
    rb, nb, sb = scene.bands["red"], scene.bands["nir"], scene.bands["scl"]
    with rasterio.Env(**GDAL_ENV):
        with opener(rb.href) as red_ds:
            crs = red_ds.crs
            native = {v: to_crs(p, crs) for v, p in zones_lonlat.items()}
            w, s, e, n = unary_union(list(native.values())).buffer(MARGIN_M).bounds
            win = _snap(from_bounds(w, s, e, n, red_ds.transform))
            transform = red_ds.window_transform(win)
            red = red_ds.read(1, window=win, boundless=True, fill_value=rb.nodata)
        shape = red.shape
        with opener(nb.href) as nir_ds:
            nwin = from_bounds(*array_bounds(shape[0], shape[1], transform), nir_ds.transform)
            nir = nir_ds.read(1, window=nwin, out_shape=shape, boundless=True, fill_value=nb.nodata,
                              resampling=Resampling.nearest)
        with opener(sb.href) as scl_ds:
            swin = from_bounds(*array_bounds(shape[0], shape[1], transform), scl_ds.transform)
            scl = scl_ds.read(1, window=swin, out_shape=shape, boundless=True, fill_value=0,
                              resampling=Resampling.nearest)
    ndvi, valid, cloud, nodata = compute_ndvi(red, nir, scl, rb, nb)
    return FarmRaster(crs=crs, transform=transform, ndvi=ndvi, valid=valid, cloud=cloud, nodata=nodata,
                      zones_native=native)


def analyse(fr, min_clear_pct):
    """{valve: stats} for every zone, plus the farm's overall clear %."""
    shape = fr.ndvi.shape
    per_zone, all_mask = {}, np.zeros(shape, dtype=bool)
    for valve, poly in fr.zones_native.items():
        m = zone_mask(poly, fr.transform, shape)
        all_mask |= m
        per_zone[valve] = zone_stats(fr.ndvi, fr.valid, fr.nodata, m, min_clear_pct)
    total = int(all_mask.sum())
    clear = int((all_mask & fr.valid).sum())
    farm = {"pixels": total, "clear_pct": round(100.0 * clear / total, 1) if total else 0.0,
            "in_swath": bool((all_mask & ~fr.nodata).any())}
    return per_zone, farm


def bbox_lonlat(zones_lonlat, margin_deg=0.0005):
    w, s, e, n = unary_union(list(zones_lonlat.values())).bounds
    return box(w - margin_deg, s - margin_deg, e + margin_deg, n + margin_deg).bounds
