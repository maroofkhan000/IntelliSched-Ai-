"""Plain-language reasons for what each pipeline step did, printed under its one-line summary.

Every line says what happened, why, and (where there is one) what to change in the app.
"""
import pandas as pd

# cleaning rules -> (why it happened, what to do)
CLEAN = {
    "messy_text": ("extra spaces or lower case in a code, fixed", None),
    "number_as_text": ("a number was typed as text (e.g. '4 hrs'), converted", None),
    "strength_imputed": ("section strength was blank or impossible, replaced with the usual size for that branch and semester", "enter the real class size"),
    "load_clipped": ("max weekly load was outside 1-40, clipped", "check the teacher's load"),
    "lab_hours_even": ("lab hours were odd, rounded up (labs are 2-period blocks)", "use even lab hours"),
    "missing_required": ("a required field is blank", "fill in the blank fields"),
    "invalid_option": ("a value is not one of the allowed choices", "pick a value from the dropdown"),
    "out_of_range": ("a number is outside the allowed range", "correct the number"),
    "duplicate_key": ("the same ID appears twice, only the first row was kept", "remove the duplicate"),
    "orphan_reference": ("it points to something that does not exist", "add the missing item, or delete these rows"),
    "unknown_reference": ("it points to something that does not exist", "add the missing item, or delete these rows"),
    "broken_reference": ("the row it points to was removed above (cascade)", "fix the row it depends on"),
    "semester_mismatch": ("the subject is not taught in that section's semester", "assign a subject from the right semester"),
    "conflicting_assignment": ("this section and subject already has a teacher, the second was dropped", "keep one teacher per section and subject"),
    "self_travel": ("walking time from a building to itself", "delete this row"),
    "end_before_start": ("the time slot ends before it starts", "fix the start/end time"),
}

# feasibility checks -> (what a FAIL means, what to do)
CHECKS = {
    "Classroom periods": ("more theory periods are needed than classrooms x open slots can hold", "add classrooms or open more time slots, or schedule fewer sections"),
    "Lab blocks": ("more 2-period lab sessions are needed than the labs can host", "add labs or open more time slots"),
    "Section fits a classroom": ("some sections are bigger than the largest classroom", "add a bigger room or split the section"),
    "Section fits a lab": ("some sections are bigger than the largest lab (batches will be assumed)", "add a bigger lab or split into batches"),
    "Every class has a teacher": ("section-subject pairs have no teacher assigned, so their classes cannot be scheduled",
                                  "in the app: Teaching Assignments -> Auto-assign -> Apply (or press Generate, which assigns automatically), then export again"),
    "Section weekly hours fit the week": ("a section has more weekly hours than there are open slots", "open more time slots or reduce its subjects' hours"),
    "Teachers within weekly load": ("some teachers are assigned more hours than their max weekly load", "move some of their assignments or raise their max load"),
    "Teachers have enough free slots": ("some teachers have more hours than free slots left after their unavailability", "reduce their unavailability or their assignments"),
    "Travel time for every block pair": ("walking time is missing between some buildings (counted as 0 minutes)", "add the pairs in Travel Between Buildings"),
}


def _say(lines):
    return "\n".join(f"      - {l}" for l in lines)


def cleaning(log):
    acted = log[log.action != "filtered"]
    lines = []
    for (action, table, rule), g in acted.groupby(["action", "table", "rule"], sort=False):
        why, fix = CLEAN.get(rule, (rule.replace("_", " "), None))
        examples = "; ".join(dict.fromkeys(str(d) for d in g.detail if isinstance(d, str) and d))  # unique, in order
        examples = examples if len(examples) <= 120 else examples[:117] + "..."
        lines.append(f"{action} {len(g)} {table} row{'s' if len(g) != 1 else ''}: {why}" + (f" ({examples})" if examples else "") + (f". Fix: {fix}" if fix and action == "removed" else ""))
    filtered = log[log.action == "filtered"]
    if len(filtered):
        per = filtered.groupby("table").size()
        lines.append("filtered (valid, but outside the chosen term/branches): " + ", ".join(f"{n} {t}" for t, n in per.items()))
    return _say(lines)


def feasibility(checks):
    lines = []
    for r in checks[checks.status != "PASS"].itertuples():
        why, fix = CHECKS.get(r.check, (r.note, None))
        lines.append(f"{r.status} {r.check}: {r.value} (limit {r.limit}). {why[0].upper() + why[1:]}." + (f" Fix: {fix}." if fix else ""))
    return _say(lines)


def solution(stats, unplaced):
    lines = []
    pairs = stats.get("unassigned_pairs") or 0
    if pairs:
        lines.append(f"{pairs} section-subject pair{'s' if pairs != 1 else ''} had no teacher, so their classes were left out before solving. "
                     "Fix: Auto-assign in the app, then export again.")
    if not stats.get("sessions") and not stats.get("placed_periods"):
        lines.append("nothing was left to schedule, so 0 periods placed is expected, not a solver failure.")
    if isinstance(unplaced, pd.DataFrame) and len(unplaced) and "reason" in unplaced:
        for reason, n in unplaced.reason.value_counts().items():
            lines.append(f"{n} session{'s' if n != 1 else ''} unplaced: {reason}")
    if stats.get("status") == "FEASIBLE":
        lines.append("FEASIBLE = a valid timetable, but the time limit ended before it was proven best; a longer --time may improve it.")
    return _say(lines)
