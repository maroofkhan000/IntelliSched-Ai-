"""Timetable solver with Google OR-Tools CP-SAT.

Stage 1 (CP-SAT, the big model) decides for every session its day, start period and BLOCK.
  z[s, d, p, b] = 1  ->  session s starts on day d, period p, in a room of block b
  u[s] = 1           ->  session s could not be placed (heavily penalised, so the solver always
                         returns a timetable and says exactly what did not fit)

Stage 2 (one tiny CP-SAT per day x block x room type) picks the actual room. Stage 1 already
guarantees enough rooms of each size in every block and period (Hall's condition for nested
capacities), so stage 2 practically always succeeds.

Hard rules (never broken):
  H1 a section is in one class at a time        H5 the teacher's unavailable slots are never used
  H2 a teacher is in one class at a time        H6 multi-period sessions (labs) run back to back
  H3 rooms: per block and period, never more       and never across a break
     classes than rooms that seat them          H7 a teacher who changes block between two classes
  H4 a teacher's weekly hours <= MaxWeeklyLoad     has at least WalkMinutes (+ ExtraTravelMinutes)
                                                   of gap between them
                                                H8 blocks used per day <= MaxBuildingChanges + 1
Soft rules (weighted, minimised) — the weights are what the ML layer will learn to tune:
  unplaced, spread (same subject twice a day), home (class outside the teacher's home block),
  blocks (extra blocks a teacher visits in a day), balance (a section's busiest day),
  late (classes in the last period of the day)
"""
import time
from collections import defaultdict
from dataclasses import dataclass, field

import pandas as pd
from ortools.sat.python import cp_model

from .problem import Calendar, build_sessions, unavailable

DEFAULT_WEIGHTS = {"unplaced": 1000, "spread": 20, "home": 2, "blocks": 8, "balance": 5, "late": 1}


@dataclass
class SolveResult:
    status: str
    timetable: pd.DataFrame
    unplaced: pd.DataFrame
    stats: dict = field(default_factory=dict)


def _travel(data):
    walk = {}
    for r in data["BuildingTravel"].itertuples():
        walk[(r.FromBuilding, r.ToBuilding)] = walk[(r.ToBuilding, r.FromBuilding)] = int(r.WalkMinutes)
    return walk


