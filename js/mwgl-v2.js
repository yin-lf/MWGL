import { uid } from "./ids.js";
import { alignWorkflowBBoxToOrigin } from "./viewport.js";

/** MWGL 语言版本（工作流 JSON 字段 mwgl_version） */
export const MWGL_VERSION = 2;

/**
 * v2 节点类型：
 * - start：唯一入口（禁止被 switch/case/loop/trigger 指向）
 * - wait_user：等待用户交互的中间节点
 * - trigger：与 switch 配套的触发条件（通常置于入口与 switch 之间）
 * - switch / loop：分支节点（出边须带非空 label）
 * - parallel：并行分支（至少 2 条出边）
 * - case：动作
 * - success / failure：终态（禁止出边），表示任务成功或失败
 */
export const NODE_TYPES = [
  "start",
  "wait_user",
  "trigger",
  "switch",
  "loop",
  "parallel",
  "case",
  "success",
  "failure"
];

function isEntryOnlyType(t) {
  return t === "start";
}

function isTerminalType(t) {
  return t === "success" || t === "failure";
}

function isBranchingType(t) {
  return t === "switch" || t === "loop";
}

function isParallelType(t) {
  return t === "parallel";
}

/**
 * 边合法性：保持 DAG；终态无出边；start 不可被控制流节点指向；禁止 start↔start 直连。
 */
export function isAllowedMwglEdge(nodes, fromId, toId) {
  const from = nodes.find((n) => n.id === fromId);
  const to = nodes.find((n) => n.id === toId);
  if (!from || !to) return false;
  if (isTerminalType(from.type)) return false;

  if (isEntryOnlyType(to.type)) {
    if (
      from.type === "switch" ||
      from.type === "case" ||
      from.type === "loop" ||
      from.type === "parallel" ||
      from.type === "trigger"
    ) {
      return false;
    }
    if (from.type === "start" && to.type === "start") return false;
  }

  if (from.type === "start" && to.type === "start") return false;

  return true;
}

/** 从 switch 或 loop 出发的边必须有非空 label */
export function edgeHasRequiredSwitchLabel(nodes, edge) {
  const from = nodes.find((n) => n.id === edge.from);
  if (!from || !isBranchingType(from.type)) return true;
  return String(edge.label || "").trim().length > 0;
}

export function hasDirectedPath(edges, startId, endId) {
  const adj = new Map();
  for (const e of edges || []) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const visited = new Set();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === endId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nxt of adj.get(cur) || []) {
      if (!visited.has(nxt)) stack.push(nxt);
    }
  }
  return false;
}

export function wouldEdgeCreateCycle(edges, fromId, toId) {
  if (fromId === toId) return true;
  return hasDirectedPath(edges, toId, fromId);
}

export function filterEdgesAcyclic(edges) {
  const kept = [];
  for (const e of edges || []) {
    if (wouldEdgeCreateCycle(kept, e.from, e.to)) continue;
    kept.push(e);
  }
  return kept;
}

export function validateWorkflowConstraints(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const errors = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    errors.push(`必须且仅能有一个 start 节点，当前为 ${starts.length} 个。`);
  }

  for (const n of nodes) {
    if (n.type !== "switch" && n.type !== "loop" && n.type !== "parallel") continue;
    const outs = edges.filter((e) => e.from === n.id);
    if (n.type === "switch" && outs.length < 1) {
      errors.push(`switch 节点 ${n.id} 至少需要 1 条出边。`);
    }
    if ((n.type === "loop" || n.type === "parallel") && outs.length < 2) {
      errors.push(`${n.type} 节点 ${n.id} 至少需要 2 条出边。`);
    }
    if (n.type === "switch" || n.type === "loop") {
      const labels = outs.map((e) => String(e.label || "").trim()).filter(Boolean);
      if (labels.length !== outs.length) {
        errors.push(`${n.type} 节点 ${n.id} 的每条出边都必须有非空标签。`);
      } else if (new Set(labels).size !== labels.length) {
        errors.push(`${n.type} 节点 ${n.id} 的出边标签不能重复。`);
      }
      if (n.type === "loop" && outs.length) {
        if (!labels.includes("继续") || !labels.includes("退出")) {
          errors.push(`loop 节点 ${n.id} 必须包含「继续」和「退出」两类出边标签。`);
        }
      }
    }
  }

  if (starts.length === 1) {
    const startId = starts[0].id;
    const startOut = edges.filter((e) => e.from === startId);
    if (!startOut.length) {
      errors.push("start 节点至少需要 1 条出边。");
    }

    const reachable = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const e of edges) {
        if (e.from !== cur) continue;
        if (!nodeMap.has(e.to)) continue;
        if (!reachable.has(e.to)) stack.push(e.to);
      }
    }

    const unreachable = nodes.filter((n) => n.id !== startId && !reachable.has(n.id));
    if (unreachable.length) {
      errors.push(`存在从 start 不可达的节点：${unreachable.map((n) => n.id).join(", ")}。`);
    }

    const reachableTerminal = nodes.filter(
      (n) => (n.type === "success" || n.type === "failure") && reachable.has(n.id)
    );
    if (!reachableTerminal.length) {
      errors.push("至少需要一个从 start 可达的终态节点（success 或 failure）。");
    }
  }

  return { ok: errors.length === 0, errors };
}

