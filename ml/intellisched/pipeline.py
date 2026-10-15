"""End-to-end pipeline: generate -> analyse -> clean & filter -> feasibility gate -> solve -> log.

Each run appends one row to runs/runs.csv: instance features, solver weights and results.
That file is the training data for the ML layer (weight tuning, feasibility prediction).
"""
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from . import analyze
from .clean import clean, score_cleaning
from .generate import GenConfig, generate_to_file
from .solver import DEFAULT_WEIGHTS, solve, verify
from .workbook import load_workbook, save_workbook

ROOT = Path(__file__).resolve().parents[1]


def instance_features(data, checks, detail):
    """Numbers that describe how hard an instance is (inputs for the ML models)."""
    c = checks.set_index("check")
    ss, load = detail["sessions"], detail["teacher_load"]
    return {
        "n_sections": len(data["Sections"]), "n_subjects": len(data["Subjects"]), "n_teachers": int(len(load)),
        "n_rooms": len(data["Rooms"]), "n_blocks": int(data["Rooms"].Building.nunique()), "n_sessions": len(ss),
        "classroom_util": round(c.at["Classroom periods", "value"] / max(1, c.at["Classroom periods", "limit"]), 3),
        "lab_util": round(c.at["Lab blocks", "value"] / max(1, c.at["Lab blocks", "limit"]), 3),
        "teacher_util_mean": round(float(load.utilisation.mean()), 3) if len(load) else 0,
        "teacher_util_max": round(float(load.utilisation.max()), 3) if len(load) else 0,
        "unavailable_rows": len(data["TeacherAvailability"]),
        "fail_checks": int((checks.status == "FAIL").sum()),
    }


