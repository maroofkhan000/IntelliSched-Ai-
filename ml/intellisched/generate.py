"""Synthetic data generation.

The real dataset (timetable_dataset.xlsx) has no buildings, travel times, teacher
unavailability or subject preferences, and it is not schedulable as given (24 teachers carry
1,728 weekly hours). To develop and test the solver — and later to train the ML layer on many
solver runs — we need many realistic, *sized-to-fit* university instances. This module makes them.

Every instance uses the app's sheet layout, so it can also be imported into the app.

Sizing: rooms and teachers are sized for the busier of the two terms (odd / even semesters),
at a target utilisation, because a real college only runs one term at a time.

Noise: real data entry has typos, duplicates and broken links. `noise` corrupts a share of rows
the way a person would, and records each corruption in an `_Injected` sheet (the ground truth),
so the cleaning step can be scored on how many it catches.
"""
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from .schema import DAYS, section_id, year_of
from .workbook import save_workbook

CATALOG = Path(__file__).resolve().parents[2] / "frontend" / "src" / "subjectCatalog.json"

BRANCH_NAMES = {
    "CSE": "Computer Science & Engineering", "AIML": "CSE (Artificial Intelligence & Machine Learning)",
    "DSAI": "CSE (Data Science & Artificial Intelligence)", "ECE": "Electronics & Communication Engineering",
    "EE": "Electrical Engineering", "ME": "Mechanical Engineering", "CE": "Civil Engineering",
    "ECS": "Electronics & Computer Science",
}
FIRST = ["Aman", "Priya", "Rahul", "Sana", "Imran", "Neha", "Vikas", "Ayesha", "Rohit", "Fatima", "Arjun", "Meera",
         "Faisal", "Kavya", "Sameer", "Zoya", "Nitin", "Huma", "Deepak", "Anjali", "Tariq", "Pooja", "Kunal", "Nida"]
LAST = ["Sharma", "Khan", "Verma", "Siddiqui", "Gupta", "Ansari", "Singh", "Rizvi", "Mishra", "Qureshi", "Yadav", "Hasan"]
DESIGNATIONS = [  # (designation, share, max weekly load)
    ("Professor", 0.10, 14), ("Associate Professor", 0.20, 16), ("Assistant Professor", 0.55, 18),
    ("Lecturer", 0.10, 20), ("Visiting Faculty", 0.05, 10),
]
# campus layout in metres; walking speed ~70 m/min
BUILDINGS = {"A": ("Academic Block A", (0, 0)), "B": ("Academic Block B", (160, 0)),
             "C": ("Academic Block C", (0, 220)), "L": ("Laboratory Block", (260, 260))}
# 50-minute periods, 5 minutes to change rooms, a tea break after P2 and lunch after P4
TIMINGS = [("09:00", "09:50"), ("09:55", "10:45"), ("11:00", "11:50"), ("11:55", "12:45"), ("13:30", "14:20"), ("14:25", "15:15")]


@dataclass
class GenConfig:
    seed: int = 1
    branches: list = field(default_factory=lambda: ["CSE", "ECE", "EE", "ME"])
    semesters: int = 8
    sections_per_semester: tuple = (1, 2)   # inclusive range, drawn per branch-semester
    strength: tuple = (60, 8)               # mean, std dev
    room_utilisation: float = 0.70          # demand / supply for the busier term
    teacher_utilisation: float = 0.80       # demand / total max weekly load, busier term
    unavailable_share: float = 0.20         # share of teachers with blocked slots
    noise: float = 0.0                      # share of rows to corrupt (0.02 = 2 %)


def _catalog():
    try:
        return pd.DataFrame(json.loads(CATALOG.read_text(encoding="utf8")))
    except FileNotFoundError:
        return pd.DataFrame(columns=["SubjectCode", "BranchCode", "Semester", "SubjectName", "Type", "Credits", "WeeklyHours"])


def _subjects(rng, branch, sem, catalog):
    """4–5 theory subjects (3–4 h) and 1–2 labs (2 h) for one branch-semester; real names when the catalog has them."""
    real = catalog[(catalog.BranchCode == branch) & (catalog.Semester == sem)]
    n_th, n_lab = int(rng.integers(4, 6)), int(rng.integers(1, 3))
    out = []
    for typ, n in (("Theory", n_th), ("Lab", n_lab)):
        pool = real[real.Type == typ]
        names = list(pool.SubjectName.sample(n=min(n, len(pool)), random_state=int(rng.integers(1e9)))) if len(pool) else []
        for i in range(n):
            name = names[i] if i < len(names) else f"{branch} {typ} {sem}.{i + 1}"
            hours = 2 if typ == "Lab" else int(rng.choice([3, 4], p=[0.4, 0.6]))
            code = f"{branch}{sem}{'L' if typ == 'Lab' else '0'}{i + 1}"
            out.append({"SubjectCode": code, "BranchCode": branch, "Year": year_of(sem), "Semester": sem, "SubjectName": name,
                        "Type": typ, "Credits": 1 if typ == "Lab" else hours, "WeeklyHours": hours})
    return out


