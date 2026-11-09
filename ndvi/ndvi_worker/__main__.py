"""python -m ndvi_worker run                  check every farm on a schedule (the container's command)
python -m ndvi_worker check <farmId> [--days N]   check one farm now (e.g. a first backfill)
python -m ndvi_worker status [<farmId>]      what has been processed
"""
import argparse
import logging
import sys

from . import store, worker


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("rasterio").setLevel(logging.WARNING)
    p = argparse.ArgumentParser(prog="ndvi_worker")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    c = sub.add_parser("check")
    c.add_argument("farm_id")
    c.add_argument("--days", type=int, default=None, help="look this many days back (first check of a farm)")
    s = sub.add_parser("status")
    s.add_argument("farm_id", nargs="?")
    a = p.parse_args(argv)

    if a.cmd == "run":
        worker.run_forever()
        return 0
    conn = store.connect()
    if not store.tables_ready(conn):
        print("NDVI tables not found - update and restart the bridge first", file=sys.stderr)
        return 1
    if a.cmd == "check":
        res = worker.check_farm(conn, a.farm_id, backfill_days=a.days)
        counts = {}
        for st in res.values():
            counts[st] = counts.get(st, 0) + 1
        print(f"farm {a.farm_id}: {len(res)} new image(s) {counts}")
        return 0
    with conn.cursor() as cur:
        where, args = ("WHERE fs.farm_id = %s", (a.farm_id,)) if a.farm_id else ("", ())
        cur.execute(f"""SELECT fs.farm_id, to_char(sc.acquired_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                               fs.status, round(fs.clear_pct::numeric, 0), round(sc.cloud_cover::numeric, 0), fs.scene_id
                          FROM ndvi_farm_scenes fs JOIN ndvi_scenes sc USING (scene_id) {where}
                         ORDER BY fs.farm_id, sc.acquired_at""", args)
        print(f"{'farm':6} {'date':10} {'status':8} {'farm clear%':>11} {'tile cloud%':>11}  scene")
        for r in cur.fetchall():
            print(f"{r[0]:6} {r[1]:10} {r[2]:8} {str(r[3] if r[3] is not None else '-'):>11} {str(r[4]):>11}  {r[5]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
