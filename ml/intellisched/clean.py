"""Cleaning: repair what can be repaired, remove what can't, then filter to the term being scheduled.

Every change is logged with the row's original position, so nothing disappears silently:

  repaired  - value fixed in place ('  cse ' -> 'CSE', '4 hrs' -> 4, missing strength -> median)
  removed   - row dropped (duplicate, broken link, impossible value); `cascade` marks rows dropped
              only because a row they point to was dropped
  filtered  - row is valid but outside the chosen term / branches

The rules follow backend/src/schema.js (required fields, ranges, keys, references) plus a few
scheduler-specific checks the app does not make (an assignment whose subject is not taught in
that section's semester, two teachers for the same section + subject).
"""
import datetime as dt
import numbers
import re
from dataclasses import dataclass

import pandas as pd

from .schema import TABLES, TABLE_ORDER, columns, section_id, year_of

NUM = re.compile(r"^\s*(-?\d+(?:\.\d+)?)")


@dataclass
class CleanResult:
    data: dict
    log: pd.DataFrame

    def summary(self):
        if self.log.empty:
            return pd.DataFrame()
        return self.log.groupby(["table", "action", "rule"]).size().rename("rows").reset_index()


class _Log:
    def __init__(self):
        self.rows = []

    def add(self, table, row, action, rule, detail="", cascade=False):
        self.rows.append({"table": table, "row": int(row), "action": action, "rule": rule, "detail": detail, "cascade": cascade})

    def frame(self):
        return pd.DataFrame(self.rows, columns=["table", "row", "action", "rule", "detail", "cascade"])


def _blank(v):
    return v is None or (isinstance(v, float) and pd.isna(v)) or (isinstance(v, str) and not v.strip()) or v is pd.NA


def _time(v):
    if isinstance(v, (dt.time, dt.datetime)):
        return v.strftime("%H:%M")
    m = re.match(r"^\s*(\d{1,2}):(\d{2})", str(v))
    return f"{int(m[1]):02d}:{m[2]}" if m else None


# ------------------------------------------------------------------ step 1: repairs
def normalize(data, log=None):
    """Repairs only, never removes. Returns new tables with an `_row` column (original position)."""
    log = log or _Log()
    out = {}
    for name in TABLE_ORDER:
        df = data[name].copy().astype(object)
        df.insert(0, "_row", range(len(df)))
        for key, kind, _req, extra in TABLES[name]["columns"]:
            for i in df.index:
                v = df.at[i, key]
                if _blank(v):
                    df.at[i, key] = None
                    continue
                if kind in ("text", "ref", "select"):
                    s = str(v).strip()
                    if extra.get("upper"):
                        s = s.upper()
                    if kind == "select":
                        match = next((o for o in extra["options"] if str(o).lower() == s.lower()), None)
                        s = match if match is not None else s
                    if isinstance(v, str) and s != v:
                        log.add(name, df.at[i, "_row"], "repaired", "messy_text", f"{key}: {v!r} -> {s!r}")
                    df.at[i, key] = s
                elif kind == "number":
                    if isinstance(v, numbers.Number) and not isinstance(v, bool):
                        df.at[i, key] = int(v) if float(v).is_integer() else float(v)
                        continue
                    m = NUM.match(str(v))
                    if m:
                        n = float(m[1])
                        n = int(n) if n.is_integer() else n
                        log.add(name, df.at[i, "_row"], "repaired", "number_as_text", f"{key}: {v!r} -> {n}")
                        df.at[i, key] = n
                    else:
                        df.at[i, key] = None  # unparseable: handled as missing below
                elif kind == "time":
                    df.at[i, key] = _time(v)
        out[name] = df

    # Sections: strength missing or out of range -> median of the same branch + semester
    sec = out["Sections"]
    lo, hi = 1, 300
    ok = sec.Strength.map(lambda s: not _blank(s) and lo <= s <= hi)
    for i in sec.index[~ok]:
        same = sec[ok & (sec.BranchCode == sec.at[i, "BranchCode"]) & (sec.Semester == sec.at[i, "Semester"])].Strength
        pool = same if len(same) else sec[ok].Strength
        if len(pool):
            m = int(pd.Series(pool, dtype=float).median())
            log.add("Sections", sec.at[i, "_row"], "repaired", "strength_imputed", f"Strength {sec.at[i, 'Strength']!r} -> {m}")
            sec.at[i, "Strength"] = m

    # Teachers: weekly load outside 1..40 -> clipped
    tea = out["Teachers"]
    for i in tea.index:
        v = tea.at[i, "MaxWeeklyLoad"]
        if not _blank(v) and not 1 <= v <= 40:
            c = min(max(v, 1), 40)
            log.add("Teachers", tea.at[i, "_row"], "repaired", "load_clipped", f"MaxWeeklyLoad {v} -> {c}")
            tea.at[i, "MaxWeeklyLoad"] = c

    # Subjects: labs run as 2-period blocks, so odd lab hours round up
    sub = out["Subjects"]
    for i in sub.index[(sub.Type == "Lab") & sub.WeeklyHours.map(lambda h: isinstance(h, numbers.Integral) and h % 2 == 1)]:
        log.add("Subjects", sub.at[i, "_row"], "repaired", "lab_hours_even", f"WeeklyHours {sub.at[i, 'WeeklyHours']} -> {sub.at[i, 'WeeklyHours'] + 1}")
        sub.at[i, "WeeklyHours"] += 1

    # derived columns, exactly as the app derives them
    for df in (sec, sub):
        df["Year"] = df.Semester.map(lambda s: year_of(s) if isinstance(s, numbers.Number) else None)
    for i in sec.index:
        b, s, x = sec.at[i, "BranchCode"], sec.at[i, "Semester"], sec.at[i, "Section"]
        if b and isinstance(s, numbers.Number) and x:
            sec.at[i, "SectionID"] = section_id(b, s, x)
    return out, log


