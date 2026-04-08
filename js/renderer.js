import { state } from "./state.js";
import { workflowToMwgl } from "./mwgl.js";
import {
  NODE_LAYOUT_HEIGHT,
  NODE_LAYOUT_WIDTH,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  formatWorldTransform,
  offsetToCenterBBox,
  workflowBBox
} from "./viewport.js";

export function createRenderer(elements) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const INNER_WIDTH = WORLD_WIDTH;
  const INNER_HEIGHT = WORLD_HEIGHT;
  const NODE_WIDTH = NODE_LAYOUT_WIDTH;
  const NODE_HEIGHT = NODE_LAYOUT_HEIGHT;

  const worldEl = elements.canvasWorld;

  function viewportSize() {
    const vp = elements.canvasViewport || elements.canvas;
    const w = vp?.clientWidth ?? 0;
    const h = vp?.clientHeight ?? 0;
    if (w > 0 && h > 0) return { w, h };
    const rect = vp?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    const c = elements.canvas;
    return {
      w: c?.clientWidth || c?.getBoundingClientRect?.().width || 0,
      h: c?.clientHeight || c?.getBoundingClientRect?.().height || 0
    };
  }

  function ensureEdgeLayer() {
    let edgeLayer = worldEl.querySelector(".edge-layer");
    if (edgeLayer) return edgeLayer;
    edgeLayer = document.createElementNS(SVG_NS, "svg");
    edgeLayer.setAttribute("class", "edge-layer");
    edgeLayer.setAttribute("viewBox", `0 0 ${INNER_WIDTH} ${INNER_HEIGHT}`);

    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "arrow-head");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", "#64748b");
    marker.appendChild(path);
    defs.appendChild(marker);
    edgeLayer.appendChild(defs);
    worldEl.appendChild(edgeLayer);
    return edgeLayer;
  }

  /** 用户坐标 (node.x,y) 原点在世界中心 → 世界像素 */
  function nodeCenter(node) {
    return {
      x: WORLD_WIDTH / 2 + node.x + NODE_WIDTH / 2,
      y: WORLD_HEIGHT / 2 + node.y + NODE_HEIGHT / 2
    };
  }

  function applyViewportTransform() {
    worldEl.style.transform = formatWorldTransform(state.canvasOffset, state.canvasScale);
  }

  /** @returns {boolean} 是否已根据有效视口写入偏移 */
  function centerWorkflow() {
    const nodes = state.workflow?.nodes || [];
    if (!nodes.length) {
      state.canvasOffset = { x: 0, y: 0 };
      return false;
    }
    const bbox = workflowBBox(nodes, NODE_WIDTH, NODE_HEIGHT);
    const s = Number.isFinite(state.canvasScale) ? state.canvasScale : 1;
    const { w: vpW, h: vpH } = viewportSize();
    if (vpW <= 0 || vpH <= 0) return false;
    const off = offsetToCenterBBox(bbox, vpW, vpH, s);
    if (!off) return false;
    state.canvasOffset = off;
    return true;
  }

  function tryApplyPendingCenter() {
    if (!state.pendingCenterViewport) return;
    const nodes = state.workflow?.nodes || [];
    if (!nodes.length) {
      state.pendingCenterViewport = false;
      return;
    }
    if (centerWorkflow()) {
      applyViewportTransform();
      state.pendingCenterViewport = false;
    }
  }

  function drawEdges(nodes, edges) {
    const edgeLayer = ensureEdgeLayer();
    const defs = edgeLayer.querySelector("defs");
    edgeLayer.innerHTML = "";
    if (defs) edgeLayer.appendChild(defs);
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    edges.forEach((edge) => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return;
      const start = nodeCenter(from);
      const end = nodeCenter(to);
      const midX = Math.round((start.x + end.x) / 2);
      const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;

      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "edge-hit");
      hit.dataset.edgeId = edge.id;
      edgeLayer.appendChild(hit);

      const line = document.createElementNS(SVG_NS, "path");
      line.setAttribute("d", d);
      line.setAttribute("class", `edge-line${state.selectedEdgeId === edge.id ? " selected" : ""}`);
      line.setAttribute("marker-end", "url(#arrow-head)");
      line.dataset.edgeId = edge.id;
      edgeLayer.appendChild(line);
    });
  }

  function drawEdgeLabelOverlays(nodes, edges) {
    let layer = worldEl.querySelector(".edge-label-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "edge-label-layer";
      worldEl.appendChild(layer);
    }
    layer.innerHTML = "";
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    edges.forEach((edge) => {
      const lab = String(edge.label || "").trim();
      if (!lab) return;
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return;
      const start = nodeCenter(from);
      const end = nodeCenter(to);
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const div = document.createElement("div");
      div.className = "edge-label-overlay";
      div.textContent = lab;
      div.style.left = `${Math.round(midX)}px`;
      div.style.top = `${Math.round(midY)}px`;
      layer.appendChild(div);
    });
  }

  function syncEdgeEditor() {
    const nodes = state.workflow.nodes || [];
    const edges = state.workflow.edges || [];
    const currentFrom = elements.edgeFrom.value;
    const currentTo = elements.edgeTo.value;
    const currentEdge = state.selectedEdgeId || elements.edgeSelect.value;
    const nodeOptions = nodes
      .map((n) => `<option value="${n.id}">${n.id} · ${n.type} · ${n.text.slice(0, 24)}</option>`)
      .join("");
    elements.edgeFrom.innerHTML = nodeOptions;
    elements.edgeTo.innerHTML = nodeOptions;

    const edgeOptions = [
      `<option value="">新建连线</option>`,
      ...edges.map((e) => `<option value="${e.id}">${e.id}: ${e.from} -> ${e.to} ${e.label ? `[${e.label}]` : ""}</option>`)
    ].join("");
    elements.edgeSelect.innerHTML = edgeOptions;
    if (nodes.some((n) => n.id === currentFrom)) elements.edgeFrom.value = currentFrom;
    if (nodes.some((n) => n.id === currentTo)) elements.edgeTo.value = currentTo;
    if (edges.some((e) => e.id === currentEdge)) {
      elements.edgeSelect.value = currentEdge;
      state.selectedEdgeId = currentEdge;
    } else {
      state.selectedEdgeId = null;
    }
  }

  function setStatus(text, isError = false) {
    elements.status.textContent = text || "";
    elements.status.style.color = isError ? "#b91c1c" : "#1d4ed8";
  }

  function getSelectedNode() {
    return state.workflow.nodes.find((n) => n.id === state.selectedNodeId) || null;
  }

  function syncEditor() {
    const node = getSelectedNode();
    if (!node) {
      elements.nodeType.value = "start";
      elements.nodeText.value = "";
      elements.nodeX.value = "";
      elements.nodeY.value = "";
      return;
    }
    elements.nodeType.value = node.type;
    elements.nodeText.value = node.text;
    elements.nodeX.value = String(node.x);
    elements.nodeY.value = String(node.y);
  }

  function render() {
    if (!worldEl) {
      console.error("MWGL: #canvasWorld 未找到，无法渲染画布。");
      return;
    }
    const wf = state.workflow;
    worldEl.innerHTML = "";
    ensureEdgeLayer();
    wf.nodes.forEach((node) => {
      const div = document.createElement("div");
      const loopInCase =
        node.type === "case" && String(node.text || "").trimStart().startsWith("【循环】");
      div.className = `node ${node.type}${loopInCase ? " case-loop" : ""}${
        state.selectedNodeId === node.id ? " selected" : ""
      }`;
      div.style.left = `${WORLD_WIDTH / 2 + node.x}px`;
      div.style.top = `${WORLD_HEIGHT / 2 + node.y}px`;
      div.dataset.id = node.id;
      div.innerHTML = `<div class="type">${node.type}</div><div class="text">${node.text}</div>`;
      worldEl.appendChild(div);
    });
    drawEdges(wf.nodes, wf.edges || []);
    drawEdgeLabelOverlays(wf.nodes, wf.edges || []);

    elements.jsonView.textContent = JSON.stringify(
      { ...wf, mwgl_version: wf.mwgl_version ?? 2 },
      null,
      2
    );
    elements.mwglText.value = workflowToMwgl(wf);

    if (!state.selectedNodeId && wf.nodes.length) {
      state.selectedNodeId = wf.nodes[0].id;
    }
    syncEditor();
    syncEdgeEditor();

    if (state.pendingCenterViewport) {
      tryApplyPendingCenter();
      if (state.pendingCenterViewport) {
        requestAnimationFrame(() => {
          tryApplyPendingCenter();
          requestAnimationFrame(() => {
            tryApplyPendingCenter();
            if (state.pendingCenterViewport) {
              setTimeout(() => tryApplyPendingCenter(), 0);
              setTimeout(() => tryApplyPendingCenter(), 50);
            }
          });
        });
      }
    }
    applyViewportTransform();
  }

  let lastCanvasSize = { w: 0, h: 0 };
  const resizeObserver = new ResizeObserver(() => {
    const w = elements.canvas.clientWidth;
    const h = elements.canvas.clientHeight;
    if (w <= 0 || h <= 0) {
      lastCanvasSize = { w: 0, h: 0 };
      return;
    }
    const wasInvalid = lastCanvasSize.w <= 0 || lastCanvasSize.h <= 0;
    lastCanvasSize = { w, h };
    if (wasInvalid) tryApplyPendingCenter();
  });
  resizeObserver.observe(elements.canvasViewport || elements.canvas);

  return {
    setStatus,
    getSelectedNode,
    syncEditor,
    syncEdgeEditor,
    centerWorkflow,
    tryApplyPendingCenter,
    applyViewportTransform,
    render
  };
}
