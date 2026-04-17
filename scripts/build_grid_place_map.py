#!/usr/bin/env python3
import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = ROOT / "docs" / "outputs"
GRID_POINTS = OUTPUTS / "grid_points.geojson"
NEIGHBORHOODS = OUTPUTS / "sf_neighborhoods.geojson"
SUPERVISOR_DISTRICTS = OUTPUTS / "sf_supervisor_districts.geojson"
OUT_CSV = OUTPUTS / "grid_place_map.csv"


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersects = ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi)
        if intersects:
            inside = not inside
        j = i
    return inside


def point_in_polygon(x, y, polygon_coords):
    if not polygon_coords:
        return False
    outer = polygon_coords[0]
    if not point_in_ring(x, y, outer):
        return False
    for hole in polygon_coords[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def iter_polygons(geometry):
    if not geometry:
        return
    gtype = geometry.get("type")
    coords = geometry.get("coordinates", [])
    if gtype == "Polygon":
        yield coords
    elif gtype == "MultiPolygon":
        for poly in coords:
            yield poly


def compute_bbox(polygon_coords):
    xs, ys = [], []
    for ring in polygon_coords:
        for x, y in ring:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def bbox_contains(bbox, x, y):
    if not bbox:
        return False
    minx, miny, maxx, maxy = bbox
    return minx <= x <= maxx and miny <= y <= maxy


def bbox_center(bbox):
    minx, miny, maxx, maxy = bbox
    return ((minx + maxx) / 2.0, (miny + maxy) / 2.0)


def load_zones(path, zone_name_field, extra_fields=None):
    extra_fields = extra_fields or []
    data = json.loads(path.read_text())
    zones = []
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        name = props.get(zone_name_field)
        if not name:
            continue
        geometry = feature.get("geometry")
        polys = list(iter_polygons(geometry))
        if not polys:
            continue
        bboxes = [compute_bbox(poly) for poly in polys]
        centers = [bbox_center(b) for b in bboxes if b]
        cx = sum(c[0] for c in centers) / len(centers) if centers else 0.0
        cy = sum(c[1] for c in centers) / len(centers) if centers else 0.0
        zone = {
            "name": str(name).strip(),
            "polygons": polys,
            "bboxes": bboxes,
            "center": (cx, cy),
        }
        for f in extra_fields:
            zone[f] = props.get(f)
        zones.append(zone)
    return zones


def lookup_zone(x, y, zones):
    # 1) precise containment
    for z in zones:
        for poly, bbox in zip(z["polygons"], z["bboxes"]):
            if bbox and not bbox_contains(bbox, x, y):
                continue
            if point_in_polygon(x, y, poly):
                return z["name"], False, z

    # 2) nearest zone fallback
    nearest = None
    best = float("inf")
    for z in zones:
        cx, cy = z["center"]
        d = (x - cx) ** 2 + (y - cy) ** 2
        if d < best:
            best = d
            nearest = z
    if nearest:
        return nearest["name"], True, nearest
    return "", True, None


def main():
    neighborhoods = load_zones(NEIGHBORHOODS, "name")
    districts = load_zones(SUPERVISOR_DISTRICTS, "sup_dist_num", ["sup_dist_name", "sup_name"])

    grid_data = json.loads(GRID_POINTS.read_text())
    rows = []
    for f in grid_data.get("features", []):
        props = f.get("properties", {})
        geom = f.get("geometry", {})
        coords = geom.get("coordinates", [])
        if len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        grid_id = str(props.get("grid_id", "")).strip()
        if not grid_id:
            continue

        n_name, n_fallback, _ = lookup_zone(lon, lat, neighborhoods)
        d_name, d_fallback, d_zone = lookup_zone(lon, lat, districts)

        rows.append(
            {
                "grid_id": grid_id,
                "lat": lat,
                "lon": lon,
                "cluster": props.get("cluster"),
                "neighborhood_name": n_name,
                "neighborhood_is_fallback": int(n_fallback),
                "supervisor_district": d_name,
                "supervisor_district_name": d_zone.get("sup_dist_name") if d_zone else "",
                "supervisor_name": d_zone.get("sup_name") if d_zone else "",
                "district_is_fallback": int(d_fallback),
            }
        )

    rows.sort(key=lambda r: r["grid_id"])
    with OUT_CSV.open("w", newline="") as fp:
        writer = csv.DictWriter(
            fp,
            fieldnames=[
                "grid_id",
                "lat",
                "lon",
                "cluster",
                "neighborhood_name",
                "neighborhood_is_fallback",
                "supervisor_district",
                "supervisor_district_name",
                "supervisor_name",
                "district_is_fallback",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {OUT_CSV}")


if __name__ == "__main__":
    main()