function typeRank(type) {
  const order = {
    start: 0,
    wait_user: 0,
    trigger: 1,
    switch: 2,
    loop: 2,
    parallel: 2,
    case: 3,
    success: 4,
    failure: 4
  };
  return order[type] ?? 5;
}

function sortTopoQueue(nodes, ids) {
  return [...ids].sort((a, b) => {
    const ta = nodes.find((n) => n.id === a)?.type;
    const tb = nodes.find((n) => n.id === b)?.type;
    const r = typeRank(ta) - typeRank(tb);
    if (r !== 0) return r;
    return String(a).localeCompare(String(b));
  });
}

export function layoutWorkflowLeftToRight(workflow) {
  const nodes = workflow?.nodes;
  const edges = workflow?.edges;
  if (!nodes?.length) return;
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const succs = new Map(ids.map((id) => [id, []]));
  const preds = new Map(ids.map((id) => [id, []]));
  for (const e of edges || []) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    succs.get(e.from).push(e.to);
    preds.get(e.to).push(e.from);
  }
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of edges || []) {
    if (idSet.has(e.from) && idSet.has(e.to)) indegree.set(e.to, indegree.get(e.to) + 1);
  }
  const roots = ids.filter((id) => indegree.get(id) === 0);
  const topo = [];
  const q2 = sortTopoQueue(nodes, roots);
  while (q2.length) {
    sortTopoQueue(nodes, q2);
    const u = q2.shift();
    topo.push(u);
    for (const v of succs.get(u) || []) {
      indegree.set(v, indegree.get(v) - 1);
      if (indegree.get(v) === 0) q2.push(v);
    }
  }
  if (topo.length !== ids.length) {
    alignWorkflowBBoxToOrigin(workflow);
    return;
  }

  const topoIndex = new Map(topo.map((id, i) => [id, i]));
  const depth = new Map(ids.map((id) => [id, 0]));
  for (const id of topo) {
    const ps = preds.get(id) || [];
    const d = ps.length === 0 ? 0 : Math.max(...ps.map((p) => depth.get(p) + 1));
    depth.set(id, d);
  }
  const layers = new Map();
  for (const id of ids) {
    const d = depth.get(id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(id);
  }
  const COL = 280;
  const ROW = 120;
  const PADX = 80;
  const PADY = 80;
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const layerIds = layers.get(d);
    layerIds.sort((a, b) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0));
    layerIds.forEach((id, i) => {
      const n = nodes.find((x) => x.id === id);
      if (n) {
        n.x = PADX + d * COL;
        n.y = PADY + i * ROW;
      }
    });
  }
  alignWorkflowBBoxToOrigin(workflow);
}

function buildDefaultEdges(nodes) {
  const edges = [];
  const firstByType = (type) => nodes.find((n) => n.type === type);
  const byType = (type) => nodes.filter((n) => n.type === type);
  const start = firstByType("start");
  const sw = firstByType("switch");
  const caseNodes = byType("case");

  if (start && sw) edges.push({ id: uid("e"), from: start.id, to: sw.id, label: "" });
  if (sw && caseNodes.length) {
    caseNodes.forEach((node, idx) => {
      const label =
        caseNodes.length === 2 ? (idx === 0 ? "是" : "否") : String(idx + 1);
      edges.push({
        id: uid("e"),
        from: sw.id,
        to: node.id,
        label
      });
    });
  }
  return edges;
}

