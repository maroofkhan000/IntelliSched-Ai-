# IntelliSched AI: scheduling and ML pipeline (Python)

This is the local, offline part of the project. It takes timetable data (generated here, or exported from the app with **Export database**), analyses it, cleans and filters it, then builds a timetable with Google OR-Tools CP-SAT. Every run is logged as training data for the ML layer.

```
generate ─► analyse ─► clean & filter ─► feasibility gate ─► CP-SAT solve ─► verify ─► runs/runs.csv
```

## Setup (Windows)

```powershell
cd ml
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## Run

```powershell
# a generated university (4 branches, 3 % corrupted rows), odd term, 60 s solve
.venv\Scripts\python -m intellisched run --seed 1

# your own data: export the database from the app, then
.venv\Scripts\python -m intellisched run --input ..\timetable_dataset.xlsx --term odd

# only some branches, longer solve
.venv\Scripts\python -m intellisched run --seed 3 --branches CSE ECE --time 120

# many random instances + random soft-rule weights -> runs/runs.csv (ML training data)
.venv\Scripts\python -m intellisched batch --n 30 --time 20

# train the outcome model on runs.csv (GPU when CUDA is available) -> models/, reports/ml/train.md
.venv\Scripts\python -m intellisched train
```

### Data straight from the app

```powershell
# the app's database, read through the running backend (GET only), solved 40 times
.venv\Scripts\python -m intellisched live --n 40 --time 15

# every timetable an admin generates is logged by the backend; fetch them (+ re-solve with CP-SAT)
.venv\Scripts\python -m intellisched pull --solve 10

# runs/runs.csv -> datasets/solver_runs.csv and .jsonl
.venv\Scripts\python -m intellisched dataset
```

The app's **Export for ML (.json)** button gives the same input format; pass it with `run --input file.json`. Dataset columns are described in `datasets/DATASET.md`.

### GPU

`requirements.txt` installs the CPU build of PyTorch. To train on an NVIDIA GPU, swap it for the CUDA build (any recent driver; checked on an RTX 3050 Laptop, 4 GB):

```powershell
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
```

`train` prints which device it uses, and `--device cpu` forces the CPU.

Step-by-step version: `notebooks/01_pipeline_walkthrough.ipynb`.

## What each step does

| Step | Module | Output |
|---|---|---|
| 1. Data generation | `generate.py` | `data/synthetic/<name>.xlsx`: the same sheets as the app, plus `_Injected` (the corrupted rows, as ground truth) |
| 2. Data analysis | `analyze.py` | `reports/<name>/01_analysis.md`: data quality, patterns, whole-catalog feasibility, charts |
| 3. Removal and filter | `clean.py` | `data/clean/<name>_<term>.xlsx`, `reports/<name>/cleaning_log.csv`, `02_cleaning.md` (with the score against `_Injected`) |
| 4. Feasibility gate | `analyze.py` | `reports/<name>/03_feasibility.md`: counting checks every timetable must pass for the chosen term |
| 5. Solve and verify | `solver.py` | `reports/<name>/timetable.xlsx` (Timetable, Unplaced, Stats), `04_solution.md` |
| Run log | `pipeline.py` | `runs/runs.csv`: one row per run, with instance features, weights and results |

### Cleaning rules

- **Repaired**: messy codes (`' cse '` becomes `CSE`); numbers stored as text (`'4 hrs'` becomes 4); a missing or impossible section strength becomes the median for that branch and semester; a weekly load outside 1–40 is clipped; odd lab hours are rounded up to even.
- **Removed**: blank required fields; values not in a dropdown; numbers out of range; duplicate keys (the first row is kept); links to rows that don't exist; an assignment whose subject isn't taught in that section's semester; a second teacher for the same section and subject.
- **Cascade**: rows removed only because a row they point to was removed. These are logged separately.
- **Filtered**: valid rows outside the chosen term or branches.

### Solver rules

The hard rules are H1–H8, listed in `solver.py`: no clashes, room capacity, weekly load, unavailability, unbroken labs, walking time between blocks, and block changes per day.

The soft rules are weighted in `DEFAULT_WEIGHTS`: unplaced, spread, home, blocks, balance and late. The weights are what the ML layer will tune.

`verify()` re-checks every hard rule on the finished timetable without using the model.

## Results so far

| Data | Term | Result |
|---|---|---|
| Generated, seed 1 (4 branches, 18 injected errors) | odd | Cleaner caught 18/18 errors with 0 false alarms. 9/9 feasibility checks pass. 383 sessions, all placed, 0 hard-rule violations. |
| `timetable_dataset.xlsx` (real) | odd | 3 checks FAIL: 768 classroom periods are needed but only 432 exist, and 16 of 24 teachers are over their weekly load. The solver places what fits and lists the rest under Unplaced. This data can't be fully scheduled without more rooms and teachers. |

## ML layer

`train.py` (`python -m intellisched train`): one small multi-task network (2 × 64 units, an ensemble of 5) reads the instance features plus the weights `w_*` and predicts four things:

- whether every session will be placed;
- the share of sessions left unplaced;
- log(1 + soft-rule violations);
- solve time ÷ time limit.

It is scored by 5-fold cross-validation against predicting the mean, then refit on every run and saved to `models/outcome_mlp.pt`. It then works as a **weight tuner**: for each non-batch instance in the log, it scores 20,000 candidate weight vectors on the GPU and writes the best to `models/recommended_weights.json`. The tuned weights are a prediction; confirm them with a real solve before relying on them.

### Planned

`runs/runs.csv` has one row per solve. Each row holds the instance features (sizes, room use, teacher use, unavailability), the weights (`w_*`) and the outcomes (status, time, `soft_*`, unplaced). Done above: feasibility prediction and weight tuning. Still to do:

1. **Warm start**: past timetables → `solve(..., hints=...)`
