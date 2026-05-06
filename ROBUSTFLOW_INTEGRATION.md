# MWGL × RobustFlow 集成说明

> **单独克隆本仓库时**：Python 评测脚本依赖 RobustFlow 中的 `evaluate/graph_evaluator.py`。请将 [RobustFlow](https://github.com/DEFENSE-SEU/RobustFlow) 克隆到本地，并设置环境变量  
> `export ROBUSTFLOW_ROOT=/path/to/RobustFlow`  
> 再运行 `tools/eval_mwgl_robustness.py` / `tools/mwgl_robustness_ablation.py`。若本仓库仍放在 RobustFlow 内的 `MWGL-v2/MWGL`，则无需设置。

本文档汇总在 **MWGL Studio v2**（`MWGL-v2/MWGL`）中为提升工作流生成鲁棒性所做的改动，以及这些能力与 **RobustFlow** 仓库中哪些概念、代码路径相对应。

---

## 1. 目标与整体思路

| 目标 | 做法 |
|------|------|
| 降低「同一语义、不同表述」导致生成结果跳变 | 服务端 **多样本生成 + 结构校验 + 择优 + 修复**（借鉴 AFlow / RobustFlow 常用管线） |
| 可量化「有多鲁棒」 | 复用 RobustFlow 的 **图相似度评测**（`graph_evaluator`）与 **提示嵌入统计**（Distribution 分析同源公式） |
| 可对比「接入 RobustFlow 式管线前后」 | **消融脚本**：同一批变体提示下 `robust: false` vs `robust: true`，输出 CSV 与图表 |

---

## 2. 对 MWGL 的代码与配置改动清单

### 2.1 服务端：鲁棒生成管线（Node.js）

| 文件 | 作用 |
|------|------|
| [`lib/mwglRobust.mjs`](lib/mwglRobust.mjs) | 核心管线：并行多温度采样 → `normalizeWorkflow` + `validateWorkflowConstraints` 筛选 → 多合法时可 LLM 评审择优 → 全不合法时按错误信息修复重试 |
| [`routes/skill1-nl2dag.js`](routes/skill1-nl2dag.js) | `/api/mwgl/generate`：默认走鲁棒管线；`MWGL_ROBUST=0` 时单次调用；**请求体 `robust: true/false` 可覆盖环境变量**（用于消融实验） |
| [`routes/deepseek.js`](routes/deepseek.js) | 未改逻辑；鲁棒管线通过不同 `temperature` 多次调用 `callDeepSeek` |
| [`.env.example`](.env.example) | 增加 `MWGL_ROBUST`、`MWGL_ROBUST_SAMPLES`、`MWGL_ROBUST_REPAIR_MAX`、`MWGL_ROBUST_ENSEMBLE` 及 HF 相关说明 |

**前端/校验复用**：`mwglRobust.mjs` 直接 import 前端同源模块 [`js/mwgl-v2.js`](js/mwgl-v2.js) 中的 `normalizeWorkflow` 与 `validateWorkflowConstraints`，保证服务端筛选与编辑器一致。

### 2.2 评估与消融（Python，位于 `tools/`）

| 文件 | 作用 |
|------|------|
| [`tools/mwgl_workflow_adapter.py`](tools/mwgl_workflow_adapter.py) | 将 MWGL v2 JSON 转为 `graph_evaluator` 所需的 `{"nodes":[str], "edges":[(i,j)]}` |
| [`tools/prompt_embedding_metrics.py`](tools/prompt_embedding_metrics.py) | 提示变体 **嵌入空间** 的 bias/variance、径向/角度、范数差等（与 `noise_dataset/Distribution/analyze.py` 同源思路） |
| [`tools/lexical_prompt_metrics.py`](tools/lexical_prompt_metrics.py) | 无模型、仅标准库的字面相似度（网络不可用时的粗测） |
| [`tools/eval_mwgl_robustness.py`](tools/eval_mwgl_robustness.py) | 调用数据集：仅嵌入指标 `--prompt-metrics-only`；或调用 MWGL API 做 **节点/图级 F1** 评测；支持 `--lexical-only`、`--local-files-only`；默认 `HF_ENDPOINT` 指向镜像 |
| [`tools/mwgl_robustness_ablation.py`](tools/mwgl_robustness_ablation.py) | **Baseline vs Robust** 消融：对每个变体分别 `POST { robust: false }` / `{ robust: true }`，写 `data/reports/mwgl_ablation_results.csv` 并生成 `data/reports/visual/*.png` |
| [`tools/matplotlib_cjk_font.py`](tools/matplotlib_cjk_font.py) | 中文字体：`addfont` + `FontProperties` + 轴上文字强制绑定，减轻乱码 |
| [`tools/smoke_chinese_chart.py`](tools/smoke_chinese_chart.py) | 最小中文图，用于验证 matplotlib 字体 |
| [`tools/requirements-eval.txt`](tools/requirements-eval.txt) | 评估脚本依赖（含 `matplotlib`） |

### 2.3 数据与报告目录

| 路径 | 作用 |
|------|------|
| [`data/mwgl_robustness_benchmark.jsonl`](data/mwgl_robustness_benchmark.jsonl) | 小规模中文业务场景 + 多种提示变体（original / paraphrasing / noise / requirements 等） |
| [`data/DATASET_SOURCES.txt`](data/DATASET_SOURCES.txt) | 本地集说明、官方大数据下载链接、运行命令、字体与镜像提示 |
| [`data/reports/`](data/reports/) | 消融 CSV 默认输出目录 |
| [`data/reports/visual/`](data/reports/visual/) | 消融图、测试图默认输出目录 |

---

## 3. 运用了 RobustFlow 的哪些能力（对应关系）

### 3.1 论文与仓库层面的概念

RobustFlow 强调：**语义等价或带噪的指令**会导致工作流生成不稳定，因此需要 **评测指标** 与 **更稳的生成/训练策略**。本集成在 MWGL 侧对齐的是「**评测 + 推理期多样本与择优**」这条线（未改动 RobustFlow 的训练代码）。

### 3.2 AFlow / 算子层：多样本 + 自洽择优

- **来源**：RobustFlow 仓库中大量 `evaluate/aflow_scripts/DROP/.../graph.py` 使用多路生成 + `ScEnsemble`；[`evaluate/aflow_scripts/DROP/drop_requirements/template/operator.py`](../../evaluate/aflow_scripts/DROP/drop_requirements/template/operator.py) 中 `ScEnsemble` 对多份候选做 **LLM 选字母**（自洽思想，见论文 arXiv:2203.11171 等）。
- **在 MWGL 中的体现**：[`lib/mwglRobust.mjs`](lib/mwglRobust.mjs) 中并行多 `temperature` 采样；多个候选通过 `validateWorkflowConstraints` 后，可选再调一次模型做 **候选评审**（`MWGL_ROBUST_ENSEMBLE`）。

### 3.3 失败修复（类似「带反馈的再生成」）

- **来源**：仓库内 case study / 多轮工作流里常见的 **根据错误信息再提示模型** 的模式。
- **在 MWGL 中的体现**：`mwglRobust.mjs` 在全部样本校验失败时，把 **校验错误列表** 拼进 user 消息做 **最多 `MWGL_ROBUST_REPAIR_MAX` 轮** 修复调用。

### 3.4 图结构鲁棒性评测：节点级 / 图级 F1

- **来源**：[`evaluate/graph_evaluator.py`](../../evaluate/graph_evaluator.py) 中的 `t_eval_nodes`、`t_eval_graph`（句向量 + 拓扑序 / 可达闭包）。
- **在 MWGL 中的体现**：[`tools/eval_mwgl_robustness.py`](tools/eval_mwgl_robustness.py)、[`tools/mwgl_robustness_ablation.py`](tools/mwgl_robustness_ablation.py) 通过 `sys.path` 引用该模块；MWGL JSON 经 [`tools/mwgl_workflow_adapter.py`](tools/mwgl_workflow_adapter.py) 转换后参与评测。

### 3.5 提示变体在嵌入空间中的「偏差–方差」类统计

- **来源**：[`noise_dataset/Distribution/analyze.py`](../../noise_dataset/Distribution/analyze.py) 对多 variant 嵌入做 `bias_variance`、`radial_angular_stats`、`length_change_stats` 等。
- **在 MWGL 中的体现**：[`tools/prompt_embedding_metrics.py`](tools/prompt_embedding_metrics.py) 在 **original vs 各变体** 的句向量上复用同一套公式（`eval_mwgl_robustness.py --prompt-metrics-only`）。

### 3.6 可视化对比（精神对齐，非同一套图）

- **来源**：[`noise_dataset/Distribution/draw.py`](../../noise_dataset/Distribution/draw.py) 将统计结果画成散点图（bias–variance 概览）。
- **在 MWGL 中的体现**：[`tools/mwgl_robustness_ablation.py`](tools/mwgl_robustness_ablation.py) 输出 **Baseline vs Robust** 的柱状图与 **F1 前后散点**；指标维度不同，但用途一致：**一眼对比系统行为变化**。

### 3.7 官方大规模数据（未内置，仅文档指引）

- **来源**：RobustFlow README 中的 **Google Drive 预处理数据集**（DROP / MBPP 等，含 original、requirements、paraphrasing、多档 noise）。
- **在 MWGL 中的体现**：[`data/DATASET_SOURCES.txt`](data/DATASET_SOURCES.txt) 中的链接与放置说明；可自行把 JSONL 变体接到同一套评测脚本（需将条目格式对齐或写适配器）。

---

## 4. 环境变量与 API 约定（速查）

### 4.1 服务端 `.env`

- `MWGL_ROBUST`：默认开启鲁棒管线；`0` 关闭  
- `MWGL_ROBUST_SAMPLES`：并行采样数（默认 3）  
- `MWGL_ROBUST_REPAIR_MAX`：修复轮数上限  
- `MWGL_ROBUST_ENSEMBLE`：多合法候选时是否再调模型评审  

### 4.2 `POST /api/mwgl/generate`

- Body：`{ "prompt": "...", "robust": true }` 或 `false` **覆盖** `MWGL_ROBUST`（用于消融，无需重启服务）。

---

## 5. 推荐运行顺序（复现）

1. 配置 `DEEPSEEK_API_KEY`，在 `MWGL-v2/MWGL` 执行 `npm start`。  
2. Python 环境：`pip install -r ../../requirements.txt`（仓库根）及 `pip install -r tools/requirements-eval.txt`。  
3. **消融与出图**：`python tools/mwgl_robustness_ablation.py --base-url http://127.0.0.1:3001`  
4. 查看 `data/reports/mwgl_ablation_results.csv` 与 `data/reports/visual/*.png`。  
5. 若图中中文异常：使用 `--plot-font /path/to/NotoSansSC-Regular.otf` 或见 [`tools/matplotlib_cjk_font.py`](tools/matplotlib_cjk_font.py)。

---

## 6. 未包含的范围（避免误解）

- **未**把 RobustFlow 的 **DPO / 训练流水线** 迁入 MWGL；当前是 **推理期** 鲁棒策略。  
- **未**修改 MWGL 前端画布交互逻辑；校验规则仍来自 `js/mwgl-v2.js`。  
- 评测依赖 **外部句向量模型**（默认 `all-mpnet-base-v2`），与 RobustFlow `eval_*.py` 一致；需自行处理网络或本地缓存。

---

## 7. 参考文献与仓库内锚点

- RobustFlow 论文与介绍：仓库根目录 [`README.md`](../../README.md)  
- 图评测实现：[`evaluate/graph_evaluator.py`](../../evaluate/graph_evaluator.py)  
- 嵌入分析示例：[`noise_dataset/Distribution/analyze.py`](../../noise_dataset/Distribution/analyze.py)  
- 自洽择优算子示例：[`evaluate/aflow_scripts/DROP/drop_requirements/template/operator.py`](../../evaluate/aflow_scripts/DROP/drop_requirements/template/operator.py)（`ScEnsemble`）

---

*文档随 `MWGL-v2/MWGL` 目录内集成代码更新；若新增脚本或环境变量，请同步修改本节文件列表与速查表。*