function nextUniqueBranchLabel(used, preferred, fallbackPrefix = "分支") {
  for (const lab of preferred) {
    if (!used.has(lab)) return lab;
  }
  for (let i = 1; i <= 99; i += 1) {
    const candidate = `${fallbackPrefix}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${fallbackPrefix}_${uid("").slice(-4)}`;
}

function repairBranchingNodes(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (node.type !== "switch" && node.type !== "loop" && node.type !== "parallel") continue;
    const preferred = node.type === "loop" ? ["继续", "退出"] : node.type === "switch" ? ["是", "否"] : ["并行1", "并行2"];
    const outs = edges.filter((e) => e.from === node.id && nodeMap.has(e.to) && e.from !== e.to);
    const usedLabels = new Set();

    for (const e of outs) {
      const raw = String(e.label || "").trim();
      if ((node.type === "switch" || node.type === "loop") && (!raw || usedLabels.has(raw))) {
        const fixed = nextUniqueBranchLabel(usedLabels, preferred);
        e.label = fixed;
        usedLabels.add(fixed);
      } else {
        e.label = raw;
        if (raw) usedLabels.add(raw);
      }
    }

    while (outs.length < 2) {
      const newCaseId = uid();
      const yOffset = (outs.length + 1) * 96 - 48;
      nodes.push({
        id: newCaseId,
        type: "case",
        text: node.type === "loop" ? "补全分支 自动生成" : "补充分支 自动生成",
        x: Number(node.x || 0) + 280,
        y: Number(node.y || 0) + yOffset
      });
      nodeMap.set(newCaseId, nodes[nodes.length - 1]);

      const label = node.type === "parallel" ? "" : nextUniqueBranchLabel(usedLabels, preferred);
      const edge = { id: uid("e"), from: node.id, to: newCaseId, label };
      edges.push(edge);
      outs.push(edge);
      if (label) usedLabels.add(label);
    }

    if (node.type === "loop") {
      if (!usedLabels.has("继续") && outs[0]) outs[0].label = "继续";
      if (!usedLabels.has("退出") && outs[1]) outs[1].label = "退出";
    }
  }
}

function switchLooksLikeLoop(node, outs) {
  const text = String(node?.text || "").trim();
  const labels = new Set(outs.map((e) => String(e.label || "").trim()).filter(Boolean));
  const hasLoopLabels = labels.has("继续") && labels.has("退出");
  const textHintsLoop = /^循环/.test(text) || text.includes("迭代");
  return hasLoopLabels || (textHintsLoop && outs.length >= 2);
}

function convertSwitchToLoopWhenPossible(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  for (const node of nodes) {
    if (node.type !== "switch") continue;
    const outs = edges.filter((e) => e.from === node.id);
    if (!switchLooksLikeLoop(node, outs)) continue;
    node.type = "loop";
    const labels = new Set(outs.map((e) => String(e.label || "").trim()).filter(Boolean));
    if (!labels.has("继续") && outs[0]) outs[0].label = "继续";
    if (!labels.has("退出") && outs[1]) outs[1].label = "退出";
    if (String(node.text || "").startsWith("条件")) {
      node.text = String(node.text).replace(/^条件/, "循环条件");
    }
  }
}

export function normalizeWorkflow(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const nodes = Array.isArray(safe.nodes) ? safe.nodes : [];
  const normalizedNodes = nodes
    .filter((n) => n && typeof n === "object")
    .map((n, idx) => {
      const t = String(n.type || "");
      return {
        id: String(n.id || uid("n")),
        type: NODE_TYPES.includes(t) ? t : "case",
        text: String(n.text || "未命名节点"),
        x: Number.isFinite(Number(n.x)) ? Number(n.x) : 80 + idx * 30,
        y: Number.isFinite(Number(n.y)) ? Number(n.y) : 120 + idx * 30
      };
    });
  const finalNodes = normalizedNodes.length
    ? normalizedNodes
    : [{ id: uid(), type: "start", text: "开始 事件触发", x: 120, y: 180 }];

  const nodeIdSet = new Set(finalNodes.map((n) => n.id));
  const inputEdges = Array.isArray(safe.edges) ? safe.edges : [];
  let normalizedEdges = inputEdges
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      id: String(e.id || uid("e")),
      from: String(e.from || ""),
      to: String(e.to || ""),
      label: String(e.label || "")
    }))
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to) && e.from !== e.to)
    .filter((e) => isAllowedMwglEdge(finalNodes, e.from, e.to))
    .filter((e) => edgeHasRequiredSwitchLabel(finalNodes, e));

  convertSwitchToLoopWhenPossible({ nodes: finalNodes, edges: normalizedEdges });
  repairBranchingNodes({ nodes: finalNodes, edges: normalizedEdges });

  let acyclicEdges = filterEdgesAcyclic(normalizedEdges);

  const out = {
    mwgl_version: MWGL_VERSION,
    rule_id: String(safe.rule_id || uid("R_")),
    rule_name: String(safe.rule_name || "未命名工作流"),
    nodes: finalNodes,
    edges: acyclicEdges.length ? acyclicEdges : buildDefaultEdges(finalNodes)
  };

  // 兜底：先前过滤可能导致分支节点退化为单分支，返回前再次修复并保持 DAG。
  repairBranchingNodes(out);
  convertSwitchToLoopWhenPossible(out);
  acyclicEdges = filterEdgesAcyclic(out.edges || []);
  out.edges = acyclicEdges;

  layoutWorkflowLeftToRight(out);
  return out;
}

