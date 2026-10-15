# IntelliSched AI: datasets

Each dataset is stored as CSV, for Excel and pandas, and as JSONL (one JSON object per line), for streaming and nested data. Both are rebuilt by commands, so don't edit them by hand.

| File | Rows are | Built by | Used by |
|---|---|---|---|
| `solver_runs.csv` / `.jsonl` | one CP-SAT solve | `python -m intellisched dataset` (from `runs/runs.csv`) | `train` (outcome model, weight tuner) |
| `app_generations.csv` / `.jsonl` | one timetable an admin generated in the app | `python -m intellisched pull` | future: learning from the app's own runs |
| `templates/past_timetables.csv` | one class in a timetable the college actually used | filled in by hand | future: warm starts, learning HOD preferences |
| `templates/timetable_feedback.csv` | an admin's verdict on one generated timetable | filled in by hand | future: learning weights from real approval |

## How data flows

```
admin presses Generate in the app
  -> teaching assignments filled automatically, timetable built and saved
  -> backend logs one record in MongoDB (collection mlruns): scope, features, outcome, input snapshot
python -m intellisched pull [--solve 10]
  -> datasets/app_generations.{jsonl,csv}   (one row per generation)
  -> data/app/<run_id>.json                 (the exact input, the same format as "Export for ML (.json)")
  -> with --solve: CP-SAT re-solves each new snapshot with 10 weight sets -> runs/runs.csv
python -m intellisched dataset   -> datasets/solver_runs.{csv,jsonl}
python -m intellisched train     -> models/outcome_mlp.pt (GPU when available)
```

## `solver_runs`: one CP-SAT solve

| Column | Meaning |
|---|---|
| `time`, `instance`, `term`, `time_limit` | When, which input, which term, and the solver's time limit in seconds |
| `source` | `synthetic` (generated college), `live` (the app's database via `live`), `app` (a snapshot from `pull --solve`), `file` (a workbook passed with `--input`) |
| `n_sections` … `n_sessions` | Problem size: sections, subjects, teachers, rooms, building blocks, sessions to place |
| `classroom_util`, `lab_util` | Periods needed ÷ periods available, for classrooms and for labs. Above 1 means it can't all fit. |
| `teacher_util_mean`, `teacher_util_max` | Assigned hours ÷ maximum weekly load, averaged over teachers, and for the busiest teacher |
| `unavailable_rows`, `fail_checks` | Teacher unavailability rows; how many feasibility checks failed |
| `w_*` | Soft-rule weights used: unplaced, spread, home, blocks, balance, late |
| `status`, `objective`, `best_bound` | CP-SAT result: OPTIMAL or FEASIBLE, the score reached, and the best score still possible |
| `soft_*` | Count of each soft-rule violation in the result |
| `unplaced_sessions`, `unassigned_pairs` | Sessions with no slot; section-subject pairs with no teacher |
| `build_seconds`, `solve_seconds`, `total_seconds` | Time taken |
| `violations` | Hard-rule violations found by the independent check. Should be 0. |

## `app_generations`: one timetable generated in the app

| Column | Meaning |
|---|---|
| `run_id`, `at`, `database`, `by`, `source` | Record ID, time, database name, admin username, `app-greedy` |
| `scope_term`, `scope_branch` | What the admin generated: all, odd or even, optionally for one branch |
| `auto_assigned` | Teaching assignments filled automatically just before generating |
| `f_sections`, `f_branches`, `f_subjects_in_scope`, `f_pairs`, `f_pairs_assigned` | Size, and how many section-subject pairs have a teacher |
| `f_teachers`, `f_classrooms`, `f_labs`, `f_buildings`, `f_walk_pairs` | Resources |
| `f_days`, `f_periods_per_day`, `f_open_cells` | Calendar from General Settings |
| `f_theory_hours`, `f_lab_hours` | Weekly periods needed. Odd lab hours are rounded up to whole 2-period blocks. |
| `f_classroom_util`, `f_lab_util`, `f_teacher_util` | Demand ÷ supply. Above 1 means it can't all fit. |
| `f_unavailable_rows`, `f_preferences` | Teacher unavailability rows and subject preferences |
| `f_strength_mean`, `f_strength_max`, `f_largest_classroom` | Class sizes against the biggest classroom |
| `o_sections`, `o_demand`, `o_scheduled`, `o_unscheduled`, `o_placed_share` | Outcome: periods needed, periods placed, sessions not placed, share placed |
| `o_unscheduled_no_teacher` / `_no_room` / `_no_slot` | Why sessions weren't placed |
| `o_blockChanges`, `o_undersizedLabs`, `o_missing_walk` | Building changes, labs smaller than the section, block pairs with no walking time |

The JSONL version keeps each record nested: `scope`, `features`, `outcome` (including the full `unscheduledReasons`).

## Templates (to fill in by hand)

- **`past_timetables.csv`**: `Term` (e.g. `2025-odd`), `SectionID`, `SubjectCode`, `TeacherID`, `RoomID`, `Day` (`Monday`…), `Period` (1–12). One row per class per week.
- **`timetable_feedback.csv`**: `RunID` (from `app_generations.csv`), `Accepted` (Yes/No), `Rating` (1–5), `ChangesMade` (how many classes were moved by hand), `Comment`.
