"""Command line.

  python -m intellisched run                          # synthetic instance, all 5 steps
  python -m intellisched run --input ../timetable_dataset.xlsx --term odd
  python -m intellisched run --seed 7 --branches CSE ECE --noise 0.03 --time 120
  python -m intellisched batch --n 30 --time 20      # many runs -> runs/runs.csv for the ML layer
  python -m intellisched live --n 40 --time 15       # the app's real database (read-only) -> runs/runs.csv
  python -m intellisched pull --solve 10            # timetables generated in the app -> datasets/ (+ CP-SAT re-solves)
  python -m intellisched dataset                      # runs/runs.csv -> datasets/solver_runs.csv, .jsonl
  python -m intellisched train                        # outcome model on the GPU + recommended weights
"""
import argparse
from pathlib import Path

from .generate import GenConfig
from .pipeline import batch, run


def main():
    ap = argparse.ArgumentParser(prog="intellisched")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="generate (or load) -> analyse -> clean -> feasibility -> solve")
    r.add_argument("--input", type=Path, help="workbook exported from the app (default: generate one)")
    r.add_argument("--term", choices=["odd", "even", "all"], default="odd")
    r.add_argument("--branches", nargs="*", help="only these branches (filter)")
    r.add_argument("--seed", type=int, default=1)
    r.add_argument("--gen-branches", nargs="*", default=["CSE", "ECE", "EE", "ME"], help="branches to generate")
    r.add_argument("--noise", type=float, default=0.03, help="share of generated rows to corrupt")
    r.add_argument("--time", type=int, default=60, help="solver time limit, seconds")
    r.add_argument("--name")
    b = sub.add_parser("batch", help="many random instances and weights -> runs/runs.csv")
    b.add_argument("--n", type=int, default=20)
    b.add_argument("--seed", type=int, default=100)
    b.add_argument("--time", type=int, default=20)
    lv = sub.add_parser("live", help="the app's database (read via the API) solved n times with random weights -> runs/runs.csv")
    lv.add_argument("--n", type=int, default=40)
    lv.add_argument("--time", type=int, default=15)
    lv.add_argument("--database", help="name or id (default: the database with the most rows)")
    lv.add_argument("--export-only", action="store_true", help="only save data/live/<database>.xlsx")
    pl = sub.add_parser("pull", help="timetables the admin generated in the app -> datasets/app_generations.{jsonl,csv}")
    pl.add_argument("--database", help="database id (default: all)")
    pl.add_argument("--solve", type=int, default=0, help="re-solve each new snapshot this many times with CP-SAT -> runs/runs.csv")
    pl.add_argument("--time", type=int, default=15)
    sub.add_parser("dataset", help="runs/runs.csv -> datasets/solver_runs.{csv,jsonl}")
    t = sub.add_parser("train", help="runs/runs.csv -> outcome model (GPU if available) -> models/")
    t.add_argument("--device", help="cuda or cpu (default: cuda when available)")
    t.add_argument("--epochs", type=int, default=1500)
    t.add_argument("--ensemble", type=int, default=5)
    a = ap.parse_args()
    if a.cmd == "run":
        gen = None if a.input else GenConfig(seed=a.seed, branches=a.gen_branches, noise=a.noise)
        run(a.input, term=None if a.term == "all" else a.term, branches=a.branches, gen=gen, time_limit=a.time, name=a.name)
    elif a.cmd == "live":
        from .live import export_live, live_batch
        if a.export_only:
            path, info = export_live(a.database)
            print(path, info)
        else:
            live_batch(a.n, a.time, a.database)
    elif a.cmd == "pull":
        from .dataset import pull
        pull(a.database, a.solve, a.time)
    elif a.cmd == "dataset":
        from .dataset import build_solver_dataset
        build_solver_dataset()
    elif a.cmd == "batch":
        batch(a.n, a.seed, a.time)
    else:
        from .train import train  # torch is only needed here
        train(a.device, ensemble=a.ensemble, epochs=a.epochs)


if __name__ == "__main__":
    main()
