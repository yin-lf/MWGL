import { bindInteractions } from "./interactions.js";
import { layoutWorkflowLeftToRight } from "./mwgl.js";
import { createRenderer } from "./renderer.js";
import { state } from "./state.js";

const elements = {
  apiBase: document.getElementById("apiBase"),
  btnUndoWorkflow: document.getElementById("btnUndoWorkflow"),
  btnRedoWorkflow: document.getElementById("btnRedoWorkflow"),
  historyHint: document.getElementById("historyHint"),
  userPrompt: document.getElementById("userPrompt"),
  status: document.getElementById("status"),
  canvas: document.getElementById("canvas"),
  canvasViewport: document.getElementById("canvasViewport"),
  canvasWorld: document.getElementById("canvasWorld"),
  jsonView: document.getElementById("jsonView"),
  mwglText: document.getElementById("mwglText"),
  nodeType: document.getElementById("nodeType"),
  nodeOutcome: document.getElementById("nodeOutcome"),
  endOutcomeRow: document.getElementById("endOutcomeRow"),
  nodeText: document.getElementById("nodeText"),
  nodeX: document.getElementById("nodeX"),
  nodeY: document.getElementById("nodeY"),
  edgeFrom: document.getElementById("edgeFrom"),
  edgeTo: document.getElementById("edgeTo"),
  edgeLabel: document.getElementById("edgeLabel"),
  edgeSelect: document.getElementById("edgeSelect"),
  pseudocodeText: document.getElementById("pseudocodeText"),
  codeText: document.getElementById("codeText"),
  runResultText: document.getElementById("runResultText"),
  codeLanguage: document.getElementById("codeLanguage"),
  constraintPanel: document.getElementById("constraintPanel"),
  constraintList: document.getElementById("constraintList"),
  loopPanel: document.getElementById("loopPanel"),
  loopPanelTitle: document.getElementById("loopPanelTitle"),
  loopPanelBreadcrumb: document.getElementById("loopPanelBreadcrumb"),
  loopPanelClose: document.getElementById("loopPanelClose"),
  loopKind: document.getElementById("loopKind"),
  loopCondition: document.getElementById("loopCondition"),
  loopSaveMeta: document.getElementById("loopSaveMeta"),
  loopLoopStepList: document.getElementById("loopLoopStepList"),
  loopAddStep: document.getElementById("loopAddStep"),
  loopAddFor: document.getElementById("loopAddFor"),
  loopAddSubflow: document.getElementById("loopAddSubflow")
};

// ===================== 多窗口适配核心代码 =====================
window.canvasData = { nodes: [], edges: [] };
window.workflowHistory = { past: [], future: [] };
window.currentMwglText = "";
let rendererInstance = null;

// 加载会话画布数据
window.loadCanvasData = function (data) {
  if (!data || !data.nodes || !data.edges || !rendererInstance) return;
  try {
    state.workflow.nodes = [...data.nodes];
    state.workflow.edges = [...data.edges];
    rendererInstance.render();
    syncCanvasToGlobal();
  } catch (e) {
    console.warn("加载画布数据异常", e);
  }
};

// 加载历史记录
window.loadWorkflowHistory = function (history) {
  if (!history) return;
  window.workflowHistory = JSON.parse(JSON.stringify(history));
  updateHistoryUI();
};

// 同步画布数据到全局
function syncCanvasToGlobal() {
  window.canvasData = {
    nodes: JSON.parse(JSON.stringify(state.workflow.nodes)),
    edges: JSON.parse(JSON.stringify(state.workflow.edges))
  };
}

// 更新历史记录UI
function updateHistoryUI() {
  const hintEl = elements.historyHint;
  if (!hintEl) return;
  const past = window.workflowHistory.past.length;
  const future = window.workflowHistory.future.length;
  hintEl.textContent = `${past} / ${future}`;
}

// ===================== 原启动逻辑 =====================
function bootstrap() {
  rendererInstance = createRenderer(elements);
  const savedBase = localStorage.getItem("mwgl_api_base");
  if (savedBase) elements.apiBase.value = savedBase;

  // 绑定交互
  bindInteractions(elements, rendererInstance);
  layoutWorkflowLeftToRight(state.workflow);
  state.pendingCenterViewport = true;
  rendererInstance.render();
  rendererInstance.setStatus("就绪：可输入需求后直接生成。");

  // 初始化全局数据
  syncCanvasToGlobal();
}

bootstrap();