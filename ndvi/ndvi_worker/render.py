"""The NDVI heatmap picture laid over the app's satellite map.

A small transparent PNG in plain lon/lat (EPSG:4326) with its bounds, so
the app can place it as a ground overlay without any projection maths.
Only pixels inside the farm's zones are coloured; cloudy ones are grey.
Each 10 m pixel stays a sharp square (no smoothing that would invent detail).
"""
import io

import numpy as np
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.transform import array_bounds
from rasterio.warp import calculate_default_transform, reproject

# Red (low) -> yellow (moderate) -> green (high). A display scale only;
# what is "low" for a crop is decided per zone, against the farm's other
# zones and the crop's typical range (bridge ndvi.js).
STOPS = [
    (0.10, (215, 25, 28)),
    (0.30, (244, 109, 67)),
    (0.45, (254, 224, 89)),
    (0.60, (166, 217, 106)),
    (0.80, (26, 150, 65)),
]
ALPHA = 215
CLOUD_RGBA = (150, 150, 150, 170)
UPSCALE = 8
MAX_SIDE_PX = 1000


# Leaf moisture (NDMI): brown (dry) -> sand -> light blue -> deep blue (wet
# leaves). Display scale only - "dry" for a valve is decided against the
# farm's other valves of the same crop and its own trend (bridge ndvi.js).
WATER_STOPS = [
    (-0.15, (166, 97, 26)),
    (0.00, (223, 194, 125)),
    (0.15, (128, 205, 193)),
    (0.30, (53, 151, 143)),
    (0.45, (1, 102, 94)),
]
# Clear, but no canopy to read (bare / just sown): pale, so it reads as "nothing here".
NO_CANOPY_RGBA = (235, 228, 214, 150)


def ramp(ndvi, stops=STOPS):
    """Value array -> uint8 RGB array on the given colour stops."""
    xs = np.array([s[0] for s in stops], dtype=np.float32)
    out = np.zeros(ndvi.shape + (3,), dtype=np.uint8)
    v = np.nan_to_num(ndvi, nan=0.0)
    for c in range(3):
        out[..., c] = np.interp(v, xs, np.array([s[1][c] for s in stops], dtype=np.float32)).astype(np.uint8)
    return out


def render(fr):
    """-> (png bytes, (west, south, east, north)) - the crop vigour (NDVI) picture."""
    return _render(fr, fr.ndvi, STOPS, None)


def render_water(fr):
    """-> (png bytes, bounds) - the leaf moisture (NDMI) picture, or (None, None) without water bands."""
    if fr.ndmi is None:
        return None, None
    return _render(fr, fr.ndmi, WATER_STOPS, fr.ndmi_ok)


def _render(fr, values, stops, read_mask):
    """[read_mask]: pixels the value was read for (None = every clear pixel); clear but
    unread pixels (no canopy for the water picture) are drawn pale."""
    h, w = fr.ndvi.shape
    inside = geometry_mask(list(fr.zones_native.values()), out_shape=(h, w), transform=fr.transform,
                           invert=True, all_touched=True)
    # 0 outside the farm, 1 clear, 2 cloud / shadow, 3 other masked
    cat = np.zeros((h, w), dtype=np.uint8)
    cat[inside & fr.valid] = 1
    cat[inside & fr.cloud] = 2
    cat[inside & ~fr.valid & ~fr.cloud & ~fr.nodata] = 3
    if read_mask is not None:
        cat[inside & fr.valid & ~read_mask] = 4

    src_bounds = array_bounds(h, w, fr.transform)
    dst_t, dw, dh = calculate_default_transform(fr.crs, "EPSG:4326", w, h, *src_bounds)
    ndvi_ll = np.full((dh, dw), np.nan, dtype=np.float32)
    cat_ll = np.zeros((dh, dw), dtype=np.uint8)
    reproject(values, ndvi_ll, src_transform=fr.transform, src_crs=fr.crs, dst_transform=dst_t,
              dst_crs="EPSG:4326", resampling=Resampling.nearest, src_nodata=np.nan, dst_nodata=np.nan)
    reproject(cat, cat_ll, src_transform=fr.transform, src_crs=fr.crs, dst_transform=dst_t,
              dst_crs="EPSG:4326", resampling=Resampling.nearest, src_nodata=0, dst_nodata=0)

    rgba = np.zeros((dh, dw, 4), dtype=np.uint8)
    clear = (cat_ll == 1) & np.isfinite(ndvi_ll)
    rgba[clear, :3] = ramp(ndvi_ll, stops)[clear]
    rgba[clear, 3] = ALPHA
    rgba[(cat_ll == 2) | (cat_ll == 3)] = CLOUD_RGBA
    rgba[cat_ll == 4] = NO_CANOPY_RGBA

    # Sharp squares when the app enlarges it - but never past ~1000 px a side,
    # so a big farm's picture stays small for the phone.
    scale = max(1, min(UPSCALE, MAX_SIDE_PX // max(dh, dw, 1)))
    big = np.repeat(np.repeat(rgba, scale, axis=0), scale, axis=1)
    buf = io.BytesIO()
    Image.fromarray(big, "RGBA").save(buf, format="PNG", optimize=True)
    west, south, east, north = array_bounds(dh, dw, dst_t)
    return buf.getvalue(), (west, south, east, north)