def run(input_path=None, term="odd", branches=None, gen=None, weights=None, time_limit=60, name=None, quiet=False, charts=True):
    say = (lambda *a: None) if quiet else print
    name = name or (Path(input_path).stem if input_path else f"synthetic_seed{gen.seed}")
    out = ROOT / "reports" / name
    out.mkdir(parents=True, exist_ok=True)

    # 1. data generation
    injected = None
    if input_path is None:
        gen = gen or GenConfig()
        input_path, _, injected = generate_to_file(gen, ROOT / "data" / "synthetic" / f"{name}.xlsx")
        say(f"[1/5] generated {input_path.relative_to(ROOT)}  ({len(injected)} injected errors)")
    else:
        try:
            injected = pd.read_excel(input_path, sheet_name="_Injected")
        except ValueError:
            injected = None
        say(f"[1/5] loaded {input_path}")
    raw = load_workbook(input_path)

    # 2. data analysis on the raw data (quality) and the whole catalog (patterns)
    q, _ = analyze.quality(raw)
    whole = clean(raw).data
    pats = analyze.patterns(whole)
    all_checks, all_detail = analyze.feasibility(whole)
    files = analyze.charts(whole, all_detail, out / "all", "all terms") if charts else []
    analyze.write_report(out / "01_analysis.md", f"Data analysis: {name}", [
        ("Data quality (raw workbook)", q.set_index("table")),
        ("Weekly hours by branch and semester", pats["hours_by_branch_semester"]),
        ("Hours per section", pats["section_weekly_hours"]),
        ("Subject mix", pats["subject_mix"]),
        ("Section strength", pats["strength"]),
        ("Teachers by designation", pats["designations"]),
        ("Were teachers given subjects they asked for?", pats.get("assignment_preference", "no preference data")),
        ("Feasibility if ALL semesters ran at once", all_checks.set_index("check")),
        ("Charts", files),
    ])
    say(f"[2/5] analysis -> {(out / '01_analysis.md').relative_to(ROOT)}  "
        f"(whole catalog: {int((all_checks.status == 'FAIL').sum())} FAIL checks)")

    # 3. removal & filter
    res = clean(raw, term=term, branches=branches)
    clean_path = save_workbook(res.data, ROOT / "data" / "clean" / f"{name}_{term or 'all'}.xlsx")
    res.log.to_csv(out / "cleaning_log.csv", index=False)
    parts = [("What changed", res.summary().set_index(["table", "action", "rule"]) if len(res.log) else "nothing")]
    score = None
    if injected is not None and len(injected):
        score, per, false_alarms = score_cleaning(injected, res.log)
        parts += [("Score against the injected errors", pd.Series(score)), ("Per injected error", per), ("False alarms", false_alarms)]
    parts.append(("Rows kept", pd.Series({t: len(df) for t, df in res.data.items()})))
    analyze.write_report(out / "02_cleaning.md", f"Cleaning and filtering: {name} (term={term or 'all'})", parts)
    acted = res.log[res.log.action != "filtered"]
    say(f"[3/5] cleaned -> {clean_path.relative_to(ROOT)}  repaired {int((acted.action == 'repaired').sum())}, "
        f"removed {int((acted.action == 'removed').sum())}, filtered {int((res.log.action == 'filtered').sum())}"
        + (f"  | caught {score['detected']}/{score['injected']} injected, {score['false_alarms']} false alarms" if score else ""))

    # 4. feasibility gate on the term that will be scheduled
    checks, detail = analyze.feasibility(res.data)
    files = analyze.charts(res.data, detail, out / "term", f"term={term or 'all'}") if charts else []
    analyze.write_report(out / "03_feasibility.md", f"Feasibility gate: {name} (term={term or 'all'})", [
        ("Checks", checks.set_index("check")), ("Teacher load", detail["teacher_load"]),
        ("Unassigned classes", detail["unassigned"]), ("Charts", files)])
    fails = checks[checks.status == "FAIL"]
    say(f"[4/5] feasibility: {len(checks) - len(fails)}/{len(checks)} checks pass"
        + ("" if fails.empty else f"  FAIL: {', '.join(fails.check)} (solver will report what doesn't fit)"))

    # 5. solve and verify
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    sol = solve(res.data, weights=w, time_limit=time_limit)
    problems = verify(sol.timetable, res.data)
    tt_path = out / "timetable.xlsx"
    with pd.ExcelWriter(tt_path, engine="openpyxl") as xw:
        (sol.timetable.drop(columns=["Session", "Strength"], errors="ignore") if len(sol.timetable) else sol.timetable).to_excel(xw, sheet_name="Timetable", index=False)
        sol.unplaced.to_excel(xw, sheet_name="Unplaced", index=False)
        pd.Series(sol.stats).to_frame("value").to_excel(xw, sheet_name="Stats")
    analyze.write_report(out / "04_solution.md", f"Timetable: {name} (term={term or 'all'})", [
        ("Solver", pd.Series(sol.stats)), ("Hard-rule check (independent)", "\n".join(f"- {p}" for p in problems) or "No violations."),
        ("Unplaced sessions", sol.unplaced)])
    say(f"[5/5] {sol.status}: {sol.stats.get('placed_periods', 0)} periods placed, {sol.stats.get('unplaced_sessions', '?')} sessions unplaced, "
        f"{len(problems)} hard-rule violations, {sol.stats.get('solve_seconds')}s -> {tt_path.relative_to(ROOT)}")

    # run log = ML training data
    row = {"time": datetime.now().isoformat(timespec="seconds"), "instance": name, "term": term or "all",
           "gen": json.dumps(gen.__dict__) if gen else "", "time_limit": time_limit,
           **instance_features(res.data, checks, detail), **{f"w_{k}": v for k, v in w.items()},
           **{k: v for k, v in sol.stats.items()}, "violations": len(problems)}
    log_path = ROOT / "runs" / "runs.csv"
    log_path.parent.mkdir(exist_ok=True)
    out = pd.DataFrame([row])
    if log_path.exists():  # line up with the existing header: a solve may not report every stat
        header = pd.read_csv(log_path, nrows=0).columns
        extra = [c for c in out.columns if c not in header]
        if extra:  # new stats: rewrite the log once with the wider header
            pd.concat([pd.read_csv(log_path), out], ignore_index=True).to_csv(log_path, index=False)
            return sol, row
        out = out.reindex(columns=header)
    out.to_csv(log_path, mode="a", header=not log_path.exists(), index=False)
    return sol, row


def batch(n=20, start_seed=100, time_limit=20, term="odd"):
    """Many random instances x random weights -> runs/runs.csv (training data for the ML layer)."""
    rng = np.random.default_rng(start_seed)
    pool = ["CSE", "ECE", "EE", "ME", "CE", "AIML", "DSAI"]
    rows = []
    for k in range(n):
        seed = start_seed + k
        gen = GenConfig(
            seed=seed, branches=list(rng.choice(pool, size=int(rng.integers(2, 6)), replace=False)),
            sections_per_semester=(1, int(rng.integers(1, 4))), room_utilisation=round(float(rng.uniform(0.5, 1.05)), 2),
            teacher_utilisation=round(float(rng.uniform(0.6, 1.05)), 2), unavailable_share=round(float(rng.uniform(0, 0.4)), 2),
            noise=round(float(rng.uniform(0, 0.04)), 3))
        weights = {k: (v if k == "unplaced" else max(0, round(v * math.exp(rng.normal(0, 0.8)), 1))) for k, v in DEFAULT_WEIGHTS.items()}
        _, row = run(gen=gen, term=term, weights=weights, time_limit=time_limit, name=f"batch_seed{seed}", quiet=True, charts=False)
        rows.append(row)
        print(f"  {k + 1}/{n} seed {seed}: {row['n_sessions']} sessions, util {row['classroom_util']}/{row['teacher_util_max']} "
              f"-> {row['status']}, unplaced {row.get('unplaced_sessions')}, {row['solve_seconds']}s")
    return pd.DataFrame(rows)
