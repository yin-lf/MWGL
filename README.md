# MWGL Studio v2 说明文档

MWGL Studio v2 是一个用于编辑、导入导出与生成 MWGL 工作流的可视化工具，包含：

- 前端编辑器（画布编辑、约束校验、文本与 JSON 互转）
- 本地 Node.js 代理服务（调用 DeepSeek 生成工作流 JSON）

文档覆盖当前代码实现（含 `parallel`、`switch` 单分支、边选中删除等能力）。

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
- `label`：分支标签（`switch/loop` 出边必填；`parallel` 可为空）

## 4. 节点类型

当前支持 9 种节点：

- `start`：唯一入口
- `wait_user`：等待用户交互（中间节点）
- `trigger`：触发条件
- `switch`：条件分支（允许单分支 `if`）
- `loop`：迭代分支（DAG 表达，不用回边；语义分支为 `继续/退出`）
- `parallel`：并行分支（至少两条并行出边）
- `case`：动作节点
- `success`：成功终态
- `failure`：失败终态

### 建模建议（语义优先）

- 只有 `if` 没有 `else` 时，可直接用单分支 `switch`
- 存在明确“继续执行/退出循环”语义时，优先用 `loop`
- 存在“同时执行多条子任务”语义时，使用 `parallel`
- 仅做进入门槛判断（是否进入后续流程）时，优先用 `trigger`

## 5. 连接与图约束（已实现硬校验）

### 基础约束

- 边的 `from` / `to` 必须指向存在的节点
- 禁止自环（`from === to`）
- 全图必须是 DAG（禁止形成有向环）
- `success` / `failure` 不能再连出边

### start 入口约束

- 必须且仅有 1 个 `start`
- `start` 至少有 1 条出边
- 禁止 `start -> start`
- 禁止 `switch/case/loop/parallel/trigger -> start`

### 可达性约束

- 所有非 `start` 节点必须从 `start` 可达
- 至少存在 1 个从 `start` 可达的终态（`success` 或 `failure`）

### switch/loop/parallel 约束

- 每个 `switch` 至少 1 条出边
- 每个 `loop` / `parallel` 至少 2 条出边
- `switch` / `loop` 的每条出边 `label` 必须非空
- 同一 `switch` / `loop` 下，`label` 不可重复
- `loop` 必须包含 `继续` 和 `退出` 两类标签

### 并行建模说明

- `parallel` 表示从同一点并发分发到多个分支
- 当前语法层不强制“汇聚节点”类型，但业务上建议在后续节点汇聚再继续
- `parallel` 分支边允许空标签；如需可读性，可自行填写标签（例如“子任务A/子任务B”）

## 6. 归一化与自动修复（normalize）

前端在解析模型输出或文本导入时，会执行 `normalizeWorkflow` 做标准化处理：

- 清理非法边（指向不存在节点、自环、不允许的连线）
- 保证 DAG（过滤导致环的边）
- 自动修复分支节点的最低出边数：
  - `switch` 少于 1 条时补分支
  - `loop` / `parallel` 少于 2 条时补分支
- 自动修正 `switch/loop` 分支标签（缺失或重复时修复）
- 自动识别可转换场景：部分 `switch` 会被转成 `loop`
  - 例如已有 `继续/退出` 标签
  - 或节点文本包含“循环/迭代”且具备多分支

说明：自动修复是兜底能力，最佳实践仍是生成阶段输出结构化、语义清晰的图。
## 7. MWGL 文本导入/导出

支持两种风格：

- 紧凑文本（`RULE` + `VERSION` + `开始` + `条件` + `CASE`）
- 图模式文本（`MODE graph` + `NODE`/`EDGE`）

说明：

- 紧凑文本主要适用于简单 `start -> switch -> case` 场景
- 复杂图建议使用 `MODE graph`

## 8. 前端交互说明

- 拖动节点可调整位置
- 空白处拖拽可平移画布
- `Ctrl + 滚轮` 缩放
- `Shift + 拖节点` 快速创建连线
- 点击画布中的边可直接选中（高亮显示），可按 `Delete/Backspace` 或点击「删除连线」删除
- 从 `switch/loop` 连出的边会要求分支标签

补充：

- 新建 `switch/loop/parallel` 时会自动创建 2 个默认 `case` 分支
- `switch` 默认标签 `是/否`，`loop` 默认标签 `继续/退出`
- 画布支持右侧面板与图中选中态联动（节点与边）
## 9. API 说明

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

前端会解析并执行统一约束校验，不合法会提示错误。
## 10. 常见问题

- 生成后无法渲染：通常是工作流不满足约束，查看状态栏报错。
- 导入失败：检查文本是否符合 `开始/条件/CASE` 或 `MODE graph` 格式。
- API 报错：检查 `.env` 的 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_API_BASE`。
- 明明是循环却生成成了 `switch`：可在节点文本中明确写“循环/迭代”语义，或直接在图中改为 `loop`。
- 并行任务如何表达：使用 `parallel` 发散到多个 `case`/子流程，再在后续步骤汇聚。

