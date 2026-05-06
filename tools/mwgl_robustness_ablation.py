#!/usr/bin/env python3
"""
MWGL 鲁棒管线消融：对比「单次生成 baseline」vs「RobustFlow 式 robust 生成」
在各指令变体下与参照工作流（original 生成）的图相似度（graph_evaluator 节点/图级 F1）。

产出（默认目录 ../data/reports/）：
  - mwgl_ablation_results.csv
  - visual/mwgl_ablation_node_f1_by_variant.png
  - visual/mwgl_ablation_graph_f1_by_variant.png
  - visual/mwgl_ablation_scatter_node_vs_graph.png  （RobustFlow bias–variance 图的精神对应：两指标散点）

前置：本地 MWGL 已 npm start；Python 环境已 pip install -r ../../requirements.txt 与 matplotlib。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

def _robustflow_repo_root() -> Path:
    import os

    env = os.environ.get("ROBUSTFLOW_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    _tools = Path(__file__).resolve().parent
    return _tools.parent.parent.parent


_TOOLS = Path(__file__).resolve().parent
_MWGL_ROOT = _TOOLS.parent
_REPO_ROOT = _robustflow_repo_root()
if str(_REPO_ROOT / "evaluate") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "evaluate"))

from mwgl_workflow_adapter import mwgl_to_eval_graph  # noqa: E402


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def post_generate(base_url: str, prompt: str, *, robust: bool, timeout: float = 300.0) -> str:
    url = base_url.rstrip("/") + "/api/mwgl/generate"
    body = json.dumps({"prompt": prompt, "robust": robust}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("content") or ""


def parse_workflow_json(content: str) -> Optional[Dict[str, Any]]:
    s = content.strip().replace("```json", "").replace("```", "")
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(s[i : j + 1])
    except json.JSONDecodeError:
        return None


def _import_graph_evaluator():
    try:
        from graph_evaluator import t_eval_graph, t_eval_nodes  # noqa: E402
    except ImportError as e:
        print(
            "需要 graph_evaluator：请在 RobustFlow 环境中 pip install -r requirements.txt\n"
            f"{e}",
            file=sys.stderr,
        )
        raise SystemExit(1) from e
    return t_eval_nodes, t_eval_graph


def _load_st(model_name: str, local_files_only: bool):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        model_name, local_files_only=local_files_only, trust_remote_code=False
    )


def run_ablation(
    rows: List[Dict[str, Any]],
    base_url: str,
    model_name: str,
    *,
    local_files_only: bool,
    gt_robust: bool = True,
) -> List[Dict[str, Any]]:
    """
    gt_robust: 参照图由 original 提示词用 robust(true) 还是 false 生成（默认 true，质量更稳）。
    """
    t_eval_nodes, t_eval_graph = _import_graph_evaluator()
    st = _load_st(model_name, local_files_only)
    out: List[Dict[str, Any]] = []

    for row in rows:
        rid = row.get("id", "")
        variants = row.get("variants") or {}
        ref = row.get("reference_workflow")
        orig_text = variants.get("original")
        if not orig_text:
            continue

        if isinstance(ref, dict):
            gt_graph = mwgl_to_eval_graph(ref)
        else:
            try:
                c = post_generate(base_url, orig_text, robust=gt_robust)
                wf = parse_workflow_json(c)
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                out.append(
                    {
                        "id": rid,
                        "variant": "_gt_",
                        "baseline_node_f1": "",
                        "robust_node_f1": "",
                        "baseline_graph_f1": "",
                        "robust_graph_f1": "",
                        "note": f"gt_failed:{e}",
                    }
                )
                continue
            if wf is None:
                out.append(
                    {
                        "id": rid,
                        "variant": "_gt_",
                        "baseline_node_f1": "",
                        "robust_node_f1": "",
                        "baseline_graph_f1": "",
                        "robust_graph_f1": "",
                        "note": "gt_parse_failed",
                    }
                )
                continue
            gt_graph = mwgl_to_eval_graph(wf)

        if not gt_graph.get("nodes"):
            continue

        for vname, vtext in variants.items():
            if vname == "original" or not vtext:
                continue

            note_parts = []
            b_node = b_graph = r_node = r_graph = 0.0

            for label, use_r in (("baseline", False), ("robust", True)):
                wf = None
                try:
                    content = post_generate(base_url, vtext, robust=use_r)
                    wf = parse_workflow_json(content)
                except (urllib.error.URLError, TimeoutError, OSError) as e:
                    note_parts.append(f"{label}_api:{e}")
                if wf is None:
                    note_parts.append(f"{label}_no_workflow")
                    continue
                g = mwgl_to_eval_graph(wf)
                if not g.get("nodes"):
                    note_parts.append(f"{label}_empty")
                    continue
                n_sc = t_eval_nodes(g, gt_graph, st)
                g_sc = t_eval_graph(g, gt_graph, st)
                nf, gf = float(n_sc["f1_score"]), float(g_sc["f1_score"])
                if label == "baseline":
                    b_node, b_graph = nf, gf
                else:
                    r_node, r_graph = nf, gf

            out.append(
                {
                    "id": rid,
                    "variant": vname,
                    "baseline_node_f1": round(b_node, 4),
                    "robust_node_f1": round(r_node, 4),
                    "baseline_graph_f1": round(b_graph, 4),
                    "robust_graph_f1": round(r_graph, 4),
                    "delta_node_f1": round(r_node - b_node, 4),
                    "delta_graph_f1": round(r_graph - b_graph, 4),
                    "note": ";".join(note_parts),
                }
            )

    return out


def plot_reports(
    rows: List[Dict[str, Any]], visual_dir: Path, *, plot_font: str | None = None
) -> None:
    import matplotlib.pyplot as plt
    import numpy as np

    from matplotlib_cjk_font import apply_font_to_axis, setup_cjk_font_for_plotting

    fp = setup_cjk_font_for_plotting(plot_font)

    visual_dir.mkdir(parents=True, exist_ok=True)

    # 聚合到 variant
    from collections import defaultdict

    acc: Dict[str, List[Tuple[float, float, float, float]]] = defaultdict(list)
    scatter_bn, scatter_rn, scatter_bg, scatter_rg = [], [], [], []

    for r in rows:
        if r.get("variant") in ("_gt_", "_error_", None, ""):
            continue
        try:
            bn = float(r["baseline_node_f1"])
            rn = float(r["robust_node_f1"])
            bg = float(r["baseline_graph_f1"])
            rg = float(r["robust_graph_f1"])
        except (TypeError, ValueError, KeyError):
            continue
        v = str(r.get("variant", ""))
        acc[v].append((bn, rn, bg, rg))
        scatter_bn.append(bn)
        scatter_rn.append(rn)
        scatter_bg.append(bg)
        scatter_rg.append(rg)

    if not acc:
        print("无有效数据，跳过作图", file=sys.stderr)
        return

    variants = sorted(acc.keys())
    x = np.arange(len(variants))
    w = 0.35
    mean_bn = [np.mean([t[0] for t in acc[v]]) for v in variants]
    mean_rn = [np.mean([t[1] for t in acc[v]]) for v in variants]
    mean_bg = [np.mean([t[2] for t in acc[v]]) for v in variants]
    mean_rg = [np.mean([t[3] for t in acc[v]]) for v in variants]

    fig, ax = plt.subplots(figsize=(9, 5.2), dpi=140)
    ax.bar(x - w / 2, mean_bn, w, label="Baseline (单次生成)", color="#7f7f7f")
    ax.bar(x + w / 2, mean_rn, w, label="RobustFlow 式管线", color="#1f77b4")
    ax.set_xticks(x)
    ax.set_xticklabels(variants, rotation=25, ha="right")
    ax.set_ylabel("Node-level F1")
    ax.set_title("MWGL：指令变体下节点级 F1（相对 original 参照图）")
    ax.legend()
    ax.grid(axis="y", alpha=0.25)
    ax.set_ylim(0, 1.05)
    apply_font_to_axis(ax, fp)
    fig.tight_layout()
    fig.savefig(visual_dir / "mwgl_ablation_node_f1_by_variant.png", bbox_inches="tight")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(9, 5.2), dpi=140)
    ax.bar(x - w / 2, mean_bg, w, label="Baseline (单次生成)", color="#7f7f7f")
    ax.bar(x + w / 2, mean_rg, w, label="RobustFlow 式管线", color="#ff7f0e")
    ax.set_xticks(x)
    ax.set_xticklabels(variants, rotation=25, ha="right")
    ax.set_ylabel("Graph-level F1")
    ax.set_title("MWGL：指令变体下图级 F1（可达闭包，对齐 RobustFlow 评测）")
    ax.legend()
    ax.grid(axis="y", alpha=0.25)
    ax.set_ylim(0, 1.05)
    apply_font_to_axis(ax, fp)
    fig.tight_layout()
    fig.savefig(visual_dir / "mwgl_ablation_graph_f1_by_variant.png", bbox_inches="tight")
    plt.close(fig)

    # 散点：横轴 baseline 图 F1，纵轴 robust 图 F1（点在 y=x 上方为提升）
    if scatter_bg and scatter_rg:
        fig, ax = plt.subplots(figsize=(6.2, 6.2), dpi=140)
        ax.scatter(scatter_bg, scatter_rg, c="#2ca02c", edgecolors="black", linewidths=0.5, s=55, alpha=0.85)
        lim = max(1.0, max(scatter_bg + scatter_rg) * 1.05)
        ax.plot([0, lim], [0, lim], "k--", alpha=0.35, label="y = x")
        ax.set_xlim(0, lim)
        ax.set_ylim(0, lim)
        ax.set_xlabel("Graph F1（Baseline）")
        ax.set_ylabel("Graph F1（Robust）")
        ax.set_title("MWGL 鲁棒管线：各样本图级 F1 前后对比")
        ax.legend()
        ax.grid(alpha=0.25)
        apply_font_to_axis(ax, fp)
        fig.tight_layout()
        fig.savefig(visual_dir / "mwgl_ablation_scatter_graph_f1.png", bbox_inches="tight")
        plt.close(fig)

    if scatter_bn and scatter_rn:
        fig, ax = plt.subplots(figsize=(6.2, 6.2), dpi=140)
        ax.scatter(scatter_bn, scatter_rn, c="#9467bd", edgecolors="black", linewidths=0.5, s=55, alpha=0.85)
        lim = max(1.0, max(scatter_bn + scatter_rn) * 1.05)
        ax.plot([0, lim], [0, lim], "k--", alpha=0.35, label="y = x")
        ax.set_xlim(0, lim)
        ax.set_ylim(0, lim)
        ax.set_xlabel("Node F1（Baseline）")
        ax.set_ylabel("Node F1（Robust）")
        ax.set_title("MWGL 鲁棒管线：各样本节点级 F1 前后对比")
        ax.legend()
        ax.grid(alpha=0.25)
        apply_font_to_axis(ax, fp)
        fig.tight_layout()
        fig.savefig(visual_dir / "mwgl_ablation_scatter_node_f1.png", bbox_inches="tight")
        plt.close(fig)

    print(f"[OK] 图表已写入 {visual_dir}")


def main() -> None:
    ap = argparse.ArgumentParser(description="MWGL baseline vs robust 消融 + 作图")
    ap.add_argument(
        "--dataset",
        type=Path,
        default=_MWGL_ROOT / "data" / "mwgl_robustness_benchmark.jsonl",
    )
    ap.add_argument("--base-url", default="http://127.0.0.1:3001")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=_MWGL_ROOT / "data" / "reports",
        help="CSV 与 visual/ 子目录",
    )
    ap.add_argument(
        "--sentence-model",
        default="sentence-transformers/all-mpnet-base-v2",
    )
    ap.add_argument("--local-files-only", action="store_true")
    ap.add_argument(
        "--gt-baseline",
        action="store_true",
        help="参照图用 original + 单次生成（默认用 original + robust 生成）",
    )
    ap.add_argument("--no-plot", action="store_true")
    ap.add_argument(
        "--plot-font",
        default=None,
        help="中文字体：族名（如 PingFang SC）或字体文件绝对路径（.ttf/.ttc/.otf，推荐）",
    )
    args = ap.parse_args()

    rows = load_jsonl(args.dataset)
    if args.limit > 0:
        rows = rows[: args.limit]

    results = run_ablation(
        rows,
        args.base_url,
        args.sentence_model,
        local_files_only=args.local_files_only,
        gt_robust=not args.gt_baseline,
    )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.out_dir / "mwgl_ablation_results.csv"
    if results:
        fields = list(results[0].keys())
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(results)
        print(f"[OK] {csv_path}")

    for r in results:
        print(r)

    if not args.no_plot and results:
        plot_reports(results, args.out_dir / "visual", plot_font=args.plot_font)


if __name__ == "__main__":
    main()
