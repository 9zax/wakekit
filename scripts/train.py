#!/usr/bin/env python3
"""train.py — train an openWakeWord head on features from scripts/featurize.mjs.

    python3 scripts/train.py <featDir> <out.onnx> [--base models/lada.onnx]

The head is the ONLY trained part of openWakeWord: Flatten(1536) -> Gemm(64) -> LayerNorm -> ReLU
-> Gemm(64) -> LayerNorm -> ReLU -> Gemm(1) -> Sigmoid. ~110k parameters on ~8k examples, which is
numpy's territory — pulling in torch to fit this would be 2.5 GB of dependency for 80 lines of
arithmetic.

Export reuses --base as a TEMPLATE: its graph, opset and IR version are already known-good for
onnxruntime-web, and only the ten weight tensors are overwritten. So this cannot emit a topology
the worker refuses to load, and there is no ONNX authoring to get wrong.
"""
import sys, argparse
import numpy as np
import onnx
from onnx import numpy_helper

FEAT, HID = 1536, 64
EPS = 1e-5


def layernorm(x, g, b):
    mu = x.mean(-1, keepdims=True)
    var = ((x - mu) ** 2).mean(-1, keepdims=True)
    sd = np.sqrt(var + EPS)
    xh = (x - mu) / sd
    return xh * g + b, (xh, sd)


