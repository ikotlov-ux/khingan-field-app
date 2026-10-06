#!/usr/bin/env python3
"""Increment the release number in sw.js (fp-shell-vN) and app.js (APP_VERSION). Run before every release."""
import re, pathlib
n = None
p = pathlib.Path('sw.js'); s = p.read_text(encoding='utf-8')
def bump(m):
    global n; n = int(m.group(1)) + 1; return f"fp-shell-v{n}"
s = re.sub(r"fp-shell-v(\d+)", bump, s, count=1); p.write_text(s, encoding='utf-8')
p = pathlib.Path('app.js'); a = p.read_text(encoding='utf-8')
a = re.sub(r"const APP_VERSION = '\d+'", f"const APP_VERSION = '{n}'", a, count=1); p.write_text(a, encoding='utf-8')
print(f"version {n}")
