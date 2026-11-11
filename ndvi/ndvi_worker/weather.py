"""Daily weather for a farm's water balance: rain and reference evaporation.

Source: NASA POWER daily point data (https://power.larc.nasa.gov - free,
public, no key, commercial use allowed). Rain arrives ~2 days late and
sunlight ~1 week late; a day whose sunlight isn't in yet gets it estimated
from the day's temperature range (FAO-56 eq. 50), a day without temperature
is left out.

ET0 (mm/day) is FAO-56 Penman-Monteith (Allen et al. 1998, eq. 6) on the
daily values. The crop's own need is ET0 x its crop factor (bridge ndvi.js).
"""
import json
import math
import urllib.parse
import urllib.request
from datetime import timedelta

from . import config

PARAMS = ("PRECTOTCORR", "T2M_MAX", "T2M_MIN", "RH2M", "WS2M", "ALLSKY_SFC_SW_DWN")
MISSING = -999.0
KRS = 0.16            # FAO-56 Hargreaves radiation coefficient, interior locations
DEFAULT_WIND = 2.0    # m/s - FAO-56's default when wind is missing


def _get(url, timeout=60):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "farmbuddie-ndvi/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_daily(lat, lng, start, end, get=_get):
    """[{day, rain_mm, et0_mm, tmax, tmin, rh, wind, rs, rs_estimated}] for start..end (dates), days with data only."""
    q = urllib.parse.urlencode({
        "parameters": ",".join(PARAMS), "community": "AG", "format": "JSON",
        "latitude": f"{lat:.4f}", "longitude": f"{lng:.4f}",
        "start": start.strftime("%Y%m%d"), "end": end.strftime("%Y%m%d"),
    })
    data = get(f"{config.POWER_URL}?{q}")
    coords = (data.get("geometry") or {}).get("coordinates") or [lng, lat, 0]
    elevation = float(coords[2]) if len(coords) > 2 and coords[2] is not None else 0.0
    p = (data.get("properties") or {}).get("parameter") or {}
    units = ((data.get("parameters") or {}).get("ALLSKY_SFC_SW_DWN") or {}).get("units", "MJ/m^2/day")
    rs_factor = 3.6 if "kW" in units else 1.0    # kWh/m^2/day -> MJ/m^2/day
    out = []
    for i in range((end - start).days + 1):
        day = start + timedelta(days=i)
        val = {k: _num(p.get(k, {}).get(day.strftime("%Y%m%d"))) for k in PARAMS}
        tmax, tmin = val["T2M_MAX"], val["T2M_MIN"]
        if tmax is None or tmin is None or tmax < tmin:
            continue
        rs = val["ALLSKY_SFC_SW_DWN"]
        rs = rs * rs_factor if rs is not None else None
        et0, estimated = et0_pm(day, lat, elevation, tmax, tmin, val["RH2M"], val["WS2M"], rs)
        out.append({"day": day, "rain_mm": val["PRECTOTCORR"], "et0_mm": round(et0, 2),
                    "tmax": tmax, "tmin": tmin, "rh": val["RH2M"], "wind": val["WS2M"], "rs": rs,
                    "rs_estimated": estimated})
    return out


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v <= MISSING + 0.5 or math.isnan(v) else v


def sat_vp(t):
    """Saturation vapour pressure at t degC (kPa), FAO-56 eq. 11."""
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def extraterrestrial_radiation(day, lat):
    """Ra (MJ/m^2/day), FAO-56 eq. 21."""
    j = day.timetuple().tm_yday
    phi = math.radians(lat)
    dr = 1 + 0.033 * math.cos(2 * math.pi * j / 365)
    decl = 0.409 * math.sin(2 * math.pi * j / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(decl))))
    return 24 * 60 / math.pi * 0.0820 * dr * (ws * math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.sin(ws))


def et0_pm(day, lat, elevation, tmax, tmin, rh=None, wind=None, rs=None):
    """-> (ET0 mm/day, whether sunlight was estimated). FAO-56 Penman-Monteith, daily."""
    t = (tmax + tmin) / 2
    delta = 4098 * sat_vp(t) / (t + 237.3) ** 2
    pressure = 101.3 * ((293 - 0.0065 * elevation) / 293) ** 5.26
    gamma = 0.000665 * pressure
    es = (sat_vp(tmax) + sat_vp(tmin)) / 2
    # Mean relative humidity (FAO-56 eq. 19); without it, dew point ~ Tmin (eq. 48).
    ea = es * rh / 100 if rh is not None else sat_vp(tmin)
    u2 = wind if wind is not None else DEFAULT_WIND
    ra = extraterrestrial_radiation(day, lat)
    estimated = rs is None
    if estimated:
        rs = KRS * math.sqrt(max(tmax - tmin, 0.0)) * ra           # eq. 50
    rso = (0.75 + 2e-5 * elevation) * ra                            # eq. 37
    rns = 0.77 * rs                                                 # eq. 38, albedo 0.23
    ratio = min(rs / rso, 1.0) if rso > 0 else 0.5
    rnl = 4.903e-9 * ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2 \
        * (0.34 - 0.14 * math.sqrt(max(ea, 0.0))) * (1.35 * ratio - 0.35)   # eq. 39
    rn = rns - rnl
    et0 = (0.408 * delta * rn + gamma * 900 / (t + 273) * u2 * (es - ea)) / (delta + gamma * (1 + 0.34 * u2))
    return max(et0, 0.0), estimated
