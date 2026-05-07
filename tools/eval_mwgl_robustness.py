#!/usr/bin/env python3
"""
MWGL 鲁棒性评估：复用 RobustFlow 的 graph_evaluator（t_eval_nodes / t_eval_graph）
与 Distribution/analyze 风格的提示嵌入统计。

示例：
  # 仅测「指令变体」嵌入偏移（默认经 HF 镜像下载模型；见文件顶部 HF_ENDPOINT 说明）
  python eval_mwgl_robustness.py --dataset ../data/mwgl_robustness_benchmark.jsonl --prompt-metrics-only

  # 访问不了 HF 时：粗粒度字面对比（不下载模型）
  python eval_mwgl_robustness.py --dataset ../data/mwgl_robustness_benchmark.jsonl --prompt-metrics-only --lexical-only

  # 已下载到本地的模型目录（与 --local-files-only 联用）
  python eval_mwgl_robustness.py --prompt-metrics-only --sentence-model /path/to/all-mpnet-base-v2 --local-files-only

  # 调用本地 MWGL 生成接口，比较各变体生成图 vs original
  python eval_mwgl_robustness.py --dataset ../data/mwgl_robustness_benchmark.jsonl --base-url http://127.0.0.1:3001 --limit 2
"""
from __future__ import annotations

import os

# 默认使用 Hugging Face 国内镜像（https://hf-mirror.com），避免直连 huggingface.co 被重置。
# 若已设置环境变量 HF_ENDPOINT，则以你的为准；要用官方站点可：export HF_ENDPOINT=https://huggingface.co
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import argparse
import csv
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# RobustFlow 仓库内 evaluate/（需已 pip install requirements.txt 中的依赖）
# 若本仓库单独克隆、不与 RobustFlow 同目录，请设置环境变量 ROBUSTFLOW_ROOT 指向 RobustFlow 根目录。
def _robustflow_repo_root() -> Path:
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


