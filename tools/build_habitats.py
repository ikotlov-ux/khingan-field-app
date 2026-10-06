#!/usr/bin/env python3
"""Build habitats.js for Habitat 32 from data/habitat_db.xlsx.

Usage:  python tools/build_habitats.py [data/habitat_db.xlsx] [habitats.js]
Requires: openpyxl (pip install openpyxl)

Workbook layout (see the README sheet inside the workbook):
  regions    : region_id, name_ru, name_zh, name_en, country, lon_min, lat_min, lon_max, lat_max, note
  categories : cat_id, name_ru, definition_ru, name_zh
  classes    : class_id, cat_id, name_ru, name_zh
  habitats   : row 1 = region name_ru merged over a block of 6 columns; row 2 = attribute labels;
               rows 3+ : class rows (cat_id, class_id filled) and type sub-rows (type_no filled, class_id empty).
               Block columns, in order: name_ru, name_zh, area_ha, share_pct, community, source.
"""
import datetime
import json
import re
import sys
from pathlib import Path

import openpyxl

FIXED_COLS = 6                      # cat_id, category, class_id, class, type_no, status
ATTRS = ['name_ru', 'name_zh', 'area_ha', 'share_pct', 'community', 'source']


def clean(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r'\s+', ' ', str(v)).strip()


def num(v):
    if v is None or v == '':
        return None
    try:
        return float(str(v).replace(',', '.').replace(' ', ''))
    except ValueError:
        return None


def sheet_rows(ws):
    return [list(r) for r in ws.iter_rows(values_only=True)]


def main(src='data/habitat_db.xlsx', dst='habitats.js'):
    wb = openpyxl.load_workbook(src, data_only=True)
    errors = []

    regions = []
    for r in sheet_rows(wb['regions'])[1:]:
        if not r or not clean(r[0]):
            continue
        rid = clean(r[0])
        if not re.fullmatch(r'[A-Za-z0-9_\-]+', rid):
            errors.append(f'regions: region_id "{rid}" must be Latin letters/digits/underscore')
        regions.append({
            'id': rid, 'ru': clean(r[1]), 'zh': clean(r[2]), 'en': clean(r[3]), 'country': clean(r[4]),
            'bbox': [num(r[5]), num(r[6]), num(r[7]), num(r[8])], 'note': clean(r[9]) if len(r) > 9 else ''
        })
    by_name = {rg['ru']: rg['id'] for rg in regions}

    categories = []
    for r in sheet_rows(wb['categories'])[1:]:
        if r and r[0] is not None:
            categories.append({'id': int(r[0]), 'ru': clean(r[1]), 'def_ru': clean(r[2]), 'zh': clean(r[3])})

    classes = []
    for r in sheet_rows(wb['classes'])[1:]:
        if r and r[0] is not None:
            classes.append({'id': int(r[0]), 'cat': int(r[1]), 'ru': clean(r[2]), 'zh': clean(r[3])})
    class_ids = {c['id'] for c in classes}

    ws = wb['habitats']
    rows = sheet_rows(ws)
    header = rows[0]
    blocks = []                      # (region_id, first_col_index)
    for ci in range(FIXED_COLS, len(header)):
        name = clean(header[ci])
        if name:
            if name not in by_name:
                errors.append(f'habitats: region header "{name}" (column {ci + 1}) not found in sheet regions (name_ru)')
                continue
            blocks.append((by_name[name], ci))

    habitats = []
    cur_class = None
    for ri, r in enumerate(rows[2:], start=3):
        if not any(v is not None and clean(v) != '' for v in r):
            continue
        if r[2] is not None and clean(r[2]) != '':
            cur_class = int(r[2])
            if cur_class not in class_ids:
                errors.append(f'habitats row {ri}: class_id {cur_class} not in sheet classes')
            type_no = None
        else:
            type_no = int(num(r[4])) if num(r[4]) is not None else None
            if cur_class is None:
                errors.append(f'habitats row {ri}: type sub-row before any class row')
                continue
            if type_no is None:
                errors.append(f'habitats row {ri}: sub-row without class_id and without type_no')
                continue
        for rid, c0 in blocks:
            cells = r[c0:c0 + len(ATTRS)] + [None] * (len(ATTRS) - len(r[c0:c0 + len(ATTRS)]))
            rec = dict(zip(ATTRS, cells))
            if all(clean(v) == '' for v in cells):
                continue
            if type_no is not None and clean(rec['name_ru']) == '':
                errors.append(f'habitats row {ri}, region {rid}: type sub-row needs "name_ru"')
                continue
            habitats.append({
                'region': rid, 'class': cur_class, 'type': type_no,
                'ru': clean(rec['name_ru']), 'zh': clean(rec['name_zh']),
                'area_ha': num(rec['area_ha']), 'share_pct': num(rec['share_pct']),
                'community': clean(rec['community']), 'source': clean(rec['source'])
            })

    if errors:
        print('ERRORS:\n  ' + '\n  '.join(errors), file=sys.stderr)
        sys.exit(1)

    db = {'generated': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'regions': regions, 'categories': categories, 'classes': classes, 'habitats': habitats}
    out = ('// Generated by tools/build_habitats.py from data/habitat_db.xlsx — do not edit by hand.\n'
           'window.HABITAT_DB = ' + json.dumps(db, ensure_ascii=False, indent=1) + ';\n')
    Path(dst).write_text(out, encoding='utf-8')
    print(f'{dst}: {len(regions)} regions, {len(categories)} categories, {len(classes)} classes, {len(habitats)} habitat records')


if __name__ == '__main__':
    main(*sys.argv[1:3])