# ------------------------------------------------------------------ step 2: removals
def _drop(df, mask, table, rule, log, detail=None, cascade=False):
    for i in df.index[mask]:
        log.add(table, df.at[i, "_row"], "removed", rule, detail(df.loc[i]) if detail else "", cascade)
    return df[~mask]


def remove_invalid(data, log):
    out = dict(data)
    for name in TABLE_ORDER:
        df = out[name]
        spec = TABLES[name]
        # required fields (auto-derived ones included once derived)
        req = [k for k, _kind, r, _x in spec["columns"] if r]
        missing = df[req].isna().any(axis=1)
        df = _drop(df, missing, name, "missing_required", log, lambda r: "blank: " + ", ".join(k for k in req if _blank(r[k])))
        # selects with a value outside the options, numbers outside their range
        for key, kind, _r, extra in spec["columns"]:
            if kind == "select":
                bad = df[key].notna() & ~df[key].isin(extra["options"])
                df = _drop(df, bad, name, "invalid_option", log, lambda r, k=key: f"{k}={r[k]!r}")
            if kind == "number" and "min" in extra:
                v = df[key]
                bad = v.notna() & v.map(lambda x: not isinstance(x, numbers.Number) or not extra["min"] <= x <= extra["max"])
                df = _drop(df, bad, name, "out_of_range", log, lambda r, k=key: f"{k}={r[k]!r}")
        # duplicate keys: keep the first
        dup = df.duplicated(spec["key"], keep="first")
        df = _drop(df, dup, name, "duplicate_key", log, lambda r: "/".join(str(r[k]) for k in spec["key"]))
        out[name] = df

    def keys(table, col):
        return set(out[table][col].dropna())

    def refcheck(table, col, ref_table, ref_col, raw_keys, optional=False):
        df = out[table]
        live = keys(ref_table, ref_col)
        bad = df[col].notna() & ~df[col].isin(live)
        if optional:  # optional reference: blank it instead of losing the row
            for i in df.index[bad]:
                log.add(table, df.at[i, "_row"], "repaired", "unknown_reference", f"{col}={df.at[i, col]!r} blanked")
                df.loc[i, col] = None
            return
        was_there = df[col].isin(raw_keys)
        out[table] = _drop(df, bad & was_there, table, "broken_reference", log, lambda r: f"{col}={r[col]!r} was removed", cascade=True)
        df = out[table]
        bad = df[col].notna() & ~df[col].isin(live)
        out[table] = _drop(df, bad, table, "orphan_reference", log, lambda r: f"{col}={r[col]!r} does not exist")

    raw = {t: set(data[t][c].dropna()) for t, c in [("Branches", "BranchCode"), ("Teachers", "TeacherID"), ("Subjects", "SubjectCode"),
                                                    ("Sections", "SectionID"), ("Buildings", "BuildingCode")]}
    for t in ("Sections", "Subjects", "Teachers"):
        refcheck(t, "BranchCode", "Branches", "BranchCode", raw["Branches"])
    if len(out["Buildings"]):
        refcheck("Teachers", "HomeBuilding", "Buildings", "BuildingCode", raw["Buildings"], optional=True)
        for c in ("FromBuilding", "ToBuilding"):
            refcheck("BuildingTravel", c, "Buildings", "BuildingCode", raw["Buildings"])
    for t in ("TeacherPreferences", "TeacherAvailability", "TeacherSubjectMap"):
        refcheck(t, "TeacherID", "Teachers", "TeacherID", raw["Teachers"])
    for t in ("TeacherPreferences", "TeacherSubjectMap"):
        refcheck(t, "SubjectCode", "Subjects", "SubjectCode", raw["Subjects"])
    refcheck("TeacherSubjectMap", "SectionID", "Sections", "SectionID", raw["Sections"])

    # assignment must be for a subject of that section's own branch + semester
    tsm, sec, sub = out["TeacherSubjectMap"], out["Sections"].set_index("SectionID"), out["Subjects"]
    offered = set(zip(sub.BranchCode, sub.Semester, sub.SubjectCode))
    mism = tsm.apply(lambda r: (sec.at[r.SectionID, "BranchCode"], sec.at[r.SectionID, "Semester"], r.SubjectCode) not in offered, axis=1) if len(tsm) else tsm.index == -1
    tsm = _drop(tsm, mism, "TeacherSubjectMap", "semester_mismatch", log, lambda r: f"{r.SubjectCode} is not taught in {r.SectionID}")
    # one teacher per section + subject: keep the first
    conflict = tsm.duplicated(["SectionID", "SubjectCode"], keep="first")
    tsm = _drop(tsm, conflict, "TeacherSubjectMap", "conflicting_assignment", log, lambda r: f"{r.SectionID}/{r.SubjectCode} already has a teacher")
    # refresh derived columns from the section
    for c in ("BranchCode", "Year", "Semester", "Section"):
        tsm[c] = tsm.SectionID.map(sec[c])
    out["TeacherSubjectMap"] = tsm

    bt = out["BuildingTravel"]
    pair = bt.apply(lambda r: tuple(sorted((r.FromBuilding, r.ToBuilding))), axis=1) if len(bt) else pd.Series(dtype=object)
    bt = _drop(bt, bt.FromBuilding == bt.ToBuilding, "BuildingTravel", "self_travel", log)
    pair = pair[bt.index] if len(bt) else pair
    out["BuildingTravel"] = _drop(bt, pair.duplicated(), "BuildingTravel", "duplicate_key", log, lambda r: f"{r.FromBuilding}<->{r.ToBuilding}")
    ts = out["TimeSlots"]
    out["TimeSlots"] = _drop(ts, ts.StartTime >= ts.EndTime, "TimeSlots", "end_before_start", log)
    return out