def _import_graph_evaluator():
    try:
        from graph_evaluator import t_eval_graph, t_eval_nodes  # noqa: E402
    except ImportError as e:
        print(
            "无法导入 graph_evaluator（需要 networkx、numpy、sentence-transformers）。\n"
            "请在 RobustFlow 仓库根目录环境中执行：pip install -r requirements.txt\n"
            f"原始错误: {e}",
            file=sys.stderr,
        )
        raise SystemExit(1) from e
    return t_eval_nodes, t_eval_graph


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def post_generate(base_url: str, prompt: str, timeout: float = 120.0) -> str:
    url = base_url.rstrip("/") + "/api/mwgl/generate"
    body = json.dumps({"prompt": prompt}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("content") or ""


def parse_workflow_json(content: str) -> Optional[Dict[str, Any]]:
    s = content.strip()
    s = s.replace("```json", "").replace("```", "")
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(s[i : j + 1])
    except json.JSONDecodeError:
        return None


def _load_sentence_transformer(model_name: str, local_files_only: bool):
    from sentence_transformers import SentenceTransformer

    try:
        return SentenceTransformer(
            model_name,
            local_files_only=local_files_only,
            trust_remote_code=False,
        )
    except Exception as e:
        hint = (
            "\n—— 常见原因：无法从当前 HF 端点下载模型（网络或镜像故障）。可选：\n"
            "  • 本脚本已默认 HF_ENDPOINT=https://hf-mirror.com；可换镜像或官方：export HF_ENDPOINT=...\n"
            "  • 不下载模型：加 --lexical-only\n"
            "  • 使用本地模型目录：--sentence-model /本地路径 --local-files-only\n"
        )
        raise RuntimeError(f"{hint}\n原始错误: {e!r}") from e


def run_prompt_embedding_benchmark(
    rows: List[Dict[str, Any]],
    model_name: str,
    *,
    lexical_only: bool = False,
    local_files_only: bool = False,
) -> List[Dict[str, Any]]:
    from lexical_prompt_metrics import lexical_variant_metrics

    model = None
    metrics_vs_original = None
    if not lexical_only:
        from prompt_embedding_metrics import metrics_vs_original as _mvo

        metrics_vs_original = _mvo
        model = _load_sentence_transformer(model_name, local_files_only)

    out_rows: List[Dict[str, Any]] = []
    for row in rows:
        rid = row.get("id", "")
        variants = row.get("variants") or {}
        orig = variants.get("original")
        if not orig:
            continue
        for vname, vtext in variants.items():
            if vname == "original":
                continue
            if not vtext:
                continue
            if lexical_only:
                m = lexical_variant_metrics(orig, vtext)
                m["metric_mode"] = "lexical"
            else:
                m = metrics_vs_original([orig], [vtext], model)
                m["metric_mode"] = "embedding"
            out_rows.append({"id": rid, "variant": vname, **m})
    return out_rows


def run_generation_benchmark(
    rows: List[Dict[str, Any]],
    base_url: str,
    model_name: str,
    *,
    local_files_only: bool = False,
) -> List[Dict[str, Any]]:
    t_eval_nodes, t_eval_graph = _import_graph_evaluator()

    st_model = _load_sentence_transformer(model_name, local_files_only)
    results: List[Dict[str, Any]] = []

    for row in rows:
        rid = row.get("id", "")
        variants = row.get("variants") or {}
        ref = row.get("reference_workflow")

        graphs: Dict[str, Dict] = {}
        errors: Dict[str, str] = {}

        for name, text in variants.items():
            if not text:
                continue
            if name == "original" and isinstance(ref, dict):
                wf = ref
            else:
                try:
                    content = post_generate(base_url, text)
                except (urllib.error.URLError, TimeoutError, OSError) as e:
                    errors[name] = str(e)
                    continue
                wf = parse_workflow_json(content)
                if wf is None:
                    errors[name] = "parse_workflow_failed"
                    continue
            graphs[name] = mwgl_to_eval_graph(wf)

        if "original" not in graphs:
            results.append(
                {
                    "id": rid,
                    "variant": "_error_",
                    "node_f1": 0.0,
                    "graph_f1": 0.0,
                    "note": "missing_original;" + json.dumps(errors, ensure_ascii=False),
                }
            )
            continue

        gt = graphs["original"]
        for name, g in graphs.items():
            if name == "original":
                continue
            if not g["nodes"] or not gt["nodes"]:
                results.append(
                    {
                        "id": rid,
                        "variant": name,
                        "node_f1": 0.0,
                        "graph_f1": 0.0,
                        "note": errors.get(name, "empty_graph"),
                    }
                )
                continue
            n_score = t_eval_nodes(g, gt, st_model)
            g_score = t_eval_graph(g, gt, st_model)
            results.append(
                {
                    "id": rid,
                    "variant": name,
                    "node_f1": round(float(n_score["f1_score"]), 4),
                    "graph_f1": round(float(g_score["f1_score"]), 4),
                    "note": errors.get(name, ""),
                }
            )

    return results


def main() -> None:
    ap = argparse.ArgumentParser(description="MWGL / RobustFlow-style robustness evaluation")
    ap.add_argument(
        "--dataset",
        type=Path,
        default=_MWGL_ROOT / "data" / "mwgl_robustness_benchmark.jsonl",
        help="JSONL：每行含 id, variants.{original, paraphrasing, ...}",
    )
    ap.add_argument(
        "--base-url",
        default="http://127.0.0.1:3001",
        help="MWGL server（用于生成工作流）",
    )
    ap.add_argument("--limit", type=int, default=0, help="只评估前 N 条（0 表示全部）")
    ap.add_argument(
        "--prompt-metrics-only",
        action="store_true",
        help="仅计算提示文本的嵌入鲁棒性指标，不调用 /api/mwgl/generate",
    )
    ap.add_argument(
        "--sentence-model",
        default="sentence-transformers/all-mpnet-base-v2",
        help="句向量模型 ID 或本机目录（与 --local-files-only 联用）",
    )
    ap.add_argument(
        "--local-files-only",
        action="store_true",
        help="不向 Hugging Face 发起下载，仅使用缓存或 --sentence-model 指向的本地目录",
    )
    ap.add_argument(
        "--lexical-only",
        action="store_true",
        help="与 --prompt-metrics-only 联用：不加载句向量模型，仅用字面对齐相似度（免联网）",
    )
    ap.add_argument("--out-csv", type=Path, default=None, help="可选：写入 CSV")
    args = ap.parse_args()

    if args.lexical_only and not args.prompt_metrics_only:
        print("--lexical-only 仅在与 --prompt-metrics-only 同时使用时有效", file=sys.stderr)
        raise SystemExit(2)

    rows = load_jsonl(args.dataset)
    if args.limit and args.limit > 0:
        rows = rows[: args.limit]

    if args.prompt_metrics_only:
        out = run_prompt_embedding_benchmark(
            rows,
            args.sentence_model,
            lexical_only=args.lexical_only,
            local_files_only=args.local_files_only,
        )
        fields = list(out[0].keys()) if out else []
    else:
        out = run_generation_benchmark(
            rows,
            args.base_url,
            args.sentence_model,
            local_files_only=args.local_files_only,
        )
        fields = list(out[0].keys()) if out else []

    for r in out:
        print(r)

    if args.out_csv and fields:
        with args.out_csv.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(out)
        print(f"[OK] wrote {args.out_csv}")


if __name__ == "__main__":
    main()
