"""仅标准库：指令变体字面对比（无需 numpy / 句向量）。"""
from __future__ import annotations

import difflib
from typing import Dict


def lexical_variant_metrics(original: str, variant: str) -> Dict[str, float]:
    o, v = original or "", variant or ""
    ratio = difflib.SequenceMatcher(None, o, v).ratio()
    lo = max(len(o), 1)
    return {
        "lexical_sequence_ratio": float(ratio),
        "length_ratio": float(len(v)) / lo,
    }
