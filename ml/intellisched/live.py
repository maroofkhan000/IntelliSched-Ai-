"""Training data from the app's real database instead of the synthetic generator.

  python -m intellisched live --n 40 --time 15

1. Signs in to the running backend (http://localhost:4000, override with INTELLISCHED_API) as admin,
   with the login from backend/.env, and reads one database with GET requests only: nothing is
   written to MongoDB.
2. Keeps the approved rows (as the app's generator does). Sections with no teaching assignment
   get one in memory only, by the app's Auto-assign rules (frontend/src/assigner.js): priority,
   then experience, then fewer sections held, same branch, lighter load; nobody asked -> the
   least-loaded teacher of the branch. Saved as an app-style workbook, data/live/<database>.xlsx.
3. Solves that workbook n times, alternating odd and even terms, each time with random soft-rule
   weights. Every solve appends a row to runs/runs.csv, so `train` learns from the real college.
"""
import json
import math
import os
import re
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

from .pipeline import ROOT, run
from .schema import TABLE_ORDER, columns
from .solver import DEFAULT_WEIGHTS
from .workbook import save_workbook

API = os.environ.get("INTELLISCHED_API", "http://localhost:4000")
ENV = ROOT.parent / "backend" / ".env"


def _env():
    out = {}
    for line in ENV.read_text(encoding="utf8").splitlines():
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*)\s*$", line)
        if m:
            out[m[1]] = m[2].strip().strip("'\"")
    return out