def layernorm_back(dy, g, cache):
    xh, sd = cache
    dg, db = (dy * xh).sum(0), dy.sum(0)
    dxh = dy * g
    # d/dx of (x-mu)/sd: the two correction terms are the mean and the projection onto xh.
    dx = (dxh - dxh.mean(-1, keepdims=True) - xh * (dxh * xh).mean(-1, keepdims=True)) / sd
    return dx, dg, db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("feat_dir")
    ap.add_argument("out")
    ap.add_argument("--base", default="scripts/head-template.onnx")
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--lr", type=float, default=2e-3)
    # Negatives outweigh positives on purpose. A wake word that misses is a retry; one that fires
    # mid-meeting talks over people. openWakeWord's own config carries max_negative_weight=1500 for
    # the same reason — this is the same lever at this corpus's scale.
    ap.add_argument("--neg-weight", type=float, default=8.0)
    # Label smoothing, and it is load-bearing rather than a nicety. Against hard 0/1 targets BCE has
    # no reason to ever stop, so it drives the logits apart until the sigmoid saturates: the first
    # model trained here put 98.4% of its scores in [0, 0.01] or [0.99, 1], which reads as decisive
    # and is actually the opposite — every operating point collapses onto the same one, the threshold
    # threshold slider has nothing to slide over, and recall cannot be traded against false
    # fires at all. Soft targets bound the loss, so the score keeps a usable middle.
    ap.add_argument("--label-smooth", type=float, default=0.03)
    a = ap.parse_args()

    X = np.fromfile(f"{a.feat_dir}/X.bin", dtype=np.float32).reshape(-1, FEAT)
    y = np.fromfile(f"{a.feat_dir}/y.bin", dtype=np.uint8).astype(np.float32)
    assert len(X) == len(y), f"{len(X)} features vs {len(y)} labels"

    rng = np.random.default_rng(1234)
    perm = rng.permutation(len(X))
    X, y = X[perm], y[perm]
    # Held out BEFORE any training touches it. Same-clip augmentations can straddle the split, so
    # this measures "another take by these voices", not "an unseen speaker" — the honest read is
    # sanity, not generalisation. The real number is eval/clips via the self-check.
    cut = int(len(X) * 0.85)
    Xtr, ytr, Xva, yva = X[:cut], y[:cut], X[cut:], y[cut:]
    print(f"train {len(Xtr)} ({int(ytr.sum())} pos) | val {len(Xva)} ({int(yva.sum())} pos)")

    # He init on the two ReLU layers; the output layer starts near zero so early logits sit at p≈0.5.
    P = {
        "layer1.weight": rng.normal(0, np.sqrt(2 / FEAT), (HID, FEAT)).astype(np.float32),
        "layer1.bias": np.zeros(HID, np.float32),
        "layernorm1.weight": np.ones(HID, np.float32),
        "layernorm1.bias": np.zeros(HID, np.float32),
        "blocks.0.fcn_layer.weight": rng.normal(0, np.sqrt(2 / HID), (HID, HID)).astype(np.float32),
        "blocks.0.fcn_layer.bias": np.zeros(HID, np.float32),
        "blocks.0.layer_norm.weight": np.ones(HID, np.float32),
        "blocks.0.layer_norm.bias": np.zeros(HID, np.float32),
        "last_layer.weight": (rng.normal(0, 0.01, (1, HID))).astype(np.float32),
        "last_layer.bias": np.zeros(1, np.float32),
    }
    M = {k: np.zeros_like(v) for k, v in P.items()}
    V = {k: np.zeros_like(v) for k, v in P.items()}

    def forward(x):
        z1 = x @ P["layer1.weight"].T + P["layer1.bias"]
        n1, c1 = layernorm(z1, P["layernorm1.weight"], P["layernorm1.bias"])
        r1 = np.maximum(n1, 0)
        z2 = r1 @ P["blocks.0.fcn_layer.weight"].T + P["blocks.0.fcn_layer.bias"]
        n2, c2 = layernorm(z2, P["blocks.0.layer_norm.weight"], P["blocks.0.layer_norm.bias"])
        r2 = np.maximum(n2, 0)
        logit = (r2 @ P["last_layer.weight"].T + P["last_layer.bias"]).ravel()
        return logit, (x, z1, c1, n1, r1, z2, c2, n2, r2)

    batch, t = 256, 0
    for step in range(a.steps):
        idx = rng.integers(0, len(Xtr), batch)
        xb, yb = Xtr[idx], ytr[idx]
        w = np.where(yb > 0, 1.0, a.neg_weight)

        logit, (x, z1, c1, n1, r1, z2, c2, n2, r2) = forward(xb)
        p = 1 / (1 + np.exp(-logit))
        # Soft targets: 1 -> 1-eps, 0 -> eps. BCE's gradient is unchanged in form, so this is the
        # whole of label smoothing — the target it chases just stops being unreachable.
        yt = yb * (1 - 2 * a.label_smooth) + a.label_smooth
        loss = (w * -(yt * np.log(p + 1e-9) + (1 - yt) * np.log(1 - p + 1e-9))).mean()

        g = (w * (p - yt) / len(yb))[:, None]                    # dL/dlogit
        G = {}
        G["last_layer.weight"] = g.T @ r2
        G["last_layer.bias"] = g.sum(0)
        d = g @ P["last_layer.weight"]
        d = d * (n2 > 0)
        d, G["blocks.0.layer_norm.weight"], G["blocks.0.layer_norm.bias"] = layernorm_back(d, P["blocks.0.layer_norm.weight"], c2)
        G["blocks.0.fcn_layer.weight"] = d.T @ r1
        G["blocks.0.fcn_layer.bias"] = d.sum(0)
        d = d @ P["blocks.0.fcn_layer.weight"]
        d = d * (n1 > 0)
        d, G["layernorm1.weight"], G["layernorm1.bias"] = layernorm_back(d, P["layernorm1.weight"], c1)
        G["layer1.weight"] = d.T @ x
        G["layer1.bias"] = d.sum(0)

        t += 1
        lr = a.lr * min(1.0, (step + 1) / 200) * (0.5 ** (step / (a.steps / 2)))  # warmup, then decay
        for k in P:
            M[k] = 0.9 * M[k] + 0.1 * G[k]
            V[k] = 0.999 * V[k] + 0.001 * G[k] ** 2
            P[k] -= lr * (M[k] / (1 - 0.9 ** t)) / (np.sqrt(V[k] / (1 - 0.999 ** t)) + 1e-8)

        if (step + 1) % 500 == 0:
            pv = 1 / (1 + np.exp(-forward(Xva)[0]))
            pos, neg = pv[yva > 0], pv[yva == 0]
            mid = ((pv > 0.01) & (pv < 0.99)).mean()
            print(f"  step {step+1:5d}  loss {loss:.4f}  "
                  f"recall@0.5 {(pos > 0.5).mean():.3f}  FP@0.5 {(neg > 0.5).mean():.5f}  "
                  f"pos_med {np.median(pos):.3f}  neg_p99 {np.quantile(neg, 0.99):.3f}  "
                  f"spread {mid*100:.1f}%")

    pv = 1 / (1 + np.exp(-forward(Xva)[0]))
    pos, neg = pv[yva > 0], pv[yva == 0]
    # "spread" is the share of scores NOT pinned to an end. Near zero means the model is saturated
    # and the threshold is decorative, whatever the recall says.
    print(f"\nscore spread (0.01-0.99): {((pv > 0.01) & (pv < 0.99)).mean()*100:.1f}%")
    print(f"held-out: recall@0.5 {(pos > 0.5).mean():.3f}  "
          f"false-positive@0.5 {(neg > 0.5).mean():.5f}  "
          f"worst positive {pos.min():.3f}  worst negative {neg.max():.3f}")

    model = onnx.load(a.base)
    have = {i.name for i in model.graph.initializer}
    assert have == set(P), f"template mismatch: {have ^ set(P)}"
    for init in model.graph.initializer:
        w = P[init.name]
        assert list(init.dims) == list(w.shape), f"{init.name}: {list(init.dims)} vs {w.shape}"
        init.CopyFrom(numpy_helper.from_array(w.astype(np.float32), init.name))
    onnx.checker.check_model(model)
    onnx.save(model, a.out)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    sys.exit(main())
