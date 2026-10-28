#!/usr/bin/env python3
"""Builds public/css/theme-dark.generated.css - the admin's dark theme.

The admin pages' own stylesheets hard-code their colours (about 650 of
them), so rather than rewriting every file around variables this reads
each one and writes a dark twin of every rule that sets a colour, scoped
to html[data-theme="dark"] (set by /js/admin-shell.js). The light pages
stay exactly as they were. Re-run after changing a page's CSS:

    python3 tools/gen-dark-theme.py

How a colour is moved, by what it is used for:
  backgrounds   light surfaces -> dark green-grey surfaces (white cards stay
                a step above the page, as in the light theme); strong
                accents (buttons, badges) keep their colour
  text / icons  dark text -> light; coloured text keeps its hue, brightened
                so it reads on a dark surface
  borders       light lines -> dark lines
  shadows       kept, a little deeper
"""
import colorsys
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS_DIR = os.path.join(ROOT, "public", "css")
OUT = os.path.join(CSS_DIR, "theme-dark.generated.css")
SKIP = {"theme-dark.generated.css", "admin-shell.css"}
SCOPE = 'html[data-theme="dark"]'

NAMED = {
    "white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0),
    "green": (0, 128, 0), "gray": (128, 128, 128), "grey": (128, 128, 128),
    "orange": (255, 165, 0), "blue": (0, 0, 255), "yellow": (255, 255, 0),
    "silver": (192, 192, 192), "whitesmoke": (245, 245, 245),
}
COLOR_RE = re.compile(
    r"#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b"
    r"|rgba?\([^)]*\)|hsla?\([^)]*\)"
    r"|\b(?:" + "|".join(NAMED) + r")\b", re.I)

BG_PROPS = {"background", "background-color", "background-image"}
TEXT_PROPS = {"color", "fill", "stroke", "caret-color", "accent-color",
              "-webkit-text-fill-color", "text-decoration-color"}
LINE_PROPS = {"border", "border-color", "border-top", "border-right",
              "border-bottom", "border-left", "border-top-color",
              "border-right-color", "border-bottom-color", "border-left-color",
              "outline", "outline-color", "column-rule", "border-block",
              "border-inline", "border-block-end", "border-block-start"}
SHADOW_PROPS = {"box-shadow", "text-shadow", "filter"}

NEUTRAL_HUE = 158 / 360   # Farm Buddie green, for the greys


def parse(tok):
    t = tok.lower()
    if t in NAMED:
        r, g, b = NAMED[t]
        return r, g, b, 1.0, "named"
    if t.startswith("#"):
        h = t[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return r, g, b, a, "hex"
    nums = re.findall(r"[-\d.]+%?", t)
    if t.startswith("hsl") or len(nums) < 3:
        return None
    def ch(v):
        return float(v[:-1]) * 2.55 if v.endswith("%") else float(v)
    r, g, b = ch(nums[0]), ch(nums[1]), ch(nums[2])
    a = 1.0
    if len(nums) > 3:
        a = float(nums[3][:-1]) / 100 if nums[3].endswith("%") else float(nums[3])
    return r, g, b, a, "rgb"


def fmt(r, g, b, a):
    r, g, b = (max(0, min(255, round(v))) for v in (r, g, b))
    if a >= 0.999:
        return "#%02x%02x%02x" % (r, g, b)
    return "rgba(%d, %d, %d, %s)" % (r, g, b, ("%.3f" % a).rstrip("0").rstrip("."))


def hls(r, g, b):
    return colorsys.rgb_to_hls(r / 255, g / 255, b / 255)


def from_hls(h, l, s, a):
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), max(0, min(1, s)))
    return fmt(r * 255, g * 255, b * 255, a)


def surface(r, g, b, a):
    h, l, s = hls(r, g, b)
    vivid = s > 0.35 and 0.18 < l < 0.75
    if a < 0.999 and l > 0.85:
        if a >= 0.5:
            # frosted-glass panels -> the dark card surface, still see-through
            return from_hls(NEUTRAL_HUE, 0.15, 0.14, max(a, 0.85))
        # a faint white wash (hover tints) stays a faint light wash
        return from_hls(NEUTRAL_HUE, 0.9, 0.2, min(a, 0.08))
    if a <= 0.12 and l < 0.3 and s < 0.3:
        # a faint black shade (stripes, hover rows) -> the same faint light shade
        return from_hls(NEUTRAL_HUE, 0.9, 0.2, min(a * 1.2, 0.12))
    if a < 0.999 and l < 0.3:
        return fmt(0, 0, 0, min(0.75, a + 0.2))     # dimming overlays: a little deeper
    if vivid:
        # buttons, badges, progress bars: keep, a touch deeper so white
        # text on them still reads and they don't glare
        return from_hls(h, l * 0.92, s * 0.9, a)
    if l >= 0.9:
        # page and card backgrounds: white is the raised card, the faint
        # greys under it the page - same order as the light theme
        ns = 0.14 if s < 0.15 else min(s, 0.35) * 0.55
        hh = NEUTRAL_HUE if s < 0.15 else h
        return from_hls(hh, 0.055 + (l - 0.9) * 0.6, ns, a)
    if l >= 0.5:
        # tinted light panels (mint chips, pale alerts) -> deep tinted panels
        ns = 0.12 if s < 0.12 else min(s, 0.5) * 0.45
        hh = NEUTRAL_HUE if s < 0.12 else h
        return from_hls(hh, 0.17 + (0.9 - l) * 0.35, ns, a)
    # already dark - fine on a dark page
    return from_hls(h if s >= 0.12 else NEUTRAL_HUE, max(l, 0.12), s if s >= 0.12 else 0.1, a)


