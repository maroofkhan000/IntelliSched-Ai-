"""Data analysis: data quality, patterns, and whether a timetable can exist at all.

Run on the raw workbook it shows what is wrong with the data (before cleaning). Run on the cleaned,
term-scoped data it is the feasibility gate before the solver: if a FAIL check is present, no
timetable can place every class, whatever the algorithm.
"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from .clean import normalize, remove_invalid  # noqa: E402
from .problem import Calendar, build_sessions, unavailable  # noqa: E402
from .schema import TABLES, TABLE_ORDER  # noqa: E402

# chart tokens (dataviz reference palette, light mode)
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
BLUE, ORANGE, CRITICAL = "#2a78d6", "#eb6834", "#d03b3b"
SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]


# ------------------------------------------------------------------ quality (raw data)
def quality(raw):
    """Per table: rows, blank required cells, duplicate keys, and what cleaning would do."""
    data, log = normalize(raw)
    remove_invalid(data, log)
    lg = log.frame()
    rows = []
    for name in TABLE_ORDER:
        df = raw[name]
        req = [k for k, _kind, r, _x in TABLES[name]["columns"] if r]
        t = lg[lg.table == name]
        rows.append({
            "table": name, "rows": len(df),
            "blank_required_cells": int(df[req].map(lambda v: v is None or (isinstance(v, float) and np.isnan(v)) or (isinstance(v, str) and not v.strip())).sum().sum()) if req and len(df) else 0,
            "to_repair": int((t.action == "repaired").sum()),
            "to_remove": int(((t.action == "removed") & ~t.cascade).sum()),
            "cascade": int(t.cascade.sum()),
        })
    return pd.DataFrame(rows), lg


# ------------------------------------------------------------------ patterns (clean data)
def patterns(data):
    sec, sub, tea, tsm = data["Sections"], data["Subjects"], data["Teachers"], data["TeacherSubjectMap"]
    out = {}
    pairs = sec.merge(sub, on=["BranchCode", "Semester"])
    out["hours_by_branch_semester"] = pairs.pivot_table(index="BranchCode", columns="Semester", values="WeeklyHours", aggfunc="sum", fill_value=0)
    out["section_weekly_hours"] = pairs.groupby("SectionID").WeeklyHours.sum().describe()
    out["subject_mix"] = sub.groupby("Type").agg(subjects=("SubjectCode", "count"), mean_hours=("WeeklyHours", "mean"))
    out["strength"] = sec.Strength.astype(float).describe()
    out["designations"] = tea.groupby("Designation").agg(teachers=("TeacherID", "count"), max_load=("MaxWeeklyLoad", "mean"))
    prefs = data["TeacherPreferences"]
    if len(prefs) and len(tsm):
        got = tsm.merge(prefs, on=["TeacherID", "SubjectCode"], how="left")
        out["assignment_preference"] = got.Priority.fillna(0).astype(int).map(lambda p: f"priority {p}" if p else "not in preferences").value_counts()
    return out


# ------------------------------------------------------------------ feasibility (clean, scoped data)
def feasibility(data):
    """Counting checks that any timetable must pass. Returns (checks DataFrame, detail frames)."""
    cal = Calendar.from_data(data)
    sessions, unassigned = build_sessions(data)
    ss = pd.DataFrame([s.__dict__ for s in sessions]) if sessions else pd.DataFrame(columns=["section", "subject", "teacher", "kind", "length", "strength"])
    rooms, tea = data["Rooms"], data["Teachers"].set_index("TeacherID")
    n_slots = len(cal.slots)
    lab_starts = len(cal.starts(2)) * len(cal.days)
    away = unavailable(data)
    checks = []

    def check(name, ok, value, limit, note, warn=False):
        checks.append({"check": name, "status": "PASS" if ok else ("WARN" if warn else "FAIL"), "value": value, "limit": limit, "note": note})

    theory = int(ss[ss.kind == "Theory"].length.sum())
    lab = ss[ss.kind == "Lab"]
    n_class, n_lab = int((rooms.RoomType == "Classroom").sum()), int((rooms.RoomType == "Lab").sum())
    check("Classroom periods", theory <= n_class * n_slots, theory, n_class * n_slots, f"{n_class} classrooms x {n_slots} slots")
    check("Lab blocks", int((lab.length == 2).sum()) <= n_lab * lab_starts, int((lab.length == 2).sum()), n_lab * lab_starts,
          f"{n_lab} labs x {lab_starts} two-period starts a week")
    big = rooms[rooms.RoomType == "Classroom"].Capacity.max() if n_class else 0
    too_big = data["Sections"][data["Sections"].Strength > big]
    check("Section fits a classroom", too_big.empty, len(too_big), 0, f"largest classroom seats {big}")
    big_lab = rooms[rooms.RoomType == "Lab"].Capacity.max() if n_lab else 0
    over_lab = data["Sections"][data["Sections"].Strength > big_lab]
    check("Section fits a lab", over_lab.empty, len(over_lab), 0, f"largest lab seats {big_lab}; bigger sections need batches", warn=True)
    check("Every class has a teacher", unassigned.empty, len(unassigned), 0, "section x subject pairs with no teacher")

    per_sec = ss.groupby("section").length.sum() if len(ss) else pd.Series(dtype=int)
    worst = int(per_sec.max()) if len(per_sec) else 0
    check("Section weekly hours fit the week", worst <= n_slots, worst, n_slots, "busiest section")

    load = ss.groupby("teacher").length.sum().rename("hours").to_frame() if len(ss) else pd.DataFrame(columns=["hours"])
    load["max"] = load.index.map(tea.MaxWeeklyLoad).astype(float)
    load["free_slots"] = [n_slots - sum(1 for d, p in cal.slots if (t, d, p) in away) for t in load.index]
    load["utilisation"] = load.hours / load["max"]
    over = load[load.hours > load["max"]]
    check("Teachers within weekly load", over.empty, len(over), 0, "teachers assigned more hours than their max")
    short = load[load.hours > load.free_slots]
    check("Teachers have enough free slots", short.empty, len(short), 0, "hours > slots left after unavailability")

    blocks = set(rooms.Building.dropna())
    have = set(map(frozenset, zip(data["BuildingTravel"].FromBuilding, data["BuildingTravel"].ToBuilding)))
    missing = [f"{a}-{b}" for a in sorted(blocks) for b in sorted(blocks) if a < b and frozenset((a, b)) not in have]
    check("Travel time for every block pair", not missing, len(missing), 0, ", ".join(missing[:6]) or "complete", warn=True)

    return pd.DataFrame(checks), {"teacher_load": load.sort_values("utilisation", ascending=False), "unassigned": unassigned,
                                  "sessions": ss, "too_big": too_big}


# ------------------------------------------------------------------ charts
def _axes(ax, title):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", color=INK, fontsize=11, fontweight="bold")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(AXIS)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.grid(axis="x", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def charts(data, detail, outdir, label):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.facecolor": SURFACE, "font.size": 9, "text.color": INK2, "axes.labelcolor": INK2})
    files = []

    # 1. teacher load vs their limit
    load = detail["teacher_load"].sort_values("utilisation")
    if len(load):
        fig, ax = plt.subplots(figsize=(7, max(3, 0.18 * len(load) + 1)))
        colors = [CRITICAL if u > 1 else BLUE for u in load.utilisation]
        ax.barh(load.index, load.utilisation * 100, color=colors, height=0.7)
        ax.axvline(100, color=INK2, linewidth=1, linestyle="--")
        ax.text(100, len(load) - 0.5, " max load", color=INK2, fontsize=8, va="bottom")
        _axes(ax, f"Teacher load as % of max weekly load ({label})")
        ax.set_xlabel("% of MaxWeeklyLoad (red = over the limit)")
        ax.tick_params(axis="y", labelsize=6)
        files.append(_save(fig, outdir / "teacher_load.png"))

    # 2. demand vs supply per room type
    ss, rooms, cal = detail["sessions"], data["Rooms"], Calendar.from_data(data)
    if len(ss):
        kinds = [("Classroom", "Theory"), ("Lab", "Lab")]
        demand = [int(ss[ss.kind == k].length.sum()) for _, k in kinds]
        supply = [int((rooms.RoomType == r).sum()) * len(cal.slots) for r, _ in kinds]
        fig, ax = plt.subplots(figsize=(6, 2.6))
        y = np.arange(len(kinds))
        ax.barh(y + 0.2, demand, height=0.38, color=BLUE, label="periods needed")
        ax.barh(y - 0.2, supply, height=0.38, color=ORANGE, label="room-periods available")
        for i in range(len(kinds)):
            ax.text(demand[i], y[i] + 0.2, f" {demand[i]}", va="center", fontsize=8, color=INK2)
            ax.text(supply[i], y[i] - 0.2, f" {supply[i]}", va="center", fontsize=8, color=INK2)
        ax.set_yticks(y, [r for r, _ in kinds])
        _axes(ax, f"Room demand vs supply per week ({label})")
        ax.set_xlim(0, max(demand + supply) * 1.12)
        ax.legend(frameon=False, fontsize=8, loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=2)
        files.append(_save(fig, outdir / "demand_vs_supply.png"))

    # 3. weekly hours per branch x semester
    pairs = data["Sections"].merge(data["Subjects"], on=["BranchCode", "Semester"])
    if len(pairs):
        pv = pairs.pivot_table(index="BranchCode", columns="Semester", values="WeeklyHours", aggfunc="sum", fill_value=0)
        files.append(_heat(pv, f"Weekly teaching hours by branch and semester ({label})", outdir / "hours_heatmap.png"))

    # 4. teacher unavailability by day x period
    ta = data["TeacherAvailability"]
    if len(ta):
        grid = pd.DataFrame(0, index=cal.days, columns=range(1, cal.periods + 1))
        for r in ta.itertuples():
            if r.Day in grid.index:
                ps = range(1, cal.periods + 1) if pd.isna(r.Period) else [int(r.Period)]
                for p in ps:
                    grid.at[r.Day, p] += 1
        files.append(_heat(grid, "Teachers unavailable, by day and period", outdir / "unavailability_heatmap.png"))

    # 5. section strength vs classroom capacity
    sec = data["Sections"]
    if len(sec):
        fig, ax = plt.subplots(figsize=(6, 2.6))
        ax.hist(sec.Strength.astype(float), bins=15, color=BLUE, edgecolor=SURFACE, linewidth=2)
        caps = rooms[rooms.RoomType == "Classroom"].Capacity
        if len(caps):
            ax.axvline(caps.max(), color=INK2, linestyle="--", linewidth=1)
            ax.text(caps.max(), ax.get_ylim()[1] * 0.9, " largest classroom", fontsize=8, color=INK2)
        _axes(ax, "Section strength")
        ax.grid(axis="y", color=GRID, linewidth=0.6)
        ax.set_xlabel("students per section")
        files.append(_save(fig, outdir / "strength.png"))
    return files


def _heat(df, title, path):
    from matplotlib.colors import ListedColormap
    df = df.astype(int)
    fig, ax = plt.subplots(figsize=(max(4, 0.6 * df.shape[1] + 2), max(2, 0.4 * df.shape[0] + 1)))
    ax.imshow(df.values, cmap=ListedColormap(SEQ), aspect="auto")
    vmax = df.values.max() or 1
    for i in range(df.shape[0]):
        for j in range(df.shape[1]):
            v = df.values[i, j]
            ax.text(j, i, v, ha="center", va="center", fontsize=8, color="#ffffff" if v > vmax * 0.55 else INK)
    ax.set_xticks(range(df.shape[1]), df.columns)
    ax.set_yticks(range(df.shape[0]), df.index)
    ax.set_title(title, loc="left", color=INK, fontsize=11, fontweight="bold")
    ax.tick_params(colors=MUTED, labelsize=8, length=0)
    for s in ax.spines.values():
        s.set_visible(False)
    return _save(fig, path)


def _save(fig, path):
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)
    return Path(path)


# ------------------------------------------------------------------ report
def write_report(path, title, sections):
    """sections: list of (heading, DataFrame | Series | str | list of image paths)."""
    path = Path(path)
    lines = [f"# {title}", ""]
    for heading, body in sections:
        lines += [f"## {heading}", ""]
        if isinstance(body, (pd.DataFrame, pd.Series)):
            lines.append(body.to_markdown() if len(body) else "_none_")
        elif isinstance(body, list):
            lines += [f"![{p.stem}]({p.relative_to(path.parent).as_posix()})" for p in body]
        else:
            lines.append(str(body))
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf8")
    return path
