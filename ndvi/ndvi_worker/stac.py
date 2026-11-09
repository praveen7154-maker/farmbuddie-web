"""Finding Sentinel-2 L2A images over a farm (STAC search, standard library only)."""
import json
import urllib.request
from dataclasses import dataclass
from datetime import datetime

from . import config

BANDS = ("red", "nir", "scl")   # B04 (10 m), B08 (10 m), scene classification (20 m)


@dataclass
class Band:
    href: str
    scale: float = 1.0
    offset: float = 0.0
    nodata: int = 0


@dataclass
class Scene:
    id: str
    acquired_at: datetime
    cloud_cover: float
    tile: str
    bands: dict   # name -> Band


def _band(asset):
    rb = (asset.get("raster:bands") or [{}])[0]
    return Band(href=asset["href"], scale=float(rb.get("scale", 1.0)), offset=float(rb.get("offset", 0.0)),
                nodata=int(rb.get("nodata", 0) or 0))


def parse_item(f):
    """A STAC item -> Scene, or None when it lacks a band we need."""
    assets = f.get("assets", {})
    if not all(b in assets for b in BANDS):
        return None
    p = f.get("properties", {})
    when = datetime.fromisoformat(p["datetime"].replace("Z", "+00:00"))
    return Scene(id=f["id"], acquired_at=when, cloud_cover=float(p.get("eo:cloud_cover", 100.0)),
                 tile=str(p.get("grid:code") or p.get("s2:mgrs_tile") or ""),
                 bands={b: _band(assets[b]) for b in BANDS})


def _post(url, body, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/geo+json",
                                          "User-Agent": "farmbuddie-ndvi/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def search(bbox, start, end, max_cloud=None, post=_post, max_pages=20):
    """Every image over [bbox] (lon/lat w,s,e,n) acquired in [start, end), oldest first."""
    body = {
        "collections": [config.STAC_COLLECTION],
        "bbox": list(bbox),
        "datetime": f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "limit": 100,
        "query": {"eo:cloud_cover": {"lt": max_cloud if max_cloud is not None else config.MAX_SCENE_CLOUD}},
        "sortby": [{"field": "properties.datetime", "direction": "asc"}],
    }
    url = f"{config.STAC_URL}/search"
    out, seen = [], set()
    for _ in range(max_pages):
        page = post(url, body)
        for f in page.get("features", []):
            s = parse_item(f)
            if s and s.id not in seen:
                seen.add(s.id)
                out.append(s)
        nxt = next((l for l in page.get("links", []) if l.get("rel") == "next"), None)
        if not nxt or not page.get("features"):
            break
        url, body = nxt["href"], nxt.get("body") or body
    out.sort(key=lambda s: s.acquired_at)
    return out
