-- Crop health / NDVI tables (farmbuddie_bridge database). Created by the
-- bridge at start (ndviStore.js); read and written by the NDVI worker
-- (farmbuddie-web/ndvi). Plain PostgreSQL: zone shapes are small GeoJSON-
-- style point lists and the worker does the geometry, so PostGIS (which
-- would mean replacing the database image TBMQ also uses) isn't needed yet.
--
-- How these map to the NDVI spec's tables:
--   farms, fields       -> the farm already in Firestore (controllers);
--                          one field per farm for now, field id = farm id
--   irrigation_zones,   -> ndvi_zones: one row per mapped valve (the valve's
--   valves, crop_details   plotted land = its irrigation zone, with crop)
--   satellite_images    -> ndvi_scenes (+ ndvi_farm_scenes: per farm, so an
--                          image is never processed twice)
--   ndvi_history        -> ndvi_history (+ ndvi_maps for the heatmaps)

CREATE TABLE IF NOT EXISTS ndvi_zones (
  farm_id      TEXT NOT NULL,
  valve        INTEGER NOT NULL CHECK (valve BETWEEN 1 AND 64),
  points       JSONB NOT NULL,              -- [{lat, lng}, ...] as plotted in the app
  area_m2      DOUBLE PRECISION,
  crop         TEXT,
  sowing_date  DATE,
  plotted_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT,
  PRIMARY KEY (farm_id, valve)
);

CREATE TABLE IF NOT EXISTS ndvi_scenes (
  scene_id     TEXT PRIMARY KEY,
  tile         TEXT,
  acquired_at  TIMESTAMPTZ NOT NULL,
  cloud_cover  DOUBLE PRECISION,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ndvi_farm_scenes (
  farm_id      TEXT NOT NULL,
  scene_id     TEXT NOT NULL REFERENCES ndvi_scenes(scene_id) ON DELETE CASCADE,
  status       TEXT NOT NULL,               -- ok / cloudy / no_data / error
  clear_pct    DOUBLE PRECISION,
  error        TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, scene_id)
);

CREATE TABLE IF NOT EXISTS ndvi_history (
  farm_id      TEXT NOT NULL,
  valve        INTEGER NOT NULL,
  scene_id     TEXT NOT NULL REFERENCES ndvi_scenes(scene_id) ON DELETE CASCADE,
  acquired_at  TIMESTAMPTZ NOT NULL,
  mean         REAL,
  min          REAL,
  max          REAL,
  p10          REAL,
  p90          REAL,
  std          REAL,
  pixels       INTEGER NOT NULL,
  valid_pixels INTEGER NOT NULL,
  valid_pct    REAL NOT NULL,
  usable       BOOLEAN NOT NULL,
  PRIMARY KEY (farm_id, valve, scene_id)
);
-- Weak spots inside the zone (worker raster.weak_spots): [{pixels, area_m2,
-- mean, min, drop, lat, lng}], the zone's median and the % they cover.
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS median REAL;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS weak_spots JSONB;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS weak_pct REAL;
CREATE INDEX IF NOT EXISTS ndvi_history_zone_time_idx ON ndvi_history (farm_id, valve, acquired_at DESC);

CREATE TABLE IF NOT EXISTS ndvi_maps (
  farm_id      TEXT NOT NULL,
  scene_id     TEXT NOT NULL REFERENCES ndvi_scenes(scene_id) ON DELETE CASCADE,
  acquired_at  TIMESTAMPTZ NOT NULL,
  west DOUBLE PRECISION NOT NULL, south DOUBLE PRECISION NOT NULL,
  east DOUBLE PRECISION NOT NULL, north DOUBLE PRECISION NOT NULL,
  png          BYTEA NOT NULL,
  PRIMARY KEY (farm_id, scene_id)
);

CREATE TABLE IF NOT EXISTS ndvi_status (
  farm_id            TEXT PRIMARY KEY,
  refresh_requested  TIMESTAMPTZ,            -- zones changed: check again soon
  last_check_at      TIMESTAMPTZ,            -- last time the catalogue was searched
  last_success_at    TIMESTAMPTZ,            -- last time a usable image was processed
  last_obs_at        TIMESTAMPTZ,            -- acquisition time of the newest usable image
  last_error         TEXT,
  last_error_at      TIMESTAMPTZ
);

-- Water status (leaf moisture + water balance) -----------------------------
-- Leaf moisture per zone from the same images (worker raster.ndmi_stats):
-- NDMI = (B8A - B11) / (B8A + B11) over the zone's canopy pixels; dry spots
-- like weak spots. ndmi_usable NULL = read before this existed.
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS ndmi_mean REAL;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS ndmi_p10 REAL;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS ndmi_median REAL;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS ndmi_veg_pct REAL;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS ndmi_usable BOOLEAN;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS dry_spots JSONB;
ALTER TABLE ndvi_history ADD COLUMN IF NOT EXISTS dry_pct REAL;
-- The leaf-moisture picture for the map's Water view.
ALTER TABLE ndvi_maps ADD COLUMN IF NOT EXISTS png_water BYTEA;
-- A valve's flow (litres per hour, set in the app) turns its run time into
-- mm of water on its land. NULL = not set.
ALTER TABLE ndvi_zones ADD COLUMN IF NOT EXISTS flow_lph REAL;
-- Daily weather per farm (worker weather.py, NASA POWER): rain and FAO-56
-- reference evaporation for the water balance.
CREATE TABLE IF NOT EXISTS ndvi_weather (
  farm_id       TEXT NOT NULL,
  day           DATE NOT NULL,
  rain_mm       REAL,
  et0_mm        REAL,
  tmax          REAL,
  tmin          REAL,
  rh            REAL,
  wind          REAL,
  rs            REAL,
  rs_estimated  BOOLEAN,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, day)
);
ALTER TABLE ndvi_status ADD COLUMN IF NOT EXISTS weather_at TIMESTAMPTZ;
ALTER TABLE ndvi_status ADD COLUMN IF NOT EXISTS weather_error TEXT;
