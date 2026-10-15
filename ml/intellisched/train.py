"""ML layer: learn from runs/runs.csv how an instance and a set of solver weights turn out.

One multi-task network (PyTorch, trained on the GPU when CUDA is available) reads the instance
features plus the soft-rule weights (w_*) and predicts four outcomes of the CP-SAT solve:

  all_placed      did every session get a slot?            (classification, BCE)
  unplaced_share  unplaced sessions / sessions              (regression)
  soft_cost       log(1 + soft-rule violations)             (regression)
  solve_frac      solve time / time limit                   (regression)

It is scored by k-fold cross-validation against a predict-the-mean baseline, then refit on every
run and saved to models/outcome_mlp.pt. `recommend_weights` uses it as a weight tuner: it scores
thousands of candidate weight vectors for one instance on the GPU and returns the best.

  python -m intellisched train                 # CV report + model + weights for the real dataset
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn

from .solver import DEFAULT_WEIGHTS

ROOT = Path(__file__).resolve().parents[1]
INSTANCE = ["n_sections", "n_subjects", "n_teachers", "n_rooms", "n_blocks", "n_sessions", "classroom_util", "lab_util",
            "teacher_util_mean", "teacher_util_max", "unavailable_rows", "fail_checks"]
WEIGHTS = [f"w_{k}" for k in DEFAULT_WEIGHTS if k != "unplaced"]  # w_unplaced is fixed, so it carries no signal
FEATURES = INSTANCE + WEIGHTS
TARGETS = ["all_placed", "unplaced_share", "soft_cost", "solve_frac"]
SOFT = ["soft_spread", "soft_home", "soft_blocks", "soft_balance", "soft_late"]
LOG_COLS = ["n_sections", "n_subjects", "n_teachers", "n_rooms", "n_sessions", "unavailable_rows"] + WEIGHTS


def device(name=None):
    if name:
        return torch.device(name)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_runs(path=ROOT / "runs" / "runs.csv"):
    df = pd.read_csv(path)
    df = df[df.status.isin(["OPTIMAL", "FEASIBLE"])].copy()  # a timeout with no solution has no outcome to learn
    df["all_placed"] = (df.unplaced_sessions == 0).astype(float)
    df["unplaced_share"] = df.unplaced_sessions / df.n_sessions.clip(lower=1)
    df["soft_cost"] = np.log1p(df[SOFT].sum(axis=1))
    df["solve_frac"] = (df.solve_seconds / df.time_limit).clip(0, 1.5)
    return df.reset_index(drop=True)


def to_matrix(df):
    x = df[FEATURES].astype(float).copy()
    x[LOG_COLS] = np.log1p(x[LOG_COLS].clip(lower=0))
    return x.to_numpy(np.float32)


class OutcomeNet(nn.Module):
    def __init__(self, n_in, width=64, dropout=0.1):
        super().__init__()
        self.trunk = nn.Sequential(nn.Linear(n_in, width), nn.SiLU(), nn.Dropout(dropout),
                                   nn.Linear(width, width), nn.SiLU(), nn.Dropout(dropout))
        self.head = nn.Linear(width, len(TARGETS))  # one output per target; column 0 is a logit

    def forward(self, x):
        return self.head(self.trunk(x))


def _loss(out, y):
    return nn.functional.binary_cross_entropy_with_logits(out[:, 0], y[:, 0]) + nn.functional.mse_loss(out[:, 1:], y[:, 1:])


def fit(x, y, dev, epochs=1500, lr=3e-3, seed=0):
    """Train one network on standardised x (full batch: the run log is small). Returns (model, mean, std)."""
    torch.manual_seed(seed)
    mu, sd = x.mean(0), x.std(0)
    sd = np.where(sd < 1e-3, 1.0, sd).astype(np.float32)  # a feature constant in training must not blow up unseen values
    ym, ys = y[:, 1:].mean(0), y[:, 1:].std(0) + 1e-6  # regression targets are standardised too
    X = torch.tensor((x - mu) / sd, device=dev)
    Y = torch.tensor(np.c_[y[:, :1], (y[:, 1:] - ym) / ys], dtype=torch.float32, device=dev)
    net = OutcomeNet(x.shape[1]).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    for _ in range(epochs):
        opt.zero_grad()
        _loss(net(X), Y).backward()
        opt.step()
        sched.step()
    net.eval()
    return net, {"x_mean": mu, "x_std": sd, "y_mean": ym, "y_std": ys}


@torch.no_grad()
def predict(nets, scale, x, dev):
    """Average of an ensemble, back in real units: [p(all placed), unplaced share, soft cost, solve frac]."""
    X = torch.tensor((x - scale["x_mean"]) / scale["x_std"], dtype=torch.float32, device=dev)
    out = torch.stack([n(X) for n in nets]).mean(0)
    p = torch.sigmoid(out[:, :1])
    reg = out[:, 1:] * torch.tensor(scale["y_std"], device=dev) + torch.tensor(scale["y_mean"], device=dev)
    lo, hi = torch.tensor([0.0, 0.0, 0.0], device=dev), torch.tensor([1.0, 20.0, 1.5], device=dev)  # each target's valid range
    return torch.cat([p, torch.maximum(torch.minimum(reg, hi), lo)], 1).cpu().numpy()


def cross_validate(df, dev, folds=5, ensemble=3, epochs=1500):
    x, y = to_matrix(df), df[TARGETS].to_numpy(np.float32)
    idx = np.random.default_rng(0).permutation(len(df))
    pred, base = np.zeros_like(y), np.zeros_like(y)
    for k in range(folds):
        test = idx[k::folds]
        train = np.setdiff1d(idx, test)
        nets, scale = zip(*[fit(x[train], y[train], dev, epochs, seed=s) for s in range(ensemble)])
        pred[test] = predict(nets, scale[0], x[test], dev)
        base[test] = y[train].mean(0)
    rows = []
    for j, t in enumerate(TARGETS):
        if t == "all_placed":
            acc = float(((pred[:, j] > 0.5) == (y[:, j] > 0.5)).mean())
            rows.append({"target": t, "metric": "accuracy", "model": acc, "baseline": float(((base[:, j] > 0.5) == (y[:, j] > 0.5)).mean())})
        else:
            rows.append({"target": t, "metric": "MAE", "model": float(np.abs(pred[:, j] - y[:, j]).mean()),
                         "baseline": float(np.abs(base[:, j] - y[:, j]).mean())})
    return pd.DataFrame(rows)


def objective(p):
    """Lower is better: unplaced sessions dominate, then soft violations, then solve time."""
    return 100 * p[:, 1] + 5 * (1 - p[:, 0]) + p[:, 2] + 0.5 * p[:, 3]


def recommend_weights(nets, scale, instance, dev, bounds=None, n=20000, seed=0):
    """Score n random weight vectors (log-normal around DEFAULT_WEIGHTS) for one instance; return the best.
    `bounds` (lo, hi arrays) keeps candidates inside the range seen in training, where predictions mean something."""
    rng = np.random.default_rng(seed)
    base = np.array([DEFAULT_WEIGHTS[w[2:]] for w in WEIGHTS], dtype=np.float64)
    cand = np.vstack([base, base * np.exp(rng.normal(0, 0.8, (n - 1, len(base))))])
    if bounds is not None:
        cand[1:] = np.clip(cand[1:], *bounds)
    cand = cand.round(1)
    raw = pd.DataFrame(np.repeat([[instance[c] for c in INSTANCE]], n, 0), columns=INSTANCE)
    raw[WEIGHTS] = cand
    p = predict(nets, scale, to_matrix(raw), dev)
    score = objective(p)
    best = int(score.argmin())
    return ({w[2:]: float(cand[best, i]) for i, w in enumerate(WEIGHTS)},
            {"default": dict(zip(TARGETS, p[0].round(3).tolist())), "recommended": dict(zip(TARGETS, p[best].round(3).tolist())),
             "default_score": round(float(score[0]), 3), "recommended_score": round(float(score[best]), 3)})


def train(device_name=None, folds=5, ensemble=5, epochs=1500):
    dev = device(device_name)
    if dev.type == "cpu":
        print("CUDA not available: training on the CPU (install the CUDA build of torch to use the GPU)")
    else:
        print(f"training on {torch.cuda.get_device_name(dev)}")
    df = load_runs()
    if len(df) < 2 * folds:
        raise SystemExit(f"only {len(df)} usable runs in runs/runs.csv; run `python -m intellisched batch` first")
    cv = cross_validate(df, dev, folds, ensemble=3, epochs=epochs)
    print(f"{len(df)} runs, {folds}-fold cross-validation:\n" + cv.to_string(index=False, float_format="%.3f"))

    x, y = to_matrix(df), df[TARGETS].to_numpy(np.float32)
    nets, scales = zip(*[fit(x, y, dev, epochs, seed=s) for s in range(ensemble)])
    scale = scales[0]  # same data, so every member has the same scaling
    out = ROOT / "models"
    out.mkdir(exist_ok=True)
    torch.save({"features": FEATURES, "targets": TARGETS, "state": [n.state_dict() for n in nets],
                "scale": {k: v.tolist() for k, v in scale.items()}}, out / "outcome_mlp.pt")

    # weight recommendation for each distinct real instance in the log (not the batch instances)
    recs = {}
    for _, r in df[~df.instance.str.startswith("batch_")].drop_duplicates("instance", keep="last").iterrows():
        w, info = recommend_weights(nets, scale, r, dev, bounds=(df[WEIGHTS].min().to_numpy(), df[WEIGHTS].max().to_numpy()))
        recs[r.instance] = {"weights": w, **info}
        print(f"{r.instance}: recommended weights {w}\n  predicted default {info['default']}\n  predicted tuned   {info['recommended']}")
    (out / "recommended_weights.json").write_text(json.dumps(recs, indent=2))

    report = ROOT / "reports" / "ml"
    report.mkdir(parents=True, exist_ok=True)
    (report / "train.md").write_text(
        f"# Outcome model\n\nDevice: {dev} ({torch.cuda.get_device_name(dev) if dev.type == 'cuda' else 'cpu'}). "
        f"{len(df)} solver runs, {len(FEATURES)} features, ensemble of {ensemble}, {epochs} epochs.\n\n"
        f"## {folds}-fold cross-validation (baseline = predict the training mean)\n\n{cv.to_markdown(index=False, floatfmt='.3f')}\n\n"
        f"## Recommended weights\n\n```json\n{json.dumps(recs, indent=2)}\n```\n")
    print(f"saved models/outcome_mlp.pt, models/recommended_weights.json, reports/ml/train.md")
    return cv, recs


def load_model(dev=None):
    dev = dev or device()
    ck = torch.load(ROOT / "models" / "outcome_mlp.pt", map_location=dev)
    nets = []
    for s in ck["state"]:
        n = OutcomeNet(len(ck["features"])).to(dev)
        n.load_state_dict(s)
        nets.append(n.eval())
    return nets, {k: np.array(v, dtype=np.float32) for k, v in ck["scale"].items()}