def solve(data, weights=None, time_limit=60, workers=8, seed=0, hints=None, log_progress=False, params=None):
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    t0 = time.time()
    cal = Calendar.from_data(data)
    sessions, unassigned = build_sessions(data)
    open_slots = set(zip(data["TimeSlots"].Day, data["TimeSlots"].Period.astype(int))) or set(cal.slots)
    away = unavailable(data)
    walk = _travel(data)
    tea = data["Teachers"].set_index("TeacherID")
    rooms = data["Rooms"].copy()
    rooms["kind"] = rooms.RoomType.map({"Classroom": "Theory", "Lab": "Lab"})
    sub_name = dict(zip(data["Subjects"].SubjectCode, data["Subjects"].SubjectName))

    room_caps = defaultdict(list)  # (block, kind) -> capacities
    for r in rooms.itertuples():
        room_caps[(r.Building, r.kind)].append(int(r.Capacity))

    m = cp_model.CpModel()
    z = {}                               # (s, d, p, b) -> var
    cover = defaultdict(list)            # (s.id, d, q) -> vars that occupy period q
    by_sec, by_tea = defaultdict(set), defaultdict(set)
    options = defaultdict(list)          # s.id -> [(d, p, b)]
    u = {}
    for s in sessions:
        blocks = [b for (b, k), caps in room_caps.items() if k == s.kind and (s.kind == "Lab" or max(caps) >= s.strength)]
        opts = []
        for d in cal.days:
            for p in cal.starts(s.length):
                span = range(p, p + s.length)
                if any((d, q) not in open_slots or (s.teacher, d, q) in away for q in span):
                    continue
                for b in blocks:
                    v = m.NewBoolVar(f"z{s.id}_{d[:2]}{p}{b}")
                    z[(s.id, d, p, b)] = v
                    opts.append(v)
                    options[s.id].append((d, p, b))
                    for q in span:
                        cover[(s.id, d, q)].append((v, b))
        u[s.id] = m.NewBoolVar(f"u{s.id}")
        m.AddExactlyOne(opts + [u[s.id]])
        by_sec[s.section].add(s.id)
        by_tea[s.teacher].add(s.id)
    S = {s.id: s for s in sessions}

    def occ(ids, d, q, block=None):
        return [v for i in ids for v, b in cover.get((i, d, q), []) if block is None or b == block]

    # H1, H2: one class at a time for every section and teacher
    for group in (by_sec, by_tea):
        for ids in group.values():
            for d, q in cal.slots:
                vs = occ(ids, d, q)
                if len(vs) > 1:
                    m.AddAtMostOne(vs)

    # H3: rooms per block, kind and period, with nested capacity thresholds
    by_kind = defaultdict(set)
    for s in sessions:
        by_kind[s.kind].add(s.id)
    for (b, k), caps in room_caps.items():
        thresholds = [0] + (sorted(set(caps)) if k == "Theory" else [])
        for d, q in cal.slots:
            for c in thresholds:
                vs = [v for i in by_kind[k] if S[i].strength > c for v, bb in cover.get((i, d, q), []) if bb == b]
                n_rooms = sum(1 for x in caps if x > c)
                if len(vs) > n_rooms:
                    m.Add(sum(vs) <= n_rooms)

    # H4: weekly load
    for t, ids in by_tea.items():
        cap = int(tea.at[t, "MaxWeeklyLoad"]) if t in tea.index else 99
        m.Add(sum(S[i].length * (1 - u[i]) for i in ids) <= cap)

    # H7, H8 and the 'blocks' / 'home' soft terms: where each teacher is, per day and period
    penalties = defaultdict(list)
    all_blocks = sorted({b for b, _ in room_caps})
    for t, ids in by_tea.items():
        extra = tea.at[t, "ExtraTravelMinutes"] if t in tea.index else None
        extra = 0 if pd.isna(extra) else int(extra)
        max_changes = tea.at[t, "MaxBuildingChanges"] if t in tea.index else None
        for d in cal.days:
            at = {(q, b): occ(ids, d, q, b) for q in range(1, cal.periods + 1) for b in all_blocks}
            if len(all_blocks) > 1:
                for q1 in range(1, cal.periods + 1):
                    for q2 in range(q1 + 1, cal.periods + 1):
                        gap = cal.gap(q1, q2)
                        for b1 in all_blocks:
                            for b2 in all_blocks:
                                if b1 != b2 and at[(q1, b1)] and at[(q2, b2)] and gap < walk.get((b1, b2), 0) + extra:
                                    m.Add(sum(at[(q1, b1)]) + sum(at[(q2, b2)]) <= 1)
            used = []
            for b in all_blocks:
                vs = [v for q in range(1, cal.periods + 1) for v in at[(q, b)]]
                if not vs:
                    continue
                y = m.NewBoolVar(f"used_{t}_{d[:2]}{b}")
                for v in vs:
                    m.AddImplication(v, y)
                used.append(y)
            if len(used) > 1:
                if not pd.isna(max_changes):
                    m.Add(sum(used) <= int(max_changes) + 1)
                e = m.NewIntVar(0, len(used), f"changes_{t}_{d[:2]}")
                m.Add(e >= sum(used) - 1)
                penalties["blocks"].append(e)

    # soft: same theory subject more than once on a day for a section
    for sec_id, ids in by_sec.items():
        by_subject = defaultdict(list)
        for i in ids:
            if S[i].kind == "Theory":
                by_subject[S[i].subject].append(i)
        for subj, sids in by_subject.items():
            if len(sids) < 2:
                continue
            for d in cal.days:
                vs = [v for i in sids for q in range(1, cal.periods + 1) for v, _ in cover.get((i, d, q), [])]
                if len(vs) > 1:
                    e = m.NewIntVar(0, len(vs), f"spread_{sec_id}_{subj}_{d[:2]}")
                    m.Add(e >= sum(vs) - 1)
                    penalties["spread"].append(e)
        # soft: busiest day of the section
        hours = sum(S[i].length for i in ids)
        top = m.NewIntVar(0, cal.periods, f"top_{sec_id}")
        for d in cal.days:
            m.Add(top >= sum(v for i in ids for q in range(1, cal.periods + 1) for v, _ in cover.get((i, d, q), [])))
        e = m.NewIntVar(0, cal.periods, f"balance_{sec_id}")  # hours on the busiest day above an even spread
        m.Add(e >= top - (-(-hours // max(1, len(cal.days)))))
        penalties["balance"].append(e)

    home = tea.HomeBuilding.dropna().to_dict() if "HomeBuilding" in tea else {}
    penalties["home"] = [v for (i, d, p, b), v in z.items() if home.get(S[i].teacher, b) != b]
    penalties["late"] = [v for (i, d, q), vs in cover.items() if q == cal.periods for v, _ in vs]
    penalties["unplaced"] = [S[i].length * u[i] for i in u]
    m.Minimize(sum(w[k] * sum(terms) for k, terms in penalties.items() if terms))

    # warm start: a greedy timetable that obeys every hard rule, so CP-SAT starts from a real
    # solution and improves it (without it, big instances can end with no solution at all)
    if hints is None:
        hints = _greedy(sessions, options, cal, room_caps, walk, tea, w)
    for key, v in z.items():
        m.AddHint(v, 1 if hints.get(key) else 0)
    hinted = {k[0] for k, on in hints.items() if on}
    for i, v in u.items():
        m.AddHint(v, 0 if i in hinted else 1)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_workers = workers
    solver.parameters.random_seed = seed
    solver.parameters.log_search_progress = log_progress
    # presolve off: on these models it costs more time than it saves (measured on 383- and 888-session instances)
    for k, v in {"cp_model_presolve": False, **(params or {})}.items():
        setattr(solver.parameters, k, v)
    build_time = time.time() - t0
    status = solver.Solve(m)
    name = solver.StatusName(status)
    stats = {"status": name, "build_seconds": round(build_time, 2), "solve_seconds": round(solver.WallTime(), 2),
             "variables": len(m.Proto().variables), "constraints": len(m.Proto().constraints),
             "sessions": len(sessions), "unassigned_pairs": len(unassigned), "greedy_unplaced": len(sessions) - len(hinted)}
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        stats["objective"] = solver.ObjectiveValue()
        stats["best_bound"] = solver.BestObjectiveBound()
        for k, terms in penalties.items():
            stats[f"soft_{k}"] = int(sum(solver.Value(t) for t in terms)) if terms else 0
        placed = [(i, d, p, b) for (i, d, p, b), v in z.items() if solver.BooleanValue(v)]
        unplaced = [S[i].__dict__ for i in u if solver.BooleanValue(u[i])]
    elif hinted:  # CP-SAT found nothing in time: the greedy start already obeys every hard rule
        stats["status"] = name = "GREEDY_ONLY"
        placed = [k for k, on in hints.items() if on]
        unplaced = [S[i].__dict__ for i in u if i not in hinted]
    else:
        return SolveResult(name, pd.DataFrame(), pd.DataFrame([s.__dict__ for s in sessions]), stats)
    rows, room_fail = _assign_rooms(placed, S, rooms, workers)
    unplaced += [S[i].__dict__ | {"reason": "no room in stage 2"} for i in room_fail]
    tt = pd.DataFrame(rows)
    if len(tt):
        tt["SubjectName"] = tt.SubjectCode.map(sub_name)
    stats["placed_periods"] = int(len(tt))
    stats["unplaced_sessions"] = len(unplaced)
    stats["total_seconds"] = round(time.time() - t0, 2)
    return SolveResult(name, tt, pd.DataFrame(unplaced), stats)


def _greedy(sessions, options, cal, room_caps, walk, tea, w):
    """Places sessions one by one (labs and busy teachers first) at the cheapest slot that breaks no hard rule."""
    sec_busy, tea_at, room_use = set(), defaultdict(list), defaultdict(list)
    load, sec_day, subj_day = defaultdict(int), defaultdict(int), defaultdict(int)
    demand = defaultdict(int)
    for s in sessions:
        demand[s.teacher] += s.length

    def info(t, col):
        v = tea.at[t, col] if t in tea.index and col in tea else None
        return None if v is None or pd.isna(v) else v

    def rooms_ok(b, kind, d, q, strength):
        caps = room_caps[(b, kind)]
        used = room_use[(b, kind, d, q)] + [strength]
        if kind == "Lab":
            return len(used) <= len(caps)
        return all(sum(1 for x in used if x > c) <= sum(1 for x in caps if x > c) for c in [0] + sorted(set(caps)))

    hints = {}
    for s in sorted(sessions, key=lambda s: (s.kind != "Lab", -s.length, -demand[s.teacher], s.id)):
        cap = info(s.teacher, "MaxWeeklyLoad") or 99
        if load[s.teacher] + s.length > cap:
            continue
        extra, mc, home = int(info(s.teacher, "ExtraTravelMinutes") or 0), info(s.teacher, "MaxBuildingChanges"), info(s.teacher, "HomeBuilding")
        best = None
        for d, p, b in options[s.id]:
            span = range(p, p + s.length)
            if any((s.section, d, q) in sec_busy for q in span):
                continue
            mine = tea_at[(s.teacher, d)]
            if any(q2 == q for q2, _ in mine for q in span):
                continue
            if mc is not None and len({b2 for _, b2 in mine} | {b}) > int(mc) + 1:
                continue
            if any(b2 != b and cal.gap(*sorted((q, q2))) < walk.get((b, b2), 0) + extra for q2, b2 in mine for q in span):
                continue
            if not all(rooms_ok(b, s.kind, d, q, s.strength) for q in span):
                continue
            blocks_now = {b2 for _, b2 in mine}
            score = (w["spread"] * subj_day[(s.section, s.subject, d)] + w["balance"] * sec_day[(s.section, d)] / 2
                     + w["home"] * (home is not None and b != home) + w["blocks"] * (bool(blocks_now) and b not in blocks_now)
                     + w["late"] * (p + s.length - 1 == cal.periods))
            if best is None or score < best[0]:
                best = (score, d, p, b)
        if best is None:
            continue
        _, d, p, b = best
        hints[(s.id, d, p, b)] = True
        for q in range(p, p + s.length):
            sec_busy.add((s.section, d, q))
            tea_at[(s.teacher, d)].append((q, b))
            room_use[(b, s.kind, d, q)].append(s.strength)
        load[s.teacher] += s.length
        sec_day[(s.section, d)] += s.length
        if s.kind == "Theory":
            subj_day[(s.section, s.subject, d)] += 1
    return hints


def _assign_rooms(placed, S, rooms, workers):
    """Stage 2: per day x block x kind, give each placed session one room for all its periods."""
    groups = defaultdict(list)
    for i, d, p, b in placed:
        groups[(d, b, S[i].kind)].append((i, p))
    rows, failed = [], []
    for (d, b, kind), items in groups.items():
        pool = rooms[(rooms.Building == b) & (rooms.kind == kind)]
        m = cp_model.CpModel()
        x, cost = {}, []
        for i, p in items:
            s = S[i]
            ok = [r for r in pool.itertuples() if kind == "Lab" or r.Capacity >= s.strength]
            for r in ok:
                x[(i, r.RoomID)] = m.NewBoolVar("")
                # theory: smallest room that fits; labs: undersized costs more (batches needed)
                cost.append(x[(i, r.RoomID)] * (r.Capacity - s.strength if r.Capacity >= s.strength else 1000))
            m.AddExactlyOne([x[(i, r.RoomID)] for r in ok])
        for r in pool.itertuples():
            for q in {q for i, p in items for q in range(p, p + S[i].length)}:
                vs = [x[(i, r.RoomID)] for i, p in items if p <= q < p + S[i].length and (i, r.RoomID) in x]
                if len(vs) > 1:
                    m.AddAtMostOne(vs)
        m.Minimize(sum(cost))
        sv = cp_model.CpSolver()
        sv.parameters.max_time_in_seconds = 10
        sv.parameters.num_workers = workers
        if sv.Solve(m) not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            failed += [i for i, _ in items]
            continue
        for i, p in items:
            room = next(rid for (j, rid), v in x.items() if j == i and sv.BooleanValue(v))
            s = S[i]
            for k in range(s.length):
                rows.append({"SectionID": s.section, "Day": d, "Period": p + k, "SubjectCode": s.subject, "Type": s.kind,
                             "TeacherID": s.teacher, "RoomID": room, "Building": b, "Session": i, "Strength": s.strength})
    return rows, failed


# ------------------------------------------------------------------ independent check
def verify(tt, data):
    """Re-checks every hard rule on the finished timetable, without trusting the model. Returns a list of problems."""
    if tt.empty:
        return []
    cal = Calendar.from_data(data)
    problems = []
    for col in ("SectionID", "TeacherID", "RoomID"):
        dup = tt[tt.duplicated([col, "Day", "Period"], keep=False)]
        problems += [f"H1-3 clash: {col} {r[col]} twice on {r.Day} P{r.Period}" for _, r in dup.drop_duplicates([col, "Day", "Period"]).iterrows()]
    cap = dict(zip(data["Rooms"].RoomID, data["Rooms"].Capacity))
    small = tt[(tt.Type == "Theory") & (tt.RoomID.map(cap) < tt.Strength)]
    problems += [f"H3 capacity: {r.SectionID} in {r.RoomID}" for r in small.itertuples()]
    load = tt.groupby("TeacherID").size()
    mx = data["Teachers"].set_index("TeacherID").MaxWeeklyLoad
    problems += [f"H4 load: {t} has {n} h > {mx[t]}" for t, n in load.items() if n > mx[t]]
    away = unavailable(data)
    problems += [f"H5 unavailable: {r.TeacherID} {r.Day} P{r.Period}" for r in tt.itertuples() if (r.TeacherID, r.Day, r.Period) in away]
    for sid, g in tt.groupby("Session"):
        ps = sorted(g.Period)
        if len(g.Day.unique()) > 1 or len(g.RoomID.unique()) > 1 or ps != list(range(ps[0], ps[0] + len(ps))) or any(cal.break_after(q) for q in ps[:-1]):
            problems.append(f"H6 session {sid} is not one unbroken block")
    walk = _travel(data)
    tea = data["Teachers"].set_index("TeacherID")
    for (t, d), g in tt.groupby(["TeacherID", "Day"]):
        g = g.sort_values("Period")
        extra = 0 if pd.isna(tea.at[t, "ExtraTravelMinutes"]) else int(tea.at[t, "ExtraTravelMinutes"])
        prev = None
        for r in g.itertuples():
            if prev is not None and prev.Building != r.Building and cal.gap(prev.Period, r.Period) < walk.get((prev.Building, r.Building), 0) + extra:
                problems.append(f"H7 travel: {t} {d} P{prev.Period}->{r.Period} {prev.Building}->{r.Building}")
            prev = r
        mc = tea.at[t, "MaxBuildingChanges"]
        if not pd.isna(mc) and g.Building.nunique() > int(mc) + 1:
            problems.append(f"H8 blocks: {t} uses {g.Building.nunique()} blocks on {d}")
    return problems