def text(r, g, b, a):
    h, l, s = hls(r, g, b)
    if s > 0.3 and l > 0.15:
        # coloured text (links, status words): same hue, light enough to read
        return from_hls(h, max(0.66, min(l + 0.18, 0.8)), min(s, 0.75), a)
    if l < 0.6:
        # body text greys: dark -> light, keeping how far apart they are
        return from_hls(NEUTRAL_HUE, 0.93 - l * 0.6, 0.08, a)
    if l > 0.92:
        return fmt(r, g, b, a)          # white text sits on accents - keep
    return from_hls(NEUTRAL_HUE, max(0.55, 1.15 - l), 0.08, a)


def line(r, g, b, a):
    h, l, s = hls(r, g, b)
    if s > 0.35 and 0.2 < l < 0.8:
        return from_hls(h, max(l * 0.85, 0.4), s * 0.8, a)      # accent outlines
    if a < 0.5 and l < 0.3:
        return from_hls(NEUTRAL_HUE, 0.9, 0.15, min(a * 1.5, 0.16))   # faint dark hairline -> faint light one
    if l > 0.5:
        return from_hls(NEUTRAL_HUE if s < 0.2 else h, 0.18 + (1 - l) * 0.35,
                        0.14 if s < 0.2 else min(s, 0.4) * 0.5, a)
    return from_hls(NEUTRAL_HUE, 0.3, 0.1, a)


def shadow(r, g, b, a):
    h, l, s = hls(r, g, b)
    if l < 0.5 or s < 0.2:
        return fmt(0, 0, 0, min(1, a * 1.8 + 0.05))
    return fmt(r, g, b, a * 0.6)       # coloured glows - softer


def transform(prop, value):
    p = prop.lower()
    if p in BG_PROPS:
        fn = surface
    elif p in TEXT_PROPS:
        fn = text
    elif p in LINE_PROPS:
        fn = line
    elif p in SHADOW_PROPS:
        fn = shadow
    else:
        return None
    if "var(" in value and not COLOR_RE.search(value):
        return None
    changed = False

    def sub(m):
        nonlocal changed
        c = parse(m.group(0))
        if not c:
            return m.group(0)
        changed = True
        return fn(*c[:4])
    out = COLOR_RE.sub(sub, value)
    return out if changed else None


def strip_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def scope_selector(sel):
    out = []
    for part in sel.split(","):
        s = part.strip()
        if not s:
            continue
        if re.match(r"^(html|:root)\b", s):
            s = re.sub(r"^(html|:root)", SCOPE, s, count=1)
        else:
            s = SCOPE + " " + s
        out.append(s)
    return ",\n".join(out)


def blocks(css):
    """Yields (prelude, body) for each top-level block."""
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0:
            return
        prelude = css[i:j].strip()
        # @import / @charset lines before the block
        while ";" in prelude and not prelude.startswith("@media"):
            prelude = prelude.split(";", 1)[1].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        yield prelude, css[j + 1:k - 1]
        i = k


def convert(css):
    out = []
    for prelude, body in blocks(css):
        if prelude.startswith("@media") or prelude.startswith("@supports"):
            inner = convert(body)
            if inner:
                out.append(prelude + " {\n" + "\n".join("  " + l if l else l for l in inner.split("\n")) + "\n}")
            continue
        if prelude.startswith("@"):
            continue                     # keyframes, font-face, page
        decls = []
        for d in body.split(";"):
            if ":" not in d:
                continue
            prop, val = d.split(":", 1)
            prop, val = prop.strip(), val.strip()
            if not prop or prop.startswith("--"):
                continue
            imp = ""
            if val.lower().endswith("!important"):
                val, imp = val[:-10].strip(), " !important"
            nv = transform(prop, val)
            if nv is not None and nv != val:
                decls.append("  %s: %s%s;" % (prop, nv, imp))
        if decls:
            out.append(scope_selector(prelude) + " {\n" + "\n".join(decls) + "\n}")
    return "\n".join(out)


def main():
    parts = ["/* GENERATED by tools/gen-dark-theme.py from the other files in this\n"
             "   folder - do not edit by hand; re-run the script instead.\n"
             "   Dark twins of every colour rule, active under html[data-theme=\"dark\"]. */\n"]
    for name in sorted(os.listdir(CSS_DIR)):
        if not name.endswith(".css") or name in SKIP:
            continue
        with open(os.path.join(CSS_DIR, name), encoding="utf-8") as f:
            body = convert(strip_comments(f.read()))
        if body:
            parts.append("/* ---- %s ---- */\n%s\n" % (name, body))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
    print("wrote", os.path.relpath(OUT, ROOT), os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    sys.exit(main())