def generate(cfg: GenConfig):
    rng = np.random.default_rng(cfg.seed)
    catalog = _catalog()
    branches = cfg.branches
    data = {}

    data["Branches"] = pd.DataFrame([{"Degree": "B.Tech", "BranchCode": b, "BranchName": BRANCH_NAMES.get(b, b),
                                      "TotalYears": math.ceil(cfg.semesters / 2), "SemestersPerYear": 2} for b in branches])

    sections, subjects = [], []
    for b in branches:
        for sem in range(1, cfg.semesters + 1):
            subjects += _subjects(rng, b, sem, catalog)
            lo, hi = cfg.sections_per_semester
            for k in range(int(rng.integers(lo, hi + 1))):
                letter = "ABCDEFGH"[k]
                strength = int(np.clip(rng.normal(*cfg.strength), 30, 90))
                sections.append({"SectionID": section_id(b, sem, letter), "BranchCode": b, "Year": year_of(sem),
                                 "Semester": sem, "Section": letter, "Strength": strength})
    data["Sections"] = pd.DataFrame(sections)
    data["Subjects"] = pd.DataFrame(subjects)
    sec, sub = data["Sections"], data["Subjects"]

    # demand per term (1 = odd semesters, 0 = even), split by theory / lab and branch
    pairs = sec.merge(sub, on=["BranchCode", "Semester"], suffixes=("", "_sub"))
    pairs["term"] = pairs.Semester % 2
    demand = pairs.groupby(["term", "BranchCode", "Type"]).WeeklyHours.sum()

    # ---- buildings, travel, time slots ----
    data["Buildings"] = pd.DataFrame([{"BuildingCode": c, "BuildingName": n, "Campus": "Main", "HasLift": "Yes" if c in "AL" else "No"}
                                      for c, (n, _) in BUILDINGS.items()])
    codes = list(BUILDINGS)
    travel = []
    for i, x in enumerate(codes):
        for y in codes[i + 1:]:
            (x1, y1), (x2, y2) = BUILDINGS[x][1], BUILDINGS[y][1]
            travel.append({"FromBuilding": x, "ToBuilding": y, "WalkMinutes": round(math.dist((x1, y1), (x2, y2)) / 70) + 1})
    data["BuildingTravel"] = pd.DataFrame(travel)
    data["TimeSlots"] = pd.DataFrame([{"Day": d, "Period": p + 1, "StartTime": s, "EndTime": e} for d in DAYS for p, (s, e) in enumerate(TIMINGS)])
    slots = len(DAYS) * len(TIMINGS)

    # ---- rooms: classrooms spread over A/B/C, labs in L, sized for the busier term ----
    theory_need = max(demand.xs("Theory", level="Type").groupby(level="term").sum())
    lab_need = max(demand.xs("Lab", level="Type").groupby(level="term").sum())
    n_class = math.ceil(theory_need / (slots * cfg.room_utilisation))
    n_lab = math.ceil(lab_need / (slots * cfg.room_utilisation))
    max_strength = int(sec.Strength.max())
    rooms = []
    for i in range(n_class):
        blk = "ABC"[i % 3]
        floor, no = i // 3 // 6 + 1, i // 3 % 6 + 1
        cap = int(rng.choice([60, 66, 72, 90], p=[0.35, 0.3, 0.25, 0.1]))
        rooms.append({"RoomID": f"{blk}{floor}{no:02d}", "RoomType": "Classroom", "Capacity": cap, "Building": blk, "Floor": floor, "RoomNo": no})
    rooms[0]["Capacity"] = max(rooms[0]["Capacity"], max_strength)  # at least one room seats the biggest section
    for i in range(n_lab):
        rooms.append({"RoomID": f"L{i // 6 + 1}{i % 6 + 1:02d}", "RoomType": "Lab", "Capacity": int(rng.choice([40, 60], p=[0.3, 0.7])),
                      "Building": "L", "Floor": i // 6 + 1, "RoomNo": i % 6 + 1})
    data["Rooms"] = pd.DataFrame(rooms)

    # ---- teachers per branch and type, sized for the busier term ----
    home = {b: "ABC"[i % 3] for i, b in enumerate(branches)}
    shares = np.array([d[1] for d in DESIGNATIONS])
    avg_load = float(sum(d[1] * d[2] for d in DESIGNATIONS))
    teachers, counters = [], {"Theory": 0, "Lab": 0}
    for b in branches:
        for typ, prefix in (("Theory", "TT"), ("Lab", "TL")):
            need = max(demand.get((t, b, typ), 0) for t in (0, 1))
            for _ in range(max(1, math.ceil(need / (avg_load * cfg.teacher_utilisation)))):
                counters[typ] += 1
                desig, _, load = DESIGNATIONS[rng.choice(len(DESIGNATIONS), p=shares)]
                r = rng.random()
                teachers.append({
                    "TeacherID": f"{prefix}{counters[typ]:04d}", "TeacherType": typ,
                    "Name": f"{rng.choice(FIRST)} {rng.choice(LAST)}", "BranchCode": b, "Designation": desig, "MaxWeeklyLoad": load,
                    "HomeBuilding": "L" if typ == "Lab" else home[b],
                    "MaxBuildingChanges": None if r < 0.7 else int(rng.integers(1, 4)),
                    "ExtraTravelMinutes": 5 if rng.random() < 0.1 else None,
                })
    data["Teachers"] = pd.DataFrame(teachers)
    tea = data["Teachers"]

    # ---- subject preferences: 3–6 subjects of their branch and type, at most 2 at priority 1 ----
    prefs = []
    for t in tea.itertuples():
        pool = sub[(sub.BranchCode == t.BranchCode) & (sub.Type == t.TeacherType)].SubjectCode.tolist()
        picks = rng.choice(pool, size=min(len(pool), int(rng.integers(3, 7))), replace=False)
        exp = int(rng.integers(1, 25))
        for i, code in enumerate(picks):
            prefs.append({"TeacherID": t.TeacherID, "SubjectCode": code, "Priority": 1 if i < 2 else int(rng.integers(2, 6)),
                          "ExperienceYears": exp, "TimesTaught": int(rng.integers(0, 10)), "ResearchPapers": int(rng.poisson(2)), "Remarks": None})
    data["TeacherPreferences"] = pd.DataFrame(prefs)
    pref_rank = {(p["TeacherID"], p["SubjectCode"]): p["Priority"] for p in prefs}

    # ---- teaching assignments: preferred teacher with room in their term load, else least loaded ----
    load = {(t, term): 0 for t in tea.TeacherID for term in (0, 1)}
    cap = dict(zip(tea.TeacherID, tea.MaxWeeklyLoad))
    assign = []
    for p in pairs.sort_values("WeeklyHours", ascending=False).itertuples():
        cands = tea[(tea.BranchCode == p.BranchCode) & (tea.TeacherType == p.Type)].TeacherID.tolist()
        fits = [t for t in cands if load[(t, p.term)] + p.WeeklyHours <= cap[t]] or cands
        best = min(fits, key=lambda t: (pref_rank.get((t, p.SubjectCode), 9), load[(t, p.term)] / cap[t], rng.random()))
        load[(best, p.term)] += p.WeeklyHours
        assign.append({"TeacherID": best, "SubjectCode": p.SubjectCode, "SectionID": p.SectionID, "BranchCode": p.BranchCode,
                       "Year": p.Year, "Semester": p.Semester, "Section": p.Section})
    data["TeacherSubjectMap"] = pd.DataFrame(assign)

    # ---- teacher unavailability: a few blocked periods, sometimes a whole day ----
    away = []
    for t in tea.TeacherID:
        if rng.random() >= cfg.unavailable_share:
            continue
        if rng.random() < 0.3:
            away.append({"TeacherID": t, "Day": str(rng.choice(DAYS)), "Period": None, "Reason": str(rng.choice(["Leave", "Other campus"]))})
        else:
            for d, p in {(str(rng.choice(DAYS)), int(rng.integers(1, len(TIMINGS) + 1))) for _ in range(int(rng.integers(1, 4)))}:
                away.append({"TeacherID": t, "Day": d, "Period": p, "Reason": str(rng.choice(["Admin duty", "Exam duty", "Other"]))})
    data["TeacherAvailability"] = pd.DataFrame(away, columns=["TeacherID", "Day", "Period", "Reason"])

    for name in data:
        data[name] = data[name].astype(object)
    injected = inject_noise(data, rng, cfg.noise) if cfg.noise > 0 else pd.DataFrame(columns=["table", "row", "kind", "expected"])
    return data, injected


# ---------------------------------------------------------------- noise injection
# kind -> (table, what the cleaner should do)
NOISE_KINDS = {
    "duplicate_row": (["Sections", "Subjects", "TeacherSubjectMap", "Rooms"], "remove"),
    "messy_code": (["Sections", "Subjects", "Teachers"], "repair"),          # ' cse ' instead of 'CSE'
    "number_as_text": (["Sections", "Subjects"], "repair"),                  # '60' stored as text, '4 hrs'
    "missing_strength": (["Sections"], "repair"),                            # blank -> branch/semester median
    "strength_out_of_range": (["Sections"], "repair"),                       # 0 or 999 -> median
    "odd_lab_hours": (["Subjects"], "repair"),                               # lab with 3 h -> 4 h
    "load_out_of_range": (["Teachers"], "repair"),                           # 80 h -> clipped to 40
    "orphan_teacher": (["TeacherSubjectMap"], "remove"),                     # teacher ID that does not exist
    "orphan_branch": (["Sections"], "remove"),                               # branch that does not exist
    "conflicting_assignment": (["TeacherSubjectMap"], "remove"),            # 2nd teacher for same section+subject
    "semester_mismatch": (["TeacherSubjectMap"], "remove"),                 # subject not in that section's semester
    "missing_key": (["Subjects", "Rooms"], "remove"),                        # blank SubjectCode / RoomID
}


def inject_noise(data, rng, share):
    total = sum(len(df) for name, df in data.items() if name in {"Sections", "Subjects", "Teachers", "TeacherSubjectMap", "Rooms"})
    n = max(1, round(total * share))
    log, touched = [], set()
    kinds = list(NOISE_KINDS)

    def pick(table):
        df = data[table]
        free = [i for i in range(len(df)) if (table, i) not in touched]
        i = int(rng.choice(free))
        touched.add((table, i))
        return i

    def append(table, row):
        data[table] = pd.concat([data[table], pd.DataFrame([row])], ignore_index=True).astype(object)
        i = len(data[table]) - 1
        touched.add((table, i))
        return i

    for _ in range(n):
        kind = str(rng.choice(kinds))
        tables, expected = NOISE_KINDS[kind]
        table = str(rng.choice(tables))
        df = data[table]
        if kind == "duplicate_row":
            src = pick(table)
            row = append(table, df.iloc[src].to_dict())
        elif kind == "messy_code":
            row = pick(table)
            col = "TeacherID" if table == "Teachers" else "BranchCode"
            df.at[row, col] = f" {str(df.at[row, col]).lower()} "
        elif kind == "number_as_text":
            row = pick(table)
            col = "Strength" if table == "Sections" else "WeeklyHours"
            df.at[row, col] = f"{df.at[row, col]} hrs" if col == "WeeklyHours" else str(df.at[row, col])
        elif kind == "missing_strength":
            row = pick(table)
            df.at[row, "Strength"] = None
        elif kind == "strength_out_of_range":
            row = pick(table)
            df.at[row, "Strength"] = int(rng.choice([0, 999]))
        elif kind == "odd_lab_hours":
            labs = [i for i in df.index[df.Type == "Lab"] if (table, i) not in touched]
            if not labs:
                continue
            row = int(rng.choice(labs))
            touched.add((table, row))
            df.at[row, "WeeklyHours"] = 3
        elif kind == "load_out_of_range":
            row = pick(table)
            df.at[row, "MaxWeeklyLoad"] = 80
        elif kind == "orphan_teacher":
            src = df.iloc[pick(table)].to_dict()
            row = append(table, {**src, "TeacherID": "TT9999"})
        elif kind == "orphan_branch":
            src = df.iloc[pick(table)].to_dict()
            row = append(table, {**src, "BranchCode": "XYZ", "SectionID": src["SectionID"].replace(src["BranchCode"], "XYZ", 1)})
        elif kind == "conflicting_assignment":
            src = df.iloc[pick(table)].to_dict()
            others = data["Teachers"][(data["Teachers"].BranchCode == src["BranchCode"]) & (data["Teachers"].TeacherID != src["TeacherID"])]
            if others.empty:
                continue
            row = append(table, {**src, "TeacherID": str(rng.choice(others.TeacherID))})
        elif kind == "semester_mismatch":
            src = df.iloc[pick(table)].to_dict()
            secs = data["Sections"]
            wrong = secs[(secs.BranchCode == src["BranchCode"]) & (secs.Semester != src["Semester"])]
            if wrong.empty:
                continue
            w = wrong.iloc[int(rng.integers(len(wrong)))]
            row = append(table, {**src, "SectionID": w.SectionID, "Semester": w.Semester, "Year": w.Year, "Section": w.Section})
        elif kind == "missing_key":
            row = pick(table)
            df.at[row, "SubjectCode" if table == "Subjects" else "RoomID"] = None
        log.append({"table": table, "row": row, "kind": kind, "expected": expected})
    return pd.DataFrame(log)


def generate_to_file(cfg: GenConfig, path):
    data, injected = generate(cfg)
    path = save_workbook(data, path)
    if len(injected):
        with pd.ExcelWriter(path, engine="openpyxl", mode="a") as xw:
            injected.to_excel(xw, sheet_name="_Injected", index=False)
    return path, data, injected