def _call(method, route, body=None, token=None):
    req = urllib.request.Request(API + route, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def _num(v):
    try:
        return float(v) if v is not None and v == v else 0.0
    except (TypeError, ValueError):
        return 0.0


def auto_assign(data):
    """Fill TeacherSubjectMap for every section + subject without a teacher. Returns how many were added."""
    tsm, secs, subs, teas, prefs = (data[t] for t in ["TeacherSubjectMap", "Sections", "Subjects", "Teachers", "TeacherPreferences"])
    teachers = {t.TeacherID: t for t in teas.itertuples()}
    hours = {(s.BranchCode, s.SubjectCode): _num(s.WeeklyHours) for s in subs.itertuples()}
    load, held = {}, {}
    for m in tsm.itertuples():
        b = m.BranchCode if isinstance(m.BranchCode, str) else str(m.SectionID).split("-")[0]
        load[m.TeacherID] = load.get(m.TeacherID, 0) + hours.get((b, m.SubjectCode), 0)
        held[(m.TeacherID, m.SubjectCode)] = held.get((m.TeacherID, m.SubjectCode), 0) + 1
    # a teacher typed Theory or Lab only takes subjects of that type; untyped teachers take either
    type_ok = lambda t, sub: not isinstance(t.TeacherType, str) or t.TeacherType in ("", sub.Type)
    done = {(m.SectionID, m.SubjectCode) for m in tsm.itertuples()}
    jobs = []
    for sec in secs.itertuples():
        for sub in subs[(subs.BranchCode == sec.BranchCode) & (subs.Semester.map(_num) == _num(sec.Semester))].itertuples():
            if (sec.SectionID, sub.SubjectCode) in done:
                continue
            # everyone who listed it; a teacher of the other type only covers when no matching one is free
            wanted = [p for p in prefs[prefs.SubjectCode == sub.SubjectCode].itertuples() if p.TeacherID in teachers]
            jobs.append((sec, sub, _num(sub.WeeklyHours), wanted))
    jobs.sort(key=lambda j: (sum(type_ok(teachers[p.TeacherID], j[1]) for p in j[3]), -j[2]))  # fewest interested teachers first, as in the app
    added = []
    for sec, sub, h, wanted in jobs:
        fits = lambda tid: load.get(tid, 0) + h <= _num(teachers[tid].MaxWeeklyLoad)
        claims = sorted((p for p in wanted if fits(p.TeacherID)), key=lambda p: (
            not type_ok(teachers[p.TeacherID], sub), _num(p.Priority) or 9, -_num(p.ExperienceYears), held.get((p.TeacherID, sub.SubjectCode), 0),
            teachers[p.TeacherID].BranchCode != sub.BranchCode,
            load.get(p.TeacherID, 0) / max(1, _num(teachers[p.TeacherID].MaxWeeklyLoad)), p.TeacherID))
        tid = claims[0].TeacherID if claims else None
        if tid is None:
            asked = {p.TeacherID for p in wanted}
            free = sorted((t for t in teas.itertuples() if t.TeacherID not in asked and t.BranchCode == sec.BranchCode
                           and type_ok(t, sub) and fits(t.TeacherID)), key=lambda t: load.get(t.TeacherID, 0))
            tid = free[0].TeacherID if free else None
        if tid is None:
            continue  # the solver reports it as unassigned
        load[tid] = load.get(tid, 0) + h
        held[(tid, sub.SubjectCode)] = held.get((tid, sub.SubjectCode), 0) + 1
        added.append({"TeacherID": tid, "SubjectCode": sub.SubjectCode, "SectionID": sec.SectionID, "BranchCode": sec.BranchCode,
                      "Year": getattr(sec, "Year", None), "Semester": sec.Semester, "Section": sec.Section})
    if added:
        data["TeacherSubjectMap"] = pd.concat([tsm, pd.DataFrame(added)], ignore_index=True)[columns("TeacherSubjectMap")]
    return len(added)


def _app_columns(table):
    return [{"key": c} for c in columns(table)]


def export_live(database=None):
    """Read one database from the API (GET only) -> data/live/<name>.xlsx. Returns (path, summary)."""
    env = _env()
    if not env.get("ADMIN_USERNAME") or not env.get("ADMIN_PASSWORD"):
        raise SystemExit(f"ADMIN_USERNAME / ADMIN_PASSWORD missing in {ENV}")
    try:
        token = _call("POST", "/api/auth/login", {"username": env["ADMIN_USERNAME"], "password": env["ADMIN_PASSWORD"]})["token"]
    except OSError as e:
        raise SystemExit(f"can't reach the backend at {API} ({e}); start it with `npm run dev` in backend/")
    dbs = _call("GET", "/api/databases", token=token)
    pick = [d for d in dbs if database in (d["id"], d["name"])] if database else sorted(dbs, key=lambda d: -d["rows"])[:1]
    if not pick:
        raise SystemExit(f"no database {database!r}; have: {', '.join(d['name'] for d in dbs)}")
    d = _call("GET", f"/api/databases/{pick[0]['id']}", token=token)
    data, counts = {}, {}
    for t in TABLE_ORDER:
        rows = [r for r in d["data"].get(t, []) if r.get("_status") == "approved"]
        df = pd.DataFrame(rows)
        for c in columns(t):
            if c not in df.columns:
                df[c] = None
        data[t] = df[columns(t)]
        counts[t] = f"{len(rows)}/{len(d['data'].get(t, []))}"
    name = re.sub(r"[^A-Za-z0-9]+", "_", d["name"]).strip("_").lower() or "live"
    # the untouched data, in the same format as the app's "Export for ML (.json)" button
    keep = {t: [{c: r.get(c) for c in [col["key"] for col in _app_columns(t)]} | {"_status": r["_status"]}
                for r in d["data"].get(t, []) if r.get("_status") == "approved"] for t in TABLE_ORDER}
    raw = ROOT / "data" / "live" / f"{name}.json"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text(json.dumps({"format": "intellisched-database", "version": 1, "name": d["name"], "onlyApproved": True,
                               "settings": d["settings"], "tables": keep}, indent=2), encoding="utf8")
    assigned = auto_assign(data)
    path = save_workbook(data, ROOT / "data" / "live" / f"{name}.xlsx")
    return path, {"database": d["name"], "approved/total": counts, "auto-assigned in memory": assigned,
                  "terms": sorted({"odd" if int(_num(s)) % 2 else "even" for s in data["Sections"].Semester if _num(s)})}


def solve_variants(path, n, time_limit, terms, name, seed=0):
    """Solve one workbook n times (terms in turn): default weights first, then random ones -> runs/runs.csv."""
    rng = np.random.default_rng(seed)
    rows = []
    for k in range(n):
        term = terms[k % len(terms)]
        weights = None if k < len(terms) else {
            key: (v if key == "unplaced" else max(0, round(v * math.exp(rng.normal(0, 0.8)), 1))) for key, v in DEFAULT_WEIGHTS.items()}
        _, row = run(path, term=term, weights=weights, time_limit=time_limit, name=f"{name}_{term or 'all'}", quiet=True, charts=False)
        rows.append(row)
        print(f"  {k + 1}/{n} {term or 'all'}: {row['n_sessions']} sessions -> {row['status']}, unplaced {row.get('unplaced_sessions')}, "
              f"{row['solve_seconds']}s")
    return pd.DataFrame(rows)


def live_batch(n=40, time_limit=15, database=None, seed=0):
    path, info = export_live(database)
    terms = info["terms"] or ["odd"]  # only terms that have sections
    print(f"read '{info['database']}' (approved/total rows): " + ", ".join(f"{t} {c}" for t, c in info["approved/total"].items()))
    print(f"teaching assignments filled in memory by Auto-assign rules: {info['auto-assigned in memory']}; terms with sections: {', '.join(terms)}")
    print(f"saved {path.relative_to(ROOT)}; solving it {n} times with random weights")
    return solve_variants(path, n, time_limit, terms, f"live_{path.stem}", seed)
