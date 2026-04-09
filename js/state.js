import { NODE_TYPES } from "./mwgl-v2.js";

export { NODE_TYPES };
export { uid } from "./ids.js";

export const state = {
  workflow: {
    mwgl_version: 2,
    rule_id: "R_INIT_001",
    rule_name: "MWGL v2 示例",
    nodes: [
      { id: "n1", type: "start", text: "开始 请求到达", x: 120, y: 180 },
      { id: "n2", type: "loop_start", text: "循环开始 仍有待处理任务", x: 400, y: 180 },
      { id: "n3", type: "case", text: "处理一批任务", x: 680, y: 120 },
      { id: "n4", type: "loop_end", text: "循环结束 本轮处理完成", x: 960, y: 120 },
      { id: "n5", type: "case", text: "收尾与归档", x: 680, y: 260 },
      { id: "n6", type: "success", text: "成功 已处理", x: 960, y: 260 }
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "" },
      { id: "e2", from: "n2", to: "n3", label: "" },
      { id: "e3", from: "n3", to: "n4", label: "" },
      { id: "e4", from: "n4", to: "n5", label: "退出循环" },
      { id: "e5", from: "n5", to: "n6", label: "" }
    ]
  },
  selectedNodeId: null,
  selectedEdgeId: null,
  drag: null,
  canvasOffset: { x: 0, y: 0 },
  canvasScale: 1,
  pendingCenterViewport: true
};