# ------------------------------------------------------------------ step 3: term / branch filter
def scope(data, log, term=None, branches=None):
    """term: 'odd' | 'even' | None (all). branches: list of BranchCodes or None (all)."""
    out = dict(data)

    def keep_sem(s):
        return term is None or (term == "odd") == (int(s) % 2 == 1)

    for t in ("Sections", "Subjects"):
        df = out[t]
        mask = ~df.Semester.map(keep_sem) | (df.BranchCode.map(lambda b: branches is not None and b not in branches))
        for i in df.index[mask]:
            log.add(t, df.at[i, "_row"], "filtered", f"term={term or 'all'} branches={','.join(branches) if branches else 'all'}")
        out[t] = df[~mask]
    for t, col, ref in [("TeacherSubjectMap", "SectionID", "Sections")]:
        df = out[t]
        mask = ~df[col].isin(set(out[ref][col]))
        for i in df.index[mask]:
            log.add(t, df.at[i, "_row"], "filtered", "section out of scope")
        out[t] = df[~mask]
    return out


def clean(raw, term=None, branches=None):
    data, log = normalize(raw)
    data = remove_invalid(data, log)
    data = scope(data, log, term, branches)
    final = {name: df.drop(columns="_row").reset_index(drop=True) for name, df in data.items()}
    for name in final:
        df = final[name][columns(name)]
        for key, kind, _r, _x in TABLES[name]["columns"]:
            if kind == "number":
                df[key] = pd.to_numeric(df[key])
        final[name] = df
    return CleanResult(final, log.frame())


def score_cleaning(injected, log):
    """How many injected errors the cleaner caught, and how many clean rows it touched (false alarms)."""
    acted = log[log.action.isin(["repaired", "removed"])]
    hits = set(zip(acted.table, acted.row))
    action_of = {(r.table, r.row): r.action for r in acted.itertuples()}
    rows = []
    for r in injected.itertuples():
        got = action_of.get((r.table, r.row))
        rows.append({"kind": r.kind, "table": r.table, "row": r.row, "expected": r.expected, "got": got or "missed",
                     "correct": (got == "removed" and r.expected == "remove") or (got == "repaired" and r.expected == "repair")})
    per = pd.DataFrame(rows)
    primary = acted[~acted.cascade]
    injected_keys = set(zip(injected.table, injected.row))
    false_alarms = primary[[k not in injected_keys for k in zip(primary.table, primary.row)]]
    detected = per.got.ne("missed").mean() if len(per) else 1.0
    return {
        "injected": len(per), "detected": int(per.got.ne("missed").sum()) if len(per) else 0,
        "detection_rate": round(float(detected), 3),
        "correct_action_rate": round(float(per.correct.mean()), 3) if len(per) else 1.0,
        "false_alarms": len(false_alarms), "cascade_removals": int(acted.cascade.sum()), "hits": len(hits),
    }, per, false_alarms