function collectLinearChainFrom(startId, edges, nodes, allowedTypes) {
  const texts = [];
  let cur = startId;
  const visited = new Set();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const node = nodes.find((n) => n.id === cur);
    if (!node) break;
    if (allowedTypes && !allowedTypes.includes(node.type)) break;
    texts.push(String(node.text || "").trim());
    const outs = (edges || []).filter((e) => e.from === cur);
    if (outs.length !== 1) break;
    cur = outs[0].to;
  }
  return texts;
}

function canMergeLegacyCompact(nodes) {
  const st = nodes.filter((n) => n.type === "start");
  const wu = nodes.filter((n) => n.type === "wait_user");
  const tr = nodes.filter((n) => n.type === "trigger");
  const sw = nodes.filter((n) => n.type === "switch");
  const lp = nodes.filter((n) => n.type === "loop");
  const suc = nodes.filter((n) => n.type === "success");
  const fail = nodes.filter((n) => n.type === "failure");
  if (
    st.length === 1 &&
    sw.length === 1 &&
    wu.length === 0 &&
    tr.length === 0 &&
    lp.length === 0 &&
    suc.length === 0 &&
    fail.length === 0
  ) {
    const allowed = new Set(["start", "switch", "case"]);
    return nodes.every((n) => allowed.has(n.type));
  }
  return false;
}

export function workflowToMwgl(workflow) {
  const safe = workflow && typeof workflow === "object" ? workflow : {};
  const nodes = Array.isArray(safe.nodes) ? safe.nodes : [];
  const edges = Array.isArray(safe.edges) ? safe.edges : [];
  const start = nodes.find((n) => n.type === "start");
  const sw = nodes.find((n) => n.type === "switch");

  if (canMergeLegacyCompact(nodes) && start && sw) {
    const startText = start?.text || "开始 未定义入口";
    const switchText = sw?.text || "条件 未定义";
    const fromSw = (edges || []).filter((e) => e.from === sw.id);
    const caseLines = [];

    if (fromSw.length) {
      for (const e of fromSw) {
        const lab = String(e.label || "").trim() || "?";
        const chain = collectLinearChainFrom(e.to, edges, nodes, ["case"]);
        const body = chain.length
          ? chain.join("；")
          : String(nodes.find((n) => n.id === e.to)?.text || "").trim();
        const labEsc = lab.replaceAll('"', '\\"');
        caseLines.push(`CASE "${labEsc}" ${body || "无动作"}`);
      }
    } else {
      const onlyCases = nodes.filter((n) => n.type === "case");
      onlyCases.forEach((node, idx) => {
        const chain = collectLinearChainFrom(node.id, edges, nodes, ["case"]);
        const body = chain.length ? chain.join("；") : String(node.text || "").trim();
        const lab =
          onlyCases.length === 2 ? (idx === 0 ? "是" : "否") : String(idx + 1);
        caseLines.push(`CASE "${lab}" ${body || "无动作"}`);
      });
    }

    const lines = [
      `RULE ${safe.rule_id || "R_UNKNOWN"} "${safe.rule_name || "未命名工作流"}"`,
      `VERSION ${MWGL_VERSION}`,
      startText,
      switchText,
      ...caseLines
    ];
    return lines.join("\n");
  }

  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const nodeLines = nodes.map((n) => {
    const text = String(n.text || "").replaceAll('"', '\\"');
    return `NODE ${n.id} ${n.type} "${text}"`;
  });
  const edgeLines = edges
    .filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to))
    .map((e) => {
      const label = String(e.label || "").replaceAll('"', '\\"');
      return `EDGE ${e.from} -> ${e.to} "${label}"`;
    });

  return [
    `RULE ${safe.rule_id || "R_UNKNOWN"} "${safe.rule_name || "未命名工作流"}"`,
    `VERSION ${MWGL_VERSION}`,
    "MODE graph",
    ...nodeLines,
    ...edgeLines
  ].join("\n");
}

