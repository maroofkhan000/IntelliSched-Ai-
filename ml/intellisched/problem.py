"""Turns cleaned tables into what a scheduler works with: the week grid and the sessions to place.

Shared by the analysis (feasibility checks) and the solver so both count the same way.
"""
from dataclasses import dataclass

import pandas as pd

from .schema import DAYS

BREAK_MINUTES = 10  # a gap this long between two periods counts as a break (labs never run across one)


def _min(t):
    h, m = str(t).split(":")[:2]
    return int(h) * 60 + int(m)


@dataclass
class Calendar:
    days: list
    periods: int
    times: dict  # period -> (start_min, end_min), may be empty

    @classmethod
    def from_data(cls, data):
        ts = data["TimeSlots"].dropna(subset=["Day", "Period"])
        if ts.empty:
            return cls(DAYS, 6, {})
        days = [d for d in DAYS + ["Sunday"] if d in set(ts.Day)]
        periods = int(pd.to_numeric(ts.Period).max())
        times = {}
        for r in ts.itertuples():
            try:
                times.setdefault(int(r.Period), (_min(r.StartTime), _min(r.EndTime)))
            except (ValueError, AttributeError):
                pass
        return cls(days, periods, times)

    @property
    def slots(self):
        return [(d, p) for d in self.days for p in range(1, self.periods + 1)]

    def gap(self, a, b):
        """Minutes between the end of period a and the start of period b (b > a); 50-min periods if unknown."""
        if a in self.times and b in self.times:
            return self.times[b][0] - self.times[a][1]
        return (b - a - 1) * 50

    def break_after(self, p):
        return p < self.periods and self.gap(p, p + 1) >= BREAK_MINUTES

    def starts(self, length):
        """Periods where a session of `length` consecutive periods may start (never across a break)."""
        return [p for p in range(1, self.periods - length + 2) if not any(self.break_after(q) for q in range(p, p + length - 1))]


@dataclass
class Session:
    id: int
    section: str
    subject: str
    teacher: str
    kind: str          # Theory | Lab
    length: int        # consecutive periods
    strength: int
    branch: str
    semester: int


def build_sessions(data):
    """Expands every section x subject of its branch-semester into sessions.

    Theory: one 1-period session per weekly hour. Lab: 2-period sessions (plus a 1-period one if the
    hours are odd). Returns (sessions, unassigned) where unassigned lists pairs with no teacher.
    """
    sec, sub, tsm = data["Sections"], data["Subjects"], data["TeacherSubjectMap"]
    teacher_of = {(r.SectionID, r.SubjectCode): r.TeacherID for r in tsm.itertuples()}
    pairs = sec.merge(sub, on=["BranchCode", "Semester"], suffixes=("", "_sub"))
    sessions, unassigned = [], []
    for r in pairs.itertuples():
        t = teacher_of.get((r.SectionID, r.SubjectCode))
        hours = int(r.WeeklyHours)
        if t is None:
            unassigned.append({"SectionID": r.SectionID, "SubjectCode": r.SubjectCode, "WeeklyHours": hours})
            continue
        lens = [2] * (hours // 2) + [1] * (hours % 2) if r.Type == "Lab" else [1] * hours
        for n in lens:
            sessions.append(Session(len(sessions), r.SectionID, r.SubjectCode, t, r.Type, n, int(r.Strength), r.BranchCode, int(r.Semester)))
    return sessions, pd.DataFrame(unassigned, columns=["SectionID", "SubjectCode", "WeeklyHours"])


def unavailable(data):
    """{(TeacherID, Day, Period)} the teacher cannot teach; a blank Period blocks the whole day."""
    cal = Calendar.from_data(data)
    out = set()
    for r in data["TeacherAvailability"].itertuples():
        if pd.isna(r.Period):
            out |= {(r.TeacherID, r.Day, p) for p in range(1, cal.periods + 1)}
        else:
            out.add((r.TeacherID, r.Day, int(r.Period)))
    return out
