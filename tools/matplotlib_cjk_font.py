"""
Matplotlib 中文字体：按系统尝试「整文件注册」，避免仅改 family 名却不生效（尤其 .ttc）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional, Tuple


def _candidate_files() -> list[Path]:
    """按优先级列出可能存在的字体文件路径。"""
    paths: list[Path] = []
    if sys.platform == "darwin":
        paths.extend(
            [
                Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
                Path("/System/Library/Fonts/PingFang.ttc"),
                Path("/System/Library/Fonts/STHeiti Light.ttc"),
                Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
                Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
                Path("/Library/Fonts/Arial Unicode.ttf"),
                Path("/Library/Fonts/Songti.ttc"),
            ]
        )
    elif sys.platform == "win32":
        windir = Path(os.environ.get("WINDIR", "C:/Windows"))
        paths.extend(
            [
                windir / "Fonts" / "msyh.ttc",
                windir / "Fonts" / "msyhbd.ttc",
                windir / "Fonts" / "simhei.ttf",
            ]
        )
    else:
        paths.extend(
            [
                Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
                Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
                Path("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc"),
            ]
        )
    return paths


def apply_matplotlib_cjk_font(plot_font_path: Optional[str] = None) -> Tuple[Optional[str], Optional[str]]:
    """
    配置 matplotlib 使用中文字体。
    若提供 plot_font_path，优先加载该文件（.ttf/.ttc/.otf）。
    返回 (注册后的 family 名, 字体文件路径)；失败则 (None, None)。
    """
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    plt.rcParams["axes.unicode_minus"] = False

    to_try: list[Path] = []
    if plot_font_path:
        to_try.append(Path(plot_font_path).expanduser())
    to_try.extend(_candidate_files())

    seen: set[str] = set()
    for p in to_try:
        if not p.is_file():
            continue
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        try:
            font_manager.fontManager.addfont(str(p))
        except Exception:
            continue
        try:
            prop = font_manager.FontProperties(fname=str(p))
            name = prop.get_name()
        except Exception:
            continue
        if not name:
            continue
        # 强制全局使用该族（sans-serif 回退链只放这一个，减少误用 DejaVu）
        plt.rcParams["font.family"] = "sans-serif"
        plt.rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
        return name, str(p)

    # 最后：从已扫描字体里按名字猜一个
    keywords = (
        "Hiragino Sans GB",
        "PingFang SC",
        "Heiti SC",
        "Songti SC",
        "Noto Sans CJK SC",
        "Noto Sans SC",
        "Microsoft YaHei",
        "SimHei",
        "WenQuanYi Micro Hei",
    )
    for entry in font_manager.fontManager.ttflist:
        if not any(kw in entry.name for kw in keywords):
            continue
        try:
            font_manager.fontManager.addfont(entry.fname)
            prop = font_manager.FontProperties(fname=entry.fname)
            n = prop.get_name()
            plt.rcParams["font.family"] = "sans-serif"
            plt.rcParams["font.sans-serif"] = [n, "DejaVu Sans"]
            return n, entry.fname
        except Exception:
            continue
    return None, None


def setup_cjk_font_for_plotting(font_name: Optional[str] = None):
    """
    一次配置 rcParams，并返回绑定到具体字体文件的 FontProperties（用于 title/刻度等强制生效）。
    font_name 可为字体文件路径，或 None（自动探测）；若为族名字符串则仅追加到 sans-serif 回退链。
    """
    from matplotlib import font_manager
    import matplotlib.pyplot as plt

    path_arg: Optional[str] = None
    if font_name and Path(font_name).expanduser().is_file():
        path_arg = str(Path(font_name).expanduser())

    _, fpath = apply_matplotlib_cjk_font(path_arg)

    if font_name and not path_arg:
        plt.rcParams["font.sans-serif"] = [font_name] + list(
            plt.rcParams.get("font.sans-serif", [])
        )

    if not fpath:
        return None
    try:
        return font_manager.FontProperties(fname=fpath)
    except Exception:
        return None


def apply_font_to_axis(ax, fp) -> None:
    """在绘图完成后调用：把坐标轴上已有文字的字体统一为 fp。"""
    if fp is None:
        return
    ax.title.set_fontproperties(fp)
    ax.xaxis.label.set_fontproperties(fp)
    ax.yaxis.label.set_fontproperties(fp)
    for t in ax.get_xticklabels():
        t.set_fontproperties(fp)
    for t in ax.get_yticklabels():
        t.set_fontproperties(fp)
    leg = ax.get_legend()
    if leg:
        for t in leg.get_texts():
            t.set_fontproperties(fp)
