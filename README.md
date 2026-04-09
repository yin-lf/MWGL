# MWGL Studio v2 说明文档

MWGL Studio v2 是一个用于编辑、导入导出与生成 MWGL 工作流的可视化工具，包含：

- 前端编辑器（画布编辑、约束校验、文本与 JSON 互转）
- 本地 Node.js 代理服务（调用 DeepSeek 生成工作流 JSON）

文档覆盖当前代码实现（含 `parallel`、`switch` 单分支、`loop_start/loop_end`、边选中删除等能力）。

版本说明（当前）：

- 允许存在从 `start` 不可达的草稿节点，便于先搭图再连通；仅可达路径参与执行
- 条件语义主要写在 `switch` 出边 `label`；`loop_start` 仅负责进入循环体
- 编辑阶段允许临时不满足约束；在导出 MWGL/JSON 时执行一次最终校验
- normalize 不再尝试把 `switch` 自动转换为 `loop_start`
- normalize 不会为 `switch` 自动补分支（`switch` 可为单分支）

## 1. 快速启动

```bash
cd /home/jikaining/workspace/workflow/MWGL-v2
npm install
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm start
```

启动后访问：

- `http://localhost:3001`
- 健康检查：`http://localhost:3001/api/health`

## 2. 环境变量

参考 `.env.example`：

- `DEEPSEEK_API_KEY`：DeepSeek API Key（必填）
- `DEEPSEEK_API_BASE`：DeepSeek Base URL（默认 `https://api.deepseek.com/v1`）
- `PORT`：服务端口（默认 `3001`）
- `CORS_ORIGIN`：允许跨域来源（默认 `*`）

## 3. MWGL-v2 数据结构

```json
{
  "mwgl_version": 2,
  "rule_id": "R_xxx",
  "rule_name": "示例规则",
  "nodes": [
    { "id": "n1", "type": "start", "text": "开始 订单支付成功", "x": 120, "y": 180 }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "label": "" }
  ]
}
```

### 节点字段

- `id`：节点唯一 ID
- `type`：节点类型
- `text`：节点展示文本
- `x` / `y`：节点在画布中的坐标

### 边字段

- `id`：边唯一 ID
- `from`：起点节点 ID
- `to`：终点节点 ID
- `label`：分支/触发条件标签（`switch` 出边必填且需有语义；其他类型可为空）

## 4. 节点类型

当前支持 9 种节点：

- `start`：唯一入口
- `wait_user`：等待用户交互（中间节点）
- `switch`：条件分支节点（允许单分支 `if`）
- `loop_start`：循环开始节点（进入循环体的起点）
- `loop_end`：循环结束节点（用于收束本轮循环，可在两者间插入复杂逻辑）
- `parallel`：并行分支（至少两条并行出边）
- `case`：动作节点
- `success`：成功终态
- `failure`：失败终态

### 建模建议（语义优先）

- 只有 `if` 没有 `else` 时，可直接用单分支 `switch`
- 存在明确循环语义时，使用 `loop_start/loop_end`，并在两者之间组织循环体逻辑
- 存在“同时执行多条子任务”语义时，使用 `parallel`

## 5. 连接与图约束（已实现硬校验）

说明：以下约束以“最终导出/生成”为准。编辑过程中允许临时不满足，便于草稿建模。

### 基础约束

- 边的 `from` / `to` 必须指向存在的节点
- 禁止自环（`from === to`）
- 全图必须是 DAG（禁止形成有向环）
- `success` / `failure` 不能再连出边

### start 入口约束

- 必须且仅有 1 个 `start`
- `start` 至少有 1 条出边
- 禁止 `start -> start`
- 禁止 `switch/case/loop_start/loop_end/parallel -> start`

### 可达性约束

- 允许存在从 `start` 不可达的节点（作为设计草稿，不参与执行）
- 至少存在 1 个从 `start` 可达的终态（`success` 或 `failure`）

### switch/loop_start/parallel 约束

- 每个 `switch` 至少 1 条出边
- 每个 `loop_start` 必须且仅能有 1 条出边（进入循环体）；每个 `parallel` 至少 2 条出边
- 每个 `loop_end` 至少 1 条出边（连接循环后的下一步）
- `switch` 的每条出边 `label` 必须非空
- `switch` 的出边 `label` 必须有语义（不能是纯数字或“分支N”占位）
- 同一 `switch` 下，`label` 不可重复
- `loop_start/loop_end` 必须完整成对：
  - 每个 `loop_start` 必须存在可达的 `loop_end`
  - 每个 `loop_end` 必须由至少一个 `loop_start` 可达
- `switch` 允许单分支（仅 `if`）

#### switch 标签语义规则（重点）

- `switch` 的每条出边都必须回答“什么条件下走这条边”
- 标签应能直接落地为可执行判断（`if / else if`）
- 不允许占位写法（例如纯数字、`分支1`、`分支2`）

