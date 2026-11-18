#!/usr/bin/env python3
"""Builds PWUsage/Resources/country-boundaries.bin from Natural Earth country outlines.

The app resolves a site's country on the device from the saved solar home location, so
coordinates never leave the phone. Input is Natural Earth's public-domain 1:50m Admin 0
countries GeoJSON:

    https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson

Usage: python3 -I make-country-boundaries.py <input.geojson> <output.bin>

Format (little-endian):
    magic "PWCB", u8 version (1), u16 country count
    per country: 2 ASCII bytes ISO 3166-1 alpha-2, u32 ring count
    per ring: u32 point count, then (i32 longitude, i32 latitude) pairs in 1e-5 degrees

Features whose ISO_A2_EH is not an official two-letter code (-99, Kosovo's XK) are kept
under the code "--", so a point in or near them is unresolved and the app asks the owner. Rings of one country
are flattened; the app applies the even-odd rule across them, which handles holes.
"""

import json
import re
import struct
import sys

SCALE = 100_000
EXCLUDED = {"XK"}
UNKNOWN = "--"


def main(source: str, destination: str) -> None:
    with open(source, encoding="utf-8") as handle:
        features = json.load(handle)["features"]

    rings_by_code: dict[str, list[list[list[float]]]] = {}
    for feature in features:
        code = feature["properties"].get("ISO_A2_EH") or ""
        if not re.fullmatch(r"[A-Z]{2}", code) or code in EXCLUDED:
            code = UNKNOWN
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        rings = rings_by_code.setdefault(code, [])
        for polygon in polygons:
            rings.extend(polygon)

    output = bytearray(b"PWCB")
    output += struct.pack("<BH", 1, len(rings_by_code))
    for code in sorted(rings_by_code):
        rings = rings_by_code[code]
        output += code.encode("ascii")
        output += struct.pack("<I", len(rings))
        for ring in rings:
            output += struct.pack("<I", len(ring))
            for longitude, latitude in ring:
                output += struct.pack("<ii", round(longitude * SCALE), round(latitude * SCALE))

    with open(destination, "wb") as handle:
        handle.write(output)
    print(f"{len(rings_by_code)} countries, {len(output)} bytes")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
