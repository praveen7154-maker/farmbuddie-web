# Crop health (NDVI) worker

Measures every mapped irrigation-valve zone of every farm from free
Copernicus Sentinel-2 satellite images, and stores the results for the
bridge, which serves them to the Irrigo app (menu > Crop Health).

All free and open: Copernicus Sentinel-2 Level-2A data, read from the public
cloud-optimised copy on AWS Open Data (Element 84 Earth Search; no account,
no API key). The software is all open source: Python, rasterio/GDAL, NumPy,
Shapely, pyproj, Pillow and PostgreSQL. No Google Earth Engine, no Sentinel
Hub, no paid map SDK.

## How it works

```
Irrigo app (Valve > map: each valve's land, 3+ points; crop per valve)
   │  PUT /api/farms/:id/zones, PUT /api/zones/:id/crop
   ▼
bridge (Node, server/src/bridge/ndvi*.js) ── ndvi_zones table ──┐
   ▲  GET /api/farms/:id/ndvi, /fields/:id/ndvi-map, ...         │
   │                                                             ▼
   └──── ndvi_history / ndvi_maps / ndvi_status ◄──── ndvi worker (this folder)
                                                       │ STAC search + HTTP range reads
                                                       ▼
                                   Sentinel-2 L2A on AWS Open Data (free)
```

1. **Find images.** Every 6 hours (`NDVI_CHECK_HOURS`), and within a minute of
   a farm's zones changing, the worker searches the catalogue over each
   farm. It skips images it has already handled (`ndvi_farm_scenes`). The
   first check of a farm looks back 120 days (`NDVI_BACKFILL_DAYS`), so the
   farm gets a history right away.
2. **Read only the farm's pixels.** It reads B04 (red), B08 (near infrared)
   and SCL (scene classification) for a small window around the farm, about
   a hundred KB per image, not the ~1 GB product. It takes about 1.5 s per
   image.
3. **NDVI** = (B08 − B04) / (B08 + B04), on surface reflectance
   (digital number × scale + offset, from the image's own metadata).
4. **Masking.** A pixel only counts when SCL says vegetation, bare soil,
   water or unclassified. Clouds, cloud shadow, thin cirrus, dark area,
   saturated pixels and no-data are dropped, and so is any NDVI outside
   −1..1.
5. **Per zone.** It uses the pixels whose centre is at least 5 m inside the
   valve's land, because edge pixels mix in the bund or the neighbour's crop.
   Very small zones fall back to every pixel whose centre is inside. For each
   zone it records the mean, min, max, p10, p90, std, the pixel count and the
   % clear. A reading is usable when at least 60 % of the zone is clear
   (`NDVI_MIN_CLEAR_PCT`).
6. **Cloud is judged over the farm, not the whole 110 km tile.** A "70 %
   cloudy" image can be perfectly clear over the farm, and a "21 %" one
   can be clouded over it. Both happen often here.
7. **Heatmap.** For each clear image it saves a small transparent PNG in
   lat/lon with its bounds, which the app lays over its satellite map. The
   last 12 per farm are kept (`NDVI_KEEP_MAPS`); the numbers are kept for
   good.

The bridge then compares each zone with the farm's other zones on the same
image, with its own previous reading, and with the crop's typical range.
It combines that with the water each valve got (Reports) to give advice:
check irrigation uniformity, inspect for pests or nutrients, check soil
moisture. **It never starts a pump or opens a valve.**

### Water status (leaf moisture + water balance)

Each image also gives **leaf moisture**:
- **What it is:** NDMI = (B8A - B11) / (B8A + B11) on the 20 m bands, read only where the crop covers the ground (NDVI ≥ 0.3).
- **What is stored:** per valve, the median and the dry spots, plus a second heatmap (`ndvi_maps.png_water`).
- **Older images:** a farm whose recent images were read before this existed is re-read once at worker start.

Every 12 h the worker also fetches the farm's **daily weather**:
- **Source:** NASA POWER (free, public, no key, commercial use allowed). Rain arrives ~2 days late; for recent days, sunlight is estimated from the temperature range.
- **Computed:** **ET0** by FAO-56 Penman-Monteith (`weather.py`), stored in `ndvi_weather`.

The bridge (`server/src/bridge/ndviWater.js`) turns these into a water status per valve:
- **Leaf moisture** is compared with same-crop valves and with the valve's own trend.
- **The 7-day balance** is crop need (ET0 × FAO-56 crop factor) against effective rain plus irrigation, in mm. Irrigation counts only when the valve's flow is set in the app.
- **The two signals are combined** into short advice. Example: leaves drying while vigour still looks good means "water soon".

### Only farms with mapped valves

NDVI needs each valve's land as an area, so a valve plotted with 3 or more
points. A valve marked only with a pin or a line shows as "Pin only - map
its land". A farm with no mapped valve gets a page explaining how to map
them.

## Deploy (VPS)

The worker uses the bridge's own `server/.env` (`BRIDGE_PG_CONNECTION_STRING`),
so it needs no new secret. The bridge creates the tables at start, so
deploy the bridge first.

1. Add the service to `/root/docker-compose.yml`, next to `bridge:`:

```yaml
  ndvi:
    build: /root/farmbuddie-web/ndvi
    container_name: ndvi
    restart: unless-stopped
    depends_on:
      - postgres
      - bridge
    env_file:
      - /root/farmbuddie-web/server/.env
    mem_limit: 384m
    cpus: 0.5
```

2. `cd /root && docker compose up -d --build bridge ndvi`
3. `docker logs --tail 20 ndvi` should show `NDVI worker started`.
4. Once the app has sent a farm's zones: `docker exec ndvi python -m ndvi_worker status 0003`

To check a farm straight away instead of waiting for the next round:
`docker exec ndvi python -m ndvi_worker check 0003 --days 120`.

## Tests

```
pip install -r requirements.txt pytest
NDVI_TEST_PG=postgres://user:pass@127.0.0.1:5432/ndvitest python -m pytest tests
```

The pure tests (NDVI maths, masking, zone pixels, heatmap, catalogue paging)
always run. The database tests need a throwaway database whose name ends in
`test`. The bridge side is in `server/test/ndvi.test.js`.

## Costs

| Item | Cost |
|---|---|
| Sentinel-2 data and catalogue | free (Copernicus open licence; AWS Open Data, no egress charge to the reader) |
| Software | free, open source |
| Map tiles in the app | Esri World Imagery, as the valve map already uses; check Esri's terms of use before large-scale commercial use |
| Compute and storage | the existing VPS: about 1.5 s of CPU and ~100 KB of download per farm per image, and about 1 MB per farm per year stored |

Nothing needs a subscription. At 1,000 farms, with an image every ~5 days,
that's about 300 images a day: roughly 8 minutes of CPU and ~30 MB of
download a day, and about 1 GB a year of database.

## Scaling to many farmers

- **Already per farm:** zones, scenes, results and status are keyed by farm.
  The worker loops over every farm whose zones exist. Nothing in it is
  specific to farm 0003.
- **Share searches by tile** (when there are hundreds of farms): farms on
  the same Sentinel-2 tile see the same images, so one catalogue search per
  tile per round can serve them all.
- **More workers:** the work per farm is independent. Several worker
  containers can split farms, for example by farm id modulo N, if one isn't
  enough. It's unlikely to be needed below several thousand farms.
- **Cloud gaps:** in the monsoon, Sentinel-1 radar (also free, sees through
  cloud) could fill the gaps with a different vegetation signal. This is a
  possible later step.
- **PostGIS:** not needed at this scale (zones are small and the worker does
  the geometry). Add it if zone queries by location are ever needed.