推荐示例：

- `已认证`
- `库存不足`
- `金额 > 1000`

不推荐示例：

- `1`
- `2`
- `分支1`

### loop 与 switch 选型

- 只做条件分流（一次判断后继续）用 `switch`
- 涉及重复执行/重试/遍历等迭代语义，用 `loop_start/loop_end`
- 能用 `loop_start/loop_end` 表达循环时，不要用 `switch` 模拟循环
- `loop_start` 不再区分“继续/退出”分支：它的下一跳必须是循环体内部逻辑，退出路径统一从 `loop_end` 后续节点表达

### 并行建模说明

- `parallel` 表示从同一点并发分发到多个分支
- 当前语法层不强制“汇聚节点”类型，但业务上建议在后续节点汇聚再继续
- `parallel` 分支边允许空标签；如需可读性，可自行填写标签（例如“子任务A/子任务B”）

## 6. 归一化与自动修复（normalize）

前端在解析模型输出或文本导入时，会执行 `normalizeWorkflow` 做标准化处理：

- 清理非法边（指向不存在节点、自环、不允许的连线）
- 保证 DAG（过滤导致环的边）
- 自动修复分支节点的最低出边数：
  - `loop_start` 少于 1 条时补分支
  - `parallel` 少于 2 条时补分支
- `switch` 不自动补分支（保留用户显式建模）
- 不再尝试将 `switch` 自动转换为 `loop_start`

## 7. 编辑态与导出态

- 编辑态（画布操作）：
  - 允许临时不满足约束（例如尚未连通、标签待补全）
  - 目标是提升搭图自由度
- 导出态（文本导出 / JSON 导出 / 生成后落地）：
  - 执行统一约束检查
  - 不满足约束会给出错误提示，需修复后再导出

## 8. MWGL 文本导入/导出

支持两种风格：

- 紧凑文本（`RULE` + `VERSION` + `开始` + `条件` + `CASE`）
- 图模式文本（`MODE graph` + `NODE`/`EDGE`）

说明：

- 紧凑文本主要适用于简单 `start -> switch -> case` 场景
- 复杂图建议使用 `MODE graph`
- 紧凑文本中的 `CASE` 行使用 `CASE "<label>" <动作体>` 形式（例如 `CASE "已认证" 通知财务`）

## 9. 前端交互说明

- 拖动节点可调整位置
- 空白处拖拽可平移画布
- `Ctrl + 滚轮` 缩放
- `Shift + 拖节点` 快速创建连线
- 点击画布中的边可直接选中（高亮显示），可按 `Delete/Backspace` 或点击「删除连线」删除
- 从 `switch` 连出的边会要求分支/触发条件标签

补充：

- 新建 `switch/parallel` 时会自动创建 2 个默认 `case` 分支；新建 `loop_start` 时默认创建 1 条进入循环体的连线
- `switch` 默认标签 `是/否`
- 画布支持右侧面板与图中选中态联动（节点与边）

## 10. API 说明

### `GET /api/health`

返回服务状态与配置摘要。

### `POST /api/mwgl/generate`

请求体：

```json
{ "prompt": "你的业务描述" }
```

返回：

```json
{ "content": "{...模型返回的 JSON 字符串...}" }
```

生成规则（与前端校验一致）：

- 边用于表达顺序连接；`switch` 的出边 `label` 承载条件语义
- `switch` 出边 `label` 不可为空，且同节点下不可重复
- `switch` 的每条出边 `label` 必须是可判定条件（业务语义），用于明确分支触发时机；禁止纯数字或 `分支N` 等占位写法
- `loop_start/loop_end` 必须完整成对（双向可关联），且每个 `loop_end` 需连接循环后的下一步
- 凡是可用 `loop_start/loop_end` 表达的迭代场景，不应使用 `switch` 模拟循环；`switch` 仅用于条件分流
- 使用该工作流生成的代码中，禁止不合规 `goto`（尤其是破坏 DAG 的任意回跳）；循环与重试应使用 `loop_start/loop_end` 等结构化方式表达

前端会解析并执行统一约束校验，不合法会提示错误。

## 11. 常见问题

- 生成后无法渲染：通常是工作流不满足约束，查看状态栏报错。
- 导入失败：检查文本是否符合 `开始/条件/CASE` 或 `MODE graph` 格式。
- API 报错：检查 `.env` 的 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_API_BASE`。
- 明明是循环却生成成了 `switch`：优先直接改为 `loop_start/loop_end`；保持 `loop_start` 仅连接循环体入口，循环退出从 `loop_end` 后续边表达。
- 并行任务如何表达：使用 `parallel` 发散到多个 `case`/子流程，再在后续步骤汇聚。
- 画布上有孤立节点是否报错：不会；不可达节点允许作为草稿存在，但不会进入执行路径。

