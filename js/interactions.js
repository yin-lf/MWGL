import { buildWorkflowByDeepSeek, dagToPseudocode, pseudoToCode } from "./api.js";
import {
  wouldEdgeCreateCycle,
  isAllowedMwglEdge,
  layoutWorkflowLeftToRight,
  mwglToWorkflow,
  validateWorkflowConstraints,
  workflowToMwgl
} from "./mwgl.js";
import { state, uid } from "./state.js";
import { NODE_LAYOUT_HEIGHT, NODE_LAYOUT_WIDTH, WORLD_HEIGHT, WORLD_WIDTH, screenToUser } from "./viewport.js";

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
        const opt = `条件${i}`;
        if (!labels.has(opt)) return opt;
      }
      return `条件_${uid("").slice(-4)}`;
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
    switch: "条件 新分支",
    loop_start: "循环开始 进入循环体（退出统一在 loop_end 后）",
    loop_end: "循环结束 本轮结束后的收束节点",
    parallel: "并行分支 可同时执行多个动作",
    case: "新动作",
    success: "成功 任务完成",
    failure: "失败 任务失败"
  };

  function addNode(type) {
    if (type === "switch" || type === "loop_start" || type === "parallel") {
      const x = 120 + Math.floor(Math.random() * 220);
      const y = 120 + Math.floor(Math.random() * 260);
      const br = {
        id: uid(),
        type,
        text: defaultTextForType[type]
      };
      Object.assign(br, { x, y });
      const c1 = { id: uid(), type: "case", text: "新动作", x: x + 280, y: y - 48 };
      state.workflow.nodes.push(br, c1);
      state.workflow.edges = state.workflow.edges || [];
      if (type === "switch" || type === "parallel") {
        const c2 = { id: uid(), type: "case", text: "新动作", x: x + 280, y: y + 48 };
        state.workflow.nodes.push(c2);
        const l1 = type === "switch" ? "是" : "";
        const l2 = type === "switch" ? "否" : "";
        state.workflow.edges.push(
          { id: uid("e"), from: br.id, to: c1.id, label: l1 },
          { id: uid("e"), from: br.id, to: c2.id, label: l2 }
        );
      } else {
        state.workflow.edges.push({ id: uid("e"), from: br.id, to: c1.id, label: "" });
      }
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
    node.type = nextType;
    node.text = elements.nodeText.value.trim() || "未命名节点";
    node.x = Number(elements.nodeX.value || 0);
    node.y = Number(elements.nodeY.value || 0);
    render();
  }

  function deleteSelectedNode() {
    if (!state.selectedNodeId) return;
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
    state.workflow.edges = state.workflow.edges || [];

    const fromNodeForLabel = state.workflow.nodes.find((n) => n.id === from);
    if (!label && fromNodeForLabel?.type === "switch") {
      label = guessLabelForEdge(from);
      elements.edgeLabel.value = label;
    }
    const edgeError = validateEdgeAtEditTime({
      from,
      to,
      label,
      editingEdgeId: selectedEdgeId || null
    });
    if (edgeError) return setStatus(edgeError, true);

    if (selectedEdgeId) {
      const edge = state.workflow.edges.find((e) => e.id === selectedEdgeId);
      if (!edge) return setStatus("未找到要更新的连线。", true);
      edge.from = from;
      edge.to = to;
      edge.label = label;
      state.selectedEdgeId = edge.id;
      elements.edgeSelect.value = edge.id;
      render();
      setStatus("连线已更新。");
      return;
    }

    const exists = state.workflow.edges.some((e) => e.from === from && e.to === to && e.label === label);
    if (exists) return setStatus("该连线已存在。", true);
    state.workflow.edges.push({ id: uid("e"), from, to, label });
    const createdEdge = state.workflow.edges[state.workflow.edges.length - 1];
    state.selectedEdgeId = createdEdge.id;
    elements.edgeSelect.value = createdEdge.id;
    render();
    if (fromNodeForLabel?.type === "switch" && label) {
      setTimeout(() => focusEdgeLabelInput(), 0);
    }
    setStatus("连线已新增。");
  }

  function deleteEdge() {
    const selectedEdgeId = state.selectedEdgeId || elements.edgeSelect.value;
    if (!selectedEdgeId) return setStatus("请先选择要删除的连线。", true);
    const before = (state.workflow.edges || []).length;
    const kept = (state.workflow.edges || []).filter((e) => e.id !== selectedEdgeId);
    state.workflow.edges = kept;
    if (state.workflow.edges.length === before) return setStatus("未找到要删除的连线。", true);
    state.selectedEdgeId = null;
    elements.edgeSelect.value = "";
    elements.edgeLabel.value = "";
    render();
    setStatus("连线已删除。");
  }

  function isSemanticSwitchLabel(label) {
    const text = String(label || "").trim();
    if (!text) return false;
    if (/^\d+$/.test(text)) return false;
    if (/^分支\d*$/i.test(text)) return false;
    return true;
  }

  function validateEdgeAtEditTime({ from, to, label, editingEdgeId = null }) {
    const nodes = state.workflow.nodes || [];
    const edges = state.workflow.edges || [];
    const fromNode = nodes.find((n) => n.id === from);

    if (!from || !to) return "请先选择连线起点和终点。";
    if (from === to) return "连线起点和终点不能相同。";
    if (!fromNode) return "未找到连线起点节点。";
    if (!nodes.some((n) => n.id === to)) return "未找到连线终点节点。";
    if (!isAllowedMwglEdge(nodes, from, to)) {
      return "该连线不允许：禁止连到 start，且 success/failure 不能连出边。";
    }

    const nextEdges = editingEdgeId
      ? edges.map((e) => (e.id === editingEdgeId ? { ...e, from, to, label } : e))
      : [...edges, { id: "__new__", from, to, label }];
    const cycleBaseEdges = editingEdgeId ? edges.filter((e) => e.id !== editingEdgeId) : edges;
    if (wouldEdgeCreateCycle(cycleBaseEdges, from, to)) {
      return "该连线不允许：会形成有向环（必须保持 DAG）。";
    }

    if (fromNode.type === "loop_start") {
      const outCount = nextEdges.filter((e) => e.from === from).length;
      if (outCount !== 1) return "loop_start 必须且仅能有 1 条出边。";
    }

    if (fromNode.type === "switch") {
      const trimmed = String(label || "").trim();
      if (!trimmed) return "switch 的每条出边都必须填写非空条件标签。";
      if (!isSemanticSwitchLabel(trimmed)) return "switch 标签必须是有语义的条件（不能是纯数字或“分支N”）。";
      const labels = nextEdges
        .filter((e) => e.from === from)
        .map((e) => String(e.label || "").trim())
        .filter(Boolean);
      if (new Set(labels).size !== labels.length) return "同一 switch 下，出边标签不能重复。";
    }

    return "";
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
      state.workflow = workflow;
      state.selectedNodeId = state.workflow.nodes[0]?.id || null;
      state.selectedEdgeId = null;
      state.pendingCenterViewport = true;
      render();
      const err = firstConstraintError(workflow);
      setStatus(err ? `已生成并渲染（草稿态，最终导出前请修复：${err}）` : "已生成 MWGL 并渲染到画布。");
    } catch (error) {
      setStatus(`生成失败：${error.message}`, true);
    }
  }

  async function callDeepSeekForPseudocode() {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const workflow = state.workflow;

    if (!workflow || !workflow.nodes || !workflow.nodes.length) {
      return setStatus("当前没有可转换的工作流。", true);
    }

    localStorage.setItem("mwgl_api_base", base);
    setStatus("正在调用 DeepSeek 生成伪代码...");

    try {
      const pseudocode = await dagToPseudocode({ base, workflow });
      state.pseudocode = pseudocode;
      elements.pseudocodeText.value = pseudocode;
      setStatus("已生成伪代码。");
    } catch (error) {
      setStatus(`伪代码生成失败：${error.message}`, true);
    }
  }

  async function callDeepSeekForCode() {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const pseudocode = elements.pseudocodeText.value.trim();
    const language = elements.codeLanguage.value;

    if (!pseudocode) {
      return setStatus("请先生成或输入伪代码。", true);
    }

    localStorage.setItem("mwgl_api_base", base);
    setStatus(`正在调用 DeepSeek 生成 ${language} 代码...`);

    try {
      const code = await pseudoToCode({ base, pseudocode, language });
      state.code = code;
      elements.codeText.value = code;
      setStatus(`已生成 ${language} 代码。`);
    } catch (error) {
      setStatus(`代码生成失败：${error.message}`, true);
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

    function getCanvasWorldPoint(event) {
      const user = getCanvasPoint(event);
      return {
        x: WORLD_WIDTH / 2 + user.x + NODE_LAYOUT_WIDTH / 2,
        y: WORLD_HEIGHT / 2 + user.y + NODE_LAYOUT_HEIGHT / 2
      };
    }

    function getNodeCenterById(id) {
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return null;
      return {
        x: WORLD_WIDTH / 2 + node.x + NODE_LAYOUT_WIDTH / 2,
        y: WORLD_HEIGHT / 2 + node.y + NODE_LAYOUT_HEIGHT / 2
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
        const wp = getCanvasWorldPoint(event);
        upsertPreviewPath(id, wp.x, wp.y);
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
        const wp = getCanvasWorldPoint(event);
        upsertPreviewPath(linking.fromId, wp.x, wp.y);
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
            const label = guessLabelForEdge(fromId);
            const edgeError = validateEdgeAtEditTime({
              from: fromId,
              to: toId,
              label,
              editingEdgeId: null
            });
            if (edgeError) {
              setStatus(edgeError, true);
              clearPreviewPath();
              linking = null;
              return;
            }
            const exists = (state.workflow.edges || []).some((e) => e.from === fromId && e.to === toId);
            if (!exists) {
              state.workflow.edges = state.workflow.edges || [];
              const edge = { id: uid("e"), from: fromId, to: toId, label };
              state.workflow.edges.push(edge);
              elements.edgeFrom.value = fromId;
              elements.edgeTo.value = toId;
              elements.edgeLabel.value = label;
              state.selectedEdgeId = edge.id;
              elements.edgeSelect.value = edge.id;
              render();
              setTimeout(() => focusEdgeLabelInput(), 0);
              setStatus("已通过拖线创建连线。");
            } else {
              setStatus("该连线已存在。", true);
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
        state.workflow = workflow;
        state.selectedNodeId = state.workflow.nodes[0]?.id || null;
        state.selectedEdgeId = null;
        state.pendingCenterViewport = true;
        render();
        const err = firstConstraintError(workflow);
        setStatus(err ? `已导入（草稿态，最终导出前请修复：${err}）` : "已从 MWGL 文本导入。");
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

    document.getElementById("btnPseudocode").addEventListener("click", callDeepSeekForPseudocode);

    document.getElementById("btnGenCode").addEventListener("click", callDeepSeekForCode);

    document.getElementById("btnExportJson").addEventListener("click", async () => {
      const err = firstConstraintError(state.workflow);
      if (err) return setStatus(`当前工作流未通过约束校验：${err}`, true);
      const text = JSON.stringify(state.workflow, null, 2);
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 JSON（并尝试复制到剪贴板）。");
    });

    document.getElementById("addEvent").addEventListener("click", () => addNode("start"));
    document.getElementById("addWaitUser").addEventListener("click", () => addNode("wait_user"));
    document.getElementById("addSwitch").addEventListener("click", () => addNode("switch"));
    document.getElementById("addLoopStart").addEventListener("click", () => addNode("loop_start"));
    document.getElementById("addLoopEnd").addEventListener("click", () => addNode("loop_end"));
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
