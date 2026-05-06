#!/usr/bin/env python3
"""生成一张带中文的小图，用于检查 matplotlib 字体是否正常。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt

_TOOLS = Path(__file__).resolve().parent
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))

from matplotlib_cjk_font import apply_font_to_axis, setup_cjk_font_for_plotting  # noqa: E402

_OUT = _TOOLS.parent / "data" / "reports" / "visual" / "smoke_chinese_test.png"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font-file", default=None, help="字体文件路径 .ttf/.ttc/.otf")
    args = ap.parse_args()

    fp = setup_cjk_font_for_plotting(args.font_file)
    if fp is None:
        print("警告: 未加载到中文字体，输出可能为方框。", file=sys.stderr)

    _OUT.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(5, 3.5), dpi=120)
    ax.bar(["苹果", "香蕉", "橙子"], [12, 19, 8], color=["#e74c3c", "#f1c40f", "#e67e22"])
    ax.set_title("水果销量小测（中文标题）")
    ax.set_ylabel("数量 / 箱")
    ax.set_xlabel("品类")
    ax.grid(axis="y", alpha=0.3)
    apply_font_to_axis(ax, fp)
    fig.tight_layout()
    fig.savefig(_OUT, bbox_inches="tight")
    plt.close(fig)
    print(f"已保存: {_OUT}")


if __name__ == "__main__":
    main()
