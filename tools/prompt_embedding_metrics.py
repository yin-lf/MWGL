"""
指令变体上的嵌入鲁棒性统计（与 noise_dataset/Distribution/analyze.py 同源公式）。
用于在不调用工作流生成 API 时，量化 original / paraphrasing / noise 等变体在向量空间中的偏移。

字面对比见 lexical_prompt_metrics.py（免 numpy）。
"""
from __future__ import annotations

import math
from typing import Dict, List, Tuple

import numpy as np


def l2n(x: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True) + eps
    return x / n


def bias_variance(D: np.ndarray) -> Tuple[float, float, np.ndarray]:
    b = D.mean(axis=0)
    R = D - b
    var = np.mean(np.sum(R * R, axis=1))
    return float(np.linalg.norm(b)), float(var), b


def radial_angular_stats(Ou: np.ndarray, Mu: np.ndarray) -> Dict[str, float]:
    D = Mu - Ou
    s = np.sum(D * Ou, axis=1)
    P = D - s[:, None] * Ou
    cos_sim = np.clip(np.sum(Ou * Mu, axis=1), -1.0, 1.0)
    theta = np.arccos(cos_sim)

    return {
        "rad_bias": float(s.mean()),
        "rad_std": float(s.std()),
        "perp_mean": float(np.linalg.norm(P, axis=1).mean()),
        "perp_std": float(np.linalg.norm(P, axis=1).std()),
        "angle_mean_deg": float(theta.mean() * 180.0 / math.pi),
        "angle_std_deg": float(theta.std() * 180.0 / math.pi),
    }


def length_change_stats(O: np.ndarray, M: np.ndarray) -> Dict[str, float]:
    rO = np.linalg.norm(O, axis=1)
    rM = np.linalg.norm(M, axis=1)
    dR = rM - rO
    return {
        "delta_norm_mean": float(dR.mean()),
        "delta_norm_std": float(dR.std()),
        "orig_norm_mean": float(rO.mean()),
        "mod_norm_mean": float(rM.mean()),
    }


def encode_prompt_matrix(model, texts: List[str]) -> np.ndarray:
    """sentence-transformers encode -> (N, d) numpy"""
    return np.asarray(model.encode(texts, convert_to_numpy=True, show_progress_bar=False))


def metrics_vs_original(
    original_texts: List[str],
    variant_texts: List[str],
    model,
) -> Dict[str, float]:
    """
    与 analyze.py 中逐样本差分类似：对每一行 prompt 计算 O/M 嵌入，再在归一化空间上做 bias/variance。
    这里 N=样本行数（通常为 1 条或 jsonl 多行拼接批次）。
    """
    O_raw = encode_prompt_matrix(model, original_texts)
    M_raw = encode_prompt_matrix(model, variant_texts)
    if O_raw.shape != M_raw.shape:
        raise ValueError(f"shape mismatch {O_raw.shape} vs {M_raw.shape}")

    Ou = l2n(O_raw)
    Mu = l2n(M_raw)
    D_cos = Mu - Ou
    bias_mag_cos, var_cos, _ = bias_variance(D_cos)
    rms_cos = math.sqrt(var_cos)
    ra = radial_angular_stats(Ou, Mu)
    D_raw = M_raw - O_raw
    bias_mag_raw, var_raw, _ = bias_variance(D_raw)
    rms_raw = math.sqrt(var_raw)
    ln = length_change_stats(O_raw, M_raw)

    out = {
        "bias_mag_cos": bias_mag_cos,
        "var_cos": var_cos,
        "rms_cos": rms_cos,
        "bias_mag_raw": bias_mag_raw,
        "var_raw": var_raw,
        "rms_raw": rms_raw,
        **ra,
        **ln,
    }
    return out
