"""Builds src/fonts/*.woff2 from the full CMU fonts in fonts-full/ (gitignored).

1. Subsets to Latin-1 + quotes/dashes/bullet/ellipsis/heart (all the popup uses).
2. Renames the fonts, because the OFL (src/fonts/OFL.txt) reserves the name
   "Computer Modern Unicode fonts" and a subset counts as a Modified Version.
   Copyright and licence records are kept unchanged.

Dev-only, not shipped. Needs: pip install fonttools brotli
Run from the repo root:  python scripts/subset-fonts.py
"""
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

# shortcut: Latin only; add Greek (U+0370-03FF) / Cyrillic (U+0400-04FF) if the popup gets translated.
UNICODES = "U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+2665"
FONTS = {
    "cmunrm": ("MathsClip Serif", "Regular"),
    "cmunti": ("MathsClip Serif", "Italic"),
    "cmunbx": ("MathsClip Serif", "Bold"),
    "cmuntt": ("MathsClip Typewriter", "Regular"),
}
RESERVED = ("CMU", "Computer Modern Unicode")
KEEP_IDS = {0, 5, 13, 14}  # copyright, version, licence description, licence URL

root = Path(__file__).resolve().parent.parent
for stem, (family, style) in FONTS.items():
    font = TTFont(root / "fonts-full" / f"{stem}.woff2")

    options = subset.Options()
    options.layout_features = ["*"]
    options.flavor = "woff2"
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)

    full = family if style == "Regular" else f"{family} {style}"
    ps = f"{family.replace(' ', '')}-{style}"
    name = font["name"]
    name.names = [r for r in name.names if r.nameID in KEEP_IDS]
    for name_id, value in {1: family, 2: style, 3: f"{ps};subset of {stem}", 4: full, 6: ps}.items():
        name.setName(value, name_id, 3, 1, 0x409)

    cff = font["CFF "].cff
    cff.fontNames = [ps]
    top = cff.topDictIndex[0]
    top.FullName, top.FamilyName = full, family

    # Self-check: no reserved name left outside the kept copyright/licence records.
    for record in name.names:
        if record.nameID not in KEEP_IDS:
            assert not any(r in record.toUnicode() for r in RESERVED), (stem, record.nameID)
    assert not any(r in s for r in RESERVED for s in (ps, top.FullName, top.FamilyName)), stem

    out = root / "src" / "fonts" / f"{stem}.woff2"
    font.save(out)
    print(f"{out.relative_to(root)}: {out.stat().st_size} bytes -> {full}")
