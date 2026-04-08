import { buildWorkflowByDeepSeek } from "./api.js";
import {
  edgeHasRequiredSwitchLabel,
  isAllowedMwglEdge,
  layoutWorkflowLeftToRight,
  mwglToWorkflow,
  validateWorkflowConstraints,
  workflowToMwgl,
  wouldEdgeCreateCycle
} from "./mwgl.js";
import { state, uid } from "./state.js";
import { WORLD_HEIGHT, WORLD_WIDTH, screenToUser } from "./viewport.js";

export function bindInteractions(elements, renderer) {
  const { setStatus, getSelectedNode, syncEditor, render, applyViewportTransform } = renderer;
  const SVG_NS = "http://www.w3.org/2000/svg";
  let linking = null;
  let panning = null;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.4;

  function firstConstraintError(workflow) {
    const result = validateWorkflowConstraints(workflow);
    return result.ok ? "" : result.errors[0];
  }

  function guessLabelForEdge(fromId) {
    const fromNode = state.workflow.nodes.find((n) => n.id === fromId);
    if (!fromNode) return "";
    const labels = new Set(
      (state.workflow.edges || [])
        .filter((e) => e.from === fromId)
        .map((e) => String(e.label || "").trim())
        .filter(Boolean)
    );
    if (fromNode.type === "switch") {
      if (!labels.has("是")) return "是";
      if (!labels.has("否")) return "否";
      for (let i = 3; i <= 99; i += 1) {
        const opt = String(i);
        if (!labels.has(opt)) return opt;
      }
      return `c${uid("").slice(-5)}`;
    }
    if (fromNode.type === "loop") {
      if (!labels.has("继续")) return "继续";
      if (!labels.has("退出")) return "退出";
      for (let i = 3; i <= 99; i += 1) {
        const opt = String(i);
        if (!labels.has(opt)) return opt;
      }
      return `c${uid("").slice(-5)}`;
    }
    return "";
  }

  function focusEdgeLabelInput() {
    const el = elements.edgeLabel;
    if (!el || typeof el.focus !== "function") return;
    el.focus();
    if (typeof el.select === "function") el.select();
  }

  const defaultTextForType = {
    start: "开始 新入口",
    wait_user: "等待用户 输入或确认",
    trigger: "触发条件 条件成立后进入分支",
    switch: "条件 新分支",
    loop: "循环条件 当条件成立时迭代；退出条件在「退出」分支说明",
    parallel: "并行分支 可同时执行多个动作",
    case: "新动作",
    success: "成功 任务完成",
    failure: "失败 任务失败"
  };

  function addNode(type) {
    if (type === "start" && state.workflow.nodes.some((n) => n.type === "start")) {
      setStatus("只允许存在一个 start 节点。", true);
      return;
    }
    if (type === "switch" || type === "loop" || type === "parallel") {
      const x = 120 + Math.floor(Math.random() * 220);
      const y = 120 + Math.floor(Math.random() * 260);
      const br = {
        id: uid(),
        type,
        text: defaultTextForType[type]
      };
      Object.assign(br, { x, y });
      const c1 = { id: uid(), type: "case", text: "新动作", x: x + 280, y: y - 48 };
      const c2 = { id: uid(), type: "case", text: "新动作", x: x + 280, y: y + 48 };
      state.workflow.nodes.push(br, c1, c2);
      state.workflow.edges = state.workflow.edges || [];
      const l1 = type === "switch" ? "是" : type === "loop" ? "继续" : "";
      const l2 = type === "switch" ? "否" : type === "loop" ? "退出" : "";
      state.workflow.edges.push(
        { id: uid("e"), from: br.id, to: c1.id, label: l1 },
        { id: uid("e"), from: br.id, to: c2.id, label: l2 }
      );
      state.selectedNodeId = br.id;
      state.selectedEdgeId = null;
      layoutWorkflowLeftToRight(state.workflow);
      state.pendingCenterViewport = true;
      render();
      return;
    }
    const node = {
      id: uid(),
      type,
      text: defaultTextForType[type] || "新节点",
      x: Math.round(-120 + Math.random() * 240),
      y: Math.round(-100 + Math.random() * 200)
    };
    state.workflow.nodes.push(node);
    state.selectedNodeId = node.id;
    state.selectedEdgeId = null;
    state.workflow.edges = state.workflow.edges || [];
    render();
  }

  function saveEditorToNode() {
    const node = getSelectedNode();
    if (!node) return;
    const nextType = elements.nodeType.value;
    if (
      nextType === "start" &&
      state.workflow.nodes.some((n) => n.id !== node.id && n.type === "start")
    ) {
      setStatus("只允许存在一个 start 节点。", true);
      return;
    }
    const snapshot = { type: node.type, text: node.text, x: node.x, y: node.y };
    node.type = nextType;
    node.text = elements.nodeText.value.trim() || "未命名节点";
    node.x = Number(elements.nodeX.value || 0);
    node.y = Number(elements.nodeY.value || 0);
    const err = firstConstraintError(state.workflow);
    if (err) {
      node.type = snapshot.type;
      node.text = snapshot.text;
      node.x = snapshot.x;
      node.y = snapshot.y;
      setStatus(`节点修改未通过约束校验：${err}`, true);
      return;
    }
    render();
  }

  function deleteSelectedNode() {
    if (!state.selectedNodeId) return;
    const selected = state.workflow.nodes.find((n) => n.id === state.selectedNodeId);
    if (selected?.type === "start") {
      setStatus("start 是唯一入口，不能删除。", true);
      return;
    }
    const before = state.workflow.nodes.length;
    const removedId = state.selectedNodeId;
    state.workflow.nodes = state.workflow.nodes.filter((n) => n.id !== state.selectedNodeId);
    state.workflow.edges = (state.workflow.edges || []).filter((e) => e.from !== removedId && e.to !== removedId);
    if (state.workflow.nodes.length === before) return;
    state.selectedNodeId = state.workflow.nodes[0] ? state.workflow.nodes[0].id : null;
    state.selectedEdgeId = null;
    render();
  }

  function saveEdge() {
    const from = elements.edgeFrom.value;
    const to = elements.edgeTo.value;
    let label = elements.edgeLabel.value.trim();
    const selectedEdgeId = elements.edgeSelect.value;
    if (!from || !to) return setStatus("请先选择连线起点和终点。", true);
    if (from === to) return setStatus("连线起点和终点不能相同。", true);
    if (!isAllowedMwglEdge(state.workflow.nodes, from, to)) {
      return setStatus(
        "不允许该连线（终态 success/failure 不可再连出；入口 start 不可被 switch/case/loop/trigger 指向；禁止 start 直连 start）。",
        true
      );
    }

    state.workflow.edges = state.workflow.edges || [];
    const edgesWithoutSelected = selectedEdgeId
      ? state.workflow.edges.filter((e) => e.id !== selectedEdgeId)
      : state.workflow.edges;
    if (wouldEdgeCreateCycle(edgesWithoutSelected, from, to)) {
      return setStatus(
        "不允许形成有向环；迭代语义请用 loop 节点（继续/退出）或写在 case 正文，勿用连线回环。",
        true
      );
    }

    const fromNodeForLabel = state.workflow.nodes.find((n) => n.id === from);
    if (!label && (fromNodeForLabel?.type === "switch" || fromNodeForLabel?.type === "loop")) {
      label = guessLabelForEdge(from);
      elements.edgeLabel.value = label;
    }
    const draftEdge = { from, to, label };
    if (!edgeHasRequiredSwitchLabel(state.workflow.nodes, draftEdge)) {
      return setStatus(
        "从 switch 或 loop 出发的边必须填写分支标签（例如 是/否、继续/退出）。",
        true
      );
    }

    if (selectedEdgeId) {
      const edge = state.workflow.edges.find((e) => e.id === selectedEdgeId);
      if (!edge) return setStatus("未找到要更新的连线。", true);
      const snapshot = { from: edge.from, to: edge.to, label: edge.label };
      edge.from = from;
      edge.to = to;
      edge.label = label;
      const err = firstConstraintError(state.workflow);
      if (err) {
        edge.from = snapshot.from;
        edge.to = snapshot.to;
        edge.label = snapshot.label;
        return setStatus(`连线更新未通过约束校验：${err}`, true);
      }
      state.selectedEdgeId = edge.id;
      elements.edgeSelect.value = edge.id;
      render();
      setStatus("连线已更新。");
      return;
    }

    const fromNode = state.workflow.nodes.find((n) => n.id === from);

    const exists = state.workflow.edges.some((e) => e.from === from && e.to === to && e.label === label);
    if (exists) return setStatus("该连线已存在。", true);
    state.workflow.edges.push({ id: uid("e"), from, to, label });
    const createdEdge = state.workflow.edges[state.workflow.edges.length - 1];
    const err = firstConstraintError(state.workflow);
    if (err) {
      state.workflow.edges.pop();
      return setStatus(`连线新增未通过约束校验：${err}`, true);
    }
    state.selectedEdgeId = createdEdge.id;
    elements.edgeSelect.value = createdEdge.id;
    render();
    if ((fromNode?.type === "switch" || fromNode?.type === "loop") && label) {
      setTimeout(() => focusEdgeLabelInput(), 0);
    }
    setStatus("连线已新增。可修改分支标签。");
  }

  function deleteEdge() {
    const selectedEdgeId = state.selectedEdgeId || elements.edgeSelect.value;
    if (!selectedEdgeId) return setStatus("请先选择要删除的连线。", true);
    const before = (state.workflow.edges || []).length;
    const kept = (state.workflow.edges || []).filter((e) => e.id !== selectedEdgeId);
    const oldEdges = state.workflow.edges;
    state.workflow.edges = kept;
    const err = firstConstraintError(state.workflow);
    if (err) {
      state.workflow.edges = oldEdges;
      return setStatus(`连线删除未通过约束校验：${err}`, true);
    }
    if (state.workflow.edges.length === before) return setStatus("未找到要删除的连线。", true);
    state.selectedEdgeId = null;
    elements.edgeSelect.value = "";
    elements.edgeLabel.value = "";
    render();
    setStatus("连线已删除。");
  }

  function bindEdgeEvents() {
    elements.edgeSelect.addEventListener("change", () => {
      const selectedEdgeId = elements.edgeSelect.value;
      state.selectedEdgeId = selectedEdgeId || null;
      const edge = (state.workflow.edges || []).find((e) => e.id === selectedEdgeId);
      if (!edge) {
        elements.edgeLabel.value = "";
        render();
        return;
      }
      elements.edgeFrom.value = edge.from;
      elements.edgeTo.value = edge.to;
      elements.edgeLabel.value = edge.label || "";
      render();
    });
  }

  async function callDeepSeekAndBuildWorkflow() {
    const prompt = elements.userPrompt.value.trim();
    const base = elements.apiBase.value.trim().replace(/\/$/, "");

    if (!prompt) return setStatus("请先输入业务描述。", true);

    localStorage.setItem("mwgl_api_base", base);
    setStatus("正在调用 DeepSeek...");

    try {
      const workflow = await buildWorkflowByDeepSeek({ base, prompt });
      const err = firstConstraintError(workflow);
      if (err) throw new Error(`生成结果不满足约束：${err}`);
      state.workflow = workflow;
      state.selectedNodeId = state.workflow.nodes[0]?.id || null;
      state.selectedEdgeId = null;
      state.pendingCenterViewport = true;
      render();
      setStatus("已生成 MWGL 并渲染到画布。");
    } catch (error) {
      setStatus(`生成失败：${error.message}`, true);
    }
  }

  function bindCanvasEvents() {
    function syncEdgeSelectionToEditor(edgeId) {
      const edge = (state.workflow.edges || []).find((e) => e.id === edgeId);
      if (!edge) return;
      state.selectedEdgeId = edgeId;
      elements.edgeSelect.value = edgeId;
      elements.edgeFrom.value = edge.from;
      elements.edgeTo.value = edge.to;
      elements.edgeLabel.value = edge.label || "";
    }

    function isTypingTarget(target) {
      if (!target) return false;
      const el = target instanceof Element ? target : null;
      if (!el) return false;
      return !!el.closest("input, textarea, select, [contenteditable='true']");
    }

    function getCanvasPoint(event) {
      const rect = elements.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      return screenToUser(px, py, state.canvasOffset || { x: 0, y: 0 }, state.canvasScale);
    }

    function getNodeCenterById(id) {
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return null;
      return {
        x: WORLD_WIDTH / 2 + node.x + 100,
        y: WORLD_HEIGHT / 2 + node.y + 28
      };
    }

    function upsertPreviewPath(fromId, x, y) {
      const layer = elements.canvasWorld.querySelector(".edge-layer");
      if (!layer) return;
      const start = getNodeCenterById(fromId);
      if (!start) return;
      let preview = layer.querySelector(".edge-preview");
      if (!preview) {
        preview = document.createElementNS(SVG_NS, "path");
        preview.setAttribute("class", "edge-preview");
        layer.appendChild(preview);
      }
      const midX = Math.round((start.x + x) / 2);
      const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${y}, ${x} ${y}`;
      preview.setAttribute("d", d);
    }

    function clearPreviewPath() {
      const layer = elements.canvasWorld.querySelector(".edge-layer");
      const preview = layer ? layer.querySelector(".edge-preview") : null;
      if (preview) preview.remove();
    }

    elements.canvasWorld.addEventListener("pointerdown", (event) => {
      elements.canvas.focus();
      const edgeEl = event.target.closest(".edge-hit");
      if (edgeEl?.dataset?.edgeId) {
        state.selectedNodeId = null;
        syncEdgeSelectionToEditor(edgeEl.dataset.edgeId);
        render();
        setStatus("已选中连线。按 Delete/Backspace 或点「删除连线」可删除。");
        event.preventDefault();
        return;
      }
      const nodeEl = event.target.closest(".node");
      if (!nodeEl) {
        state.selectedEdgeId = null;
        elements.edgeSelect.value = "";
        state.pendingCenterViewport = false;
        panning = {
          startX: event.clientX,
          startY: event.clientY,
          offsetX: state.canvasOffset?.x || 0,
          offsetY: state.canvasOffset?.y || 0
        };
        event.preventDefault();
        return;
      }
      const id = nodeEl.dataset.id;
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return;
      const point = getCanvasPoint(event);

      if (event.shiftKey) {
        linking = { fromId: id };
        upsertPreviewPath(id, point.x, point.y);
        return;
      }

      state.selectedNodeId = id;
      state.selectedEdgeId = null;
      elements.edgeSelect.value = "";
      syncEditor();
      state.drag = {
        id,
        offsetX: point.x - node.x,
        offsetY: point.y - node.y
      };
      nodeEl.classList.add("dragging");
      render();
    });

    window.addEventListener("pointermove", (event) => {
      if (panning) {
        const dx = event.clientX - panning.startX;
        const dy = event.clientY - panning.startY;
        state.canvasOffset = {
          x: panning.offsetX + dx,
          y: panning.offsetY + dy
        };
        applyViewportTransform();
        return;
      }
      if (linking) {
        const point = getCanvasPoint(event);
        upsertPreviewPath(linking.fromId, point.x, point.y);
        return;
      }
      if (!state.drag) return;
      const node = state.workflow.nodes.find((n) => n.id === state.drag.id);
      if (!node) return;
      const point = getCanvasPoint(event);
      node.x = Math.round(point.x - state.drag.offsetX);
      node.y = Math.round(point.y - state.drag.offsetY);
      render();
    });

    window.addEventListener("pointerup", (event) => {
      if (panning) {
        panning = null;
      }
      if (linking) {
        const targetEl = event.target.closest ? event.target.closest(".node") : null;
        if (targetEl) {
          const toId = targetEl.dataset.id;
          const fromId = linking.fromId;
          if (fromId !== toId) {
            if (!isAllowedMwglEdge(state.workflow.nodes, fromId, toId)) {
              setStatus(
                "不允许该连线（终态不可再连出；入口 start 不可被控制流指向）。",
                true
              );
            } else if (wouldEdgeCreateCycle(state.workflow.edges || [], fromId, toId)) {
              setStatus(
                "不允许形成有向环；请使用 loop 节点或 case 正文描述迭代。",
                true
              );
            } else {
              const exists = (state.workflow.edges || []).some((e) => e.from === fromId && e.to === toId);
              if (!exists) {
                const label = guessLabelForEdge(fromId);
                if (!edgeHasRequiredSwitchLabel(state.workflow.nodes, { from: fromId, to: toId, label })) {
                  setStatus(
                    "从 switch 或 loop 拖出的边必须带分支标签；可在下方「分支标签」中填写。",
                    true
                  );
                } else {
                  state.workflow.edges = state.workflow.edges || [];
                  const edge = { id: uid("e"), from: fromId, to: toId, label };
                  state.workflow.edges.push(edge);
                  const err = firstConstraintError(state.workflow);
                  if (err) {
                    state.workflow.edges = state.workflow.edges.filter((e) => e.id !== edge.id);
                    setStatus(`拖线新增未通过约束校验：${err}`, true);
                    clearPreviewPath();
                    linking = null;
                    return;
                  }
                  elements.edgeFrom.value = fromId;
                  elements.edgeTo.value = toId;
                  elements.edgeLabel.value = label;
                  state.selectedEdgeId = edge.id;
                  elements.edgeSelect.value = edge.id;
                  render();
                  setTimeout(() => focusEdgeLabelInput(), 0);
                  setStatus("已通过拖线创建连线。可在下方「分支标签」中修改选项名。");
                }
              } else {
                setStatus("该连线已存在。", true);
              }
            }
          }
        }
        clearPreviewPath();
        linking = null;
      }

      state.drag = null;
      const dragging = document.querySelector(".node.dragging");
      if (dragging) dragging.classList.remove("dragging");
    });

    elements.canvasWorld.addEventListener("click", (event) => {
      const nodeEl = event.target.closest(".node");
      if (!nodeEl) return;
      state.selectedEdgeId = null;
      elements.edgeSelect.value = "";
      state.selectedNodeId = nodeEl.dataset.id;
      render();
    });

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTypingTarget(event.target)) return;
      if (!state.selectedEdgeId) return;
      event.preventDefault();
      deleteEdge();
    });

    elements.canvas.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      if (document.activeElement !== elements.canvas) return;
      event.preventDefault();

      const oldScale = state.canvasScale || 1;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (event.deltaY < 0 ? 1.08 : 0.92)));
      if (nextScale === oldScale) return;

      state.pendingCenterViewport = false;
      const rect = elements.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const offset = state.canvasOffset || { x: 0, y: 0 };
      const ratio = nextScale / oldScale;

      state.canvasOffset = {
        x: Math.round(px - (px - offset.x) * ratio),
        y: Math.round(py - (py - offset.y) * ratio)
      };
      state.canvasScale = nextScale;
      applyViewportTransform();
    }, { passive: false });
  }

  function bindActions() {
    document.getElementById("btnGenerate").addEventListener("click", callDeepSeekAndBuildWorkflow);
    document.getElementById("btnParseMwgl").addEventListener("click", () => {
      try {
        const workflow = mwglToWorkflow(elements.mwglText.value);
        const err = firstConstraintError(workflow);
        if (err) throw new Error(`导入结果不满足约束：${err}`);
        state.workflow = workflow;
        state.selectedNodeId = state.workflow.nodes[0]?.id || null;
        state.selectedEdgeId = null;
        state.pendingCenterViewport = true;
        render();
        setStatus("已从 MWGL 文本导入。");
      } catch (error) {
        setStatus(`MWGL 导入失败：${error.message}`, true);
      }
    });

    document.getElementById("btnExportMwgl").addEventListener("click", async () => {
      const err = firstConstraintError(state.workflow);
      if (err) return setStatus(`当前工作流未通过约束校验：${err}`, true);
      const text = workflowToMwgl(state.workflow);
      elements.mwglText.value = text;
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 MWGL（并尝试复制到剪贴板）。");
    });

    document.getElementById("btnExportJson").addEventListener("click", async () => {
      const err = firstConstraintError(state.workflow);
      if (err) return setStatus(`当前工作流未通过约束校验：${err}`, true);
      const text = JSON.stringify(state.workflow, null, 2);
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 JSON（并尝试复制到剪贴板）。");
    });

    document.getElementById("addEvent").addEventListener("click", () => addNode("start"));
    document.getElementById("addWaitUser").addEventListener("click", () => addNode("wait_user"));
    document.getElementById("addTrigger").addEventListener("click", () => addNode("trigger"));
    document.getElementById("addSwitch").addEventListener("click", () => addNode("switch"));
    document.getElementById("addLoop").addEventListener("click", () => addNode("loop"));
    document.getElementById("addParallel").addEventListener("click", () => addNode("parallel"));
    document.getElementById("addCase").addEventListener("click", () => addNode("case"));
    document.getElementById("addSuccess").addEventListener("click", () => addNode("success"));
    document.getElementById("addFailure").addEventListener("click", () => addNode("failure"));
    document.getElementById("btnLayoutLr").addEventListener("click", () => {
      layoutWorkflowLeftToRight(state.workflow);
      state.pendingCenterViewport = true;
      render();
      setStatus("已按执行顺序从左到右排列。");
    });

    document.getElementById("saveNode").addEventListener("click", () => {
      saveEditorToNode();
      setStatus("节点已更新。");
    });

    document.getElementById("deleteNode").addEventListener("click", () => {
      deleteSelectedNode();
      setStatus("节点已删除。");
    });

    document.getElementById("saveEdge").addEventListener("click", saveEdge);
    document.getElementById("deleteEdge").addEventListener("click", deleteEdge);
  }

  bindActions();
  bindCanvasEvents();
  bindEdgeEvents();
}
