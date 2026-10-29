#!/usr/bin/env python3
"""Recreate every step's .drawio and .png from demo.json; records warnings and crossing counts back into it."""
import json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
os.chdir(here)
clarc = os.environ.get("CLARC", os.path.expanduser("~/.local/share/clarc/clarc"))
demo = json.load(open("demo.json"))
for s in demo["steps"]:
    p = subprocess.run([clarc, "--file", s["graph"]], capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"{s['id']}: clarc failed\n{p.stderr}")
    open(s["drawio"], "w").write(p.stdout)
    lines = p.stderr.splitlines()
    s["crossings"] = sum(1 for l in lines if "crossing" in l)
    s["warnings"] = [l for l in lines if l.startswith("warning") and "crossing" not in l]
    r = subprocess.run(["drawio", "-x", "-f", "png", "-s", str(s["scale"]), "-o", s["image"], s["drawio"], "--no-sandbox"],
                       capture_output=True, text=True)
    print(f"{s['id']}: crossings={s['crossings']} warnings={len(s['warnings'])} png={'ok' if os.path.exists(s['image']) else 'MISSING'}")
json.dump(demo, open("demo.json", "w"), indent=2)
