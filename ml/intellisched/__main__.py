"""Command line.

  python -m intellisched run                          # synthetic instance, all 5 steps
  python -m intellisched run --input ../timetable_dataset.xlsx --term odd
  python -m intellisched run --seed 7 --branches CSE ECE --noise 0.03 --time 120
  python -m intellisched batch --n 30 --time 20      # many runs -> runs/runs.csv for the ML layer
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
    t = sub.add_parser("train", help="runs/runs.csv -> outcome model (GPU if available) -> models/")
    t.add_argument("--device", help="cuda or cpu (default: cuda when available)")
    t.add_argument("--epochs", type=int, default=1500)
    t.add_argument("--ensemble", type=int, default=5)
    a = ap.parse_args()
    if a.cmd == "run":
        gen = None if a.input else GenConfig(seed=a.seed, branches=a.gen_branches, noise=a.noise)
        run(a.input, term=None if a.term == "all" else a.term, branches=a.branches, gen=gen, time_limit=a.time, name=a.name)
    elif a.cmd == "batch":
        batch(a.n, a.seed, a.time)
    else:
        from .train import train  # torch is only needed here
        train(a.device, ensemble=a.ensemble, epochs=a.epochs)


if __name__ == "__main__":
    main()