export function mwglToWorkflow(text) {
  const lines = String(text).split("\n").map((x) => x.trim()).filter(Boolean);
  let ruleId = uid("R_");
  let ruleName = "从文本导入";
  let startText = "开始 未定义入口";
  let switchLine = "条件 未定义";
  let mode = "legacy";
  const graphNodes = [];
  const graphEdges = [];
  const caseSpecs = [];

  for (const line of lines) {
    if (line.startsWith("RULE ")) {
      const m = line.match(/^RULE\s+(\S+)\s+"([^"]+)"/);
      if (m) {
        ruleId = m[1];
        ruleName = m[2];
      }
    } else if (/^VERSION\s+\d+$/i.test(line)) {
      /* optional */
    } else if (line === "MODE graph") {
      mode = "graph";
    } else if (line.startsWith("开始")) {
      startText = line;
    } else if (line.startsWith("条件")) {
      switchLine = line;
    } else if (line.startsWith("分")) {
      switchLine = line;
    } else if (line.startsWith("NODE ")) {
      const m = line.match(/^NODE\s+(\S+)\s+(\S+)\s+"([\s\S]*)"$/);
      if (m) {
        const ty = m[2];
        graphNodes.push({
          id: m[1],
          type: NODE_TYPES.includes(ty) ? ty : "case",
          text: m[3].replaceAll('\\"', '"')
        });
      }
    } else if (line.startsWith("EDGE ")) {
      const m = line.match(/^EDGE\s+(\S+)\s+->\s+(\S+)\s+"([\s\S]*)"$/);
      if (m) {
        graphEdges.push({
          id: uid("e"),
          from: m[1],
          to: m[2],
          label: m[3].replaceAll('\\"', '"')
        });
      }
    } else if (/^CASE\s+"/.test(line)) {
      const m = line.match(/^CASE\s+"([^"]*)"\s+([\s\S]*)$/);
      if (m) caseSpecs.push({ label: m[1], body: m[2].trim() });
    }
  }

  if (mode === "graph" && graphNodes.length) {
    const fallbackX = {
      start: 120,
      wait_user: 120,
      trigger: 250,
      switch: 380,
      loop: 380,
      parallel: 380,
      case: 680,
      success: 920,
      failure: 920
    };
    const fallbackY = {
      start: 180,
      wait_user: 300,
      trigger: 180,
      switch: 180,
      loop: 320,
      parallel: 460,
      case: 120,
      success: 120,
      failure: 260
    };
    const nodes = graphNodes.map((n, idx) => {
      const t = String(n.type || "case");
      const ty = NODE_TYPES.includes(t) ? t : "case";
      return {
        id: String(n.id || uid()),
        type: ty,
        text: String(n.text || "未命名节点"),
        x: Number(fallbackX[ty] ?? 120) + idx * 8,
        y: Number(fallbackY[ty] ?? 120) + idx * 8
      };
    });
    return normalizeWorkflow({
      mwgl_version: MWGL_VERSION,
      rule_id: ruleId,
      rule_name: ruleName,
      nodes,
      edges: graphEdges
    });
  }

  const nodes = [
    { id: uid(), type: "start", text: startText, x: 120, y: 180 },
    { id: uid(), type: "switch", text: switchLine, x: 380, y: 180 }
  ];
  const swId = nodes[1].id;
  let wf = normalizeWorkflow({ rule_id: ruleId, rule_name: ruleName, nodes });

  if (caseSpecs.length) {
    wf.edges = wf.edges || [];
    let yOff = 0;
    for (const spec of caseSpecs) {
      const raw = spec.body.trim();
      const parts =
        raw === "无动作" || raw === ""
          ? []
          : raw
              .split("；")
              .map((x) => x.trim())
              .filter(Boolean);
      let prevId = swId;
      if (parts.length === 0) {
        const nid = uid();
        wf.nodes.push({
          id: nid,
          type: "case",
          text: "无动作",
          x: 680,
          y: 420 + yOff
        });
        wf.edges.push({ id: uid("e"), from: prevId, to: nid, label: spec.label });
        yOff += 90;
        continue;
      }
      parts.forEach((t, idx) => {
        const nid = uid();
        wf.nodes.push({
          id: nid,
          type: "case",
          text: t,
          x: 680 + idx * 30,
          y: 420 + yOff + idx * 50
        });
        wf.edges.push({
          id: uid("e"),
          from: prevId,
          to: nid,
          label: idx === 0 ? spec.label : ""
        });
        prevId = nid;
      });
      yOff += parts.length * 50 + 40;
    }
    wf = normalizeWorkflow({
      rule_id: wf.rule_id,
      rule_name: wf.rule_name,
      nodes: wf.nodes,
      edges: wf.edges
    });
  }

  return wf;
}
