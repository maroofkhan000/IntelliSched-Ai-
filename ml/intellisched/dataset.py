"""The ML datasets, and the pipeline that fills them straight from the app.

Every time an admin generates a timetable, the backend logs one record (collection `mlruns`):
the scope, the problem's numbers (frontend/src/mlRecord.js), how the app's generator did, and a
snapshot of the approved input. Nothing has to be downloaded by hand:

  python -m intellisched pull                # app records -> datasets/app_generations.{jsonl,csv}
  python -m intellisched pull --solve 10     # ...and re-solve each new snapshot with CP-SAT, 10 weight sets
  python -m intellisched dataset             # runs/runs.csv -> datasets/solver_runs.{jsonl,csv}
  python -m intellisched train               # learns from runs/runs.csv (which `pull --solve` extends)

Column meanings: datasets/DATASET.md.
"""
import json
import urllib.request

import pandas as pd

from .live import API, _call, _env, solve_variants
from .pipeline import ROOT

OUT = ROOT / "datasets"
SNAPSHOTS = ROOT / "data" / "app"


def _token():
    env = _env()
    if not env.get("ADMIN_USERNAME") or not env.get("ADMIN_PASSWORD"):
        raise SystemExit("ADMIN_USERNAME / ADMIN_PASSWORD missing in backend/.env")
    try:
        return _call("POST", "/api/auth/login", {"username": env["ADMIN_USERNAME"], "password": env["ADMIN_PASSWORD"]})["token"]
    except OSError as e:
        raise SystemExit(f"can't reach the backend at {API} ({e}); start it with `npm run dev` in backend/")


def _flat(rec):
    """One app record -> one flat row (scope_*, f_* features, o_* outcomes)."""
    o = rec.get("outcome", {})
    row = {"run_id": rec["_id"], "at": rec["at"], "database": rec.get("dbName"), "by": rec.get("by"), "source": rec.get("source"),
           "scope_term": rec.get("scope", {}).get("term"), "scope_branch": rec.get("scope", {}).get("branch") or "",
           "auto_assigned": rec.get("autoAssigned", 0)}
    row |= {f"f_{k}": v for k, v in rec.get("features", {}).items()}
    row |= {f"o_{k}": v for k, v in o.items() if not isinstance(v, (dict, list))}
    row["o_missing_walk"] = len(o.get("missingWalk") or [])
    for reason, n in (o.get("unscheduledReasons") or {}).items():
        key = ("no_teacher" if "teacher assigned" in reason else "no_room" if "rooms defined" in reason or "seats" in reason
               else "no_slot")
        row[f"o_unscheduled_{key}"] = row.get(f"o_unscheduled_{key}", 0) + n
    demand = o.get("demand") or 0
    row["o_placed_share"] = round((o.get("scheduled") or 0) / demand, 4) if demand else None
    return row


def pull(database=None, solve=0, time_limit=15):
    token = _token()
    q = "?snapshot=1" + (f"&db={database}" if database else "")
    req = urllib.request.Request(API + "/api/ml/runs" + q, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        records = [json.loads(line) for line in r.read().decode("utf8").splitlines() if line.strip()]
    OUT.mkdir(exist_ok=True)
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    new = []
    for rec in records:
        snap = SNAPSHOTS / f"{rec['_id']}.json"
        if not snap.exists():
            tables = {t: [{**row, "_status": "approved"} for row in rows] for t, rows in rec["snapshot"]["tables"].items()}
            snap.write_text(json.dumps({"format": "intellisched-database", "version": 1, "name": rec.get("dbName"), "onlyApproved": True,
                                        "settings": rec["snapshot"]["settings"], "tables": tables}), encoding="utf8")
            new.append((rec, snap))
    with open(OUT / "app_generations.jsonl", "w", encoding="utf8") as f:
        for rec in records:
            f.write(json.dumps({k: v for k, v in rec.items() if k != "snapshot"}) + "\n")
    flat = pd.DataFrame([_flat(r) for r in records])
    flat.to_csv(OUT / "app_generations.csv", index=False)
    print(f"{len(records)} generated timetables in the app ({len(new)} new) -> datasets/app_generations.jsonl, .csv; "
          f"input snapshots in data/app/")
    if solve and new:
        for rec, snap in new:
            term = rec.get("scope", {}).get("term") or "all"
            print(f"re-solving {snap.name} ({rec.get('dbName')}, term {term}) {solve} times with CP-SAT")
            solve_variants(snap, solve, time_limit, [None if term == "all" else term], f"app_{rec['_id'][:8]}")
    return flat


def build_solver_dataset():
    """runs/runs.csv (the CP-SAT log `train` uses) -> datasets/solver_runs.{csv,jsonl}, typed, with a source column."""
    df = pd.read_csv(ROOT / "runs" / "runs.csv")
    df.insert(2, "source", df.instance.map(lambda s: "app" if s.startswith("app_") else "live" if s.startswith("live_")
                                           else "synthetic" if s.startswith(("batch_", "synthetic_")) else "file"))
    df = df.drop(columns=["gen"])
    OUT.mkdir(exist_ok=True)
    df.to_csv(OUT / "solver_runs.csv", index=False)
    df.to_json(OUT / "solver_runs.jsonl", orient="records", lines=True)
    print(f"{len(df)} solver runs ({df.source.value_counts().to_dict()}) -> datasets/solver_runs.csv, .jsonl")
    return df
