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
      { id: "n2", type: "trigger", text: "触发条件 已认证", x: 400, y: 180 },
      { id: "n3", type: "switch", text: "条件 配额充足", x: 680, y: 180 },
      { id: "n4", type: "case", text: "处理请求", x: 960, y: 120 },
      { id: "n5", type: "case", text: "拒绝请求", x: 960, y: 260 },
      { id: "n6", type: "success", text: "成功 已处理", x: 1240, y: 120 },
      { id: "n7", type: "failure", text: "失败 拒绝", x: 1240, y: 260 }
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "" },
      { id: "e2", from: "n2", to: "n3", label: "" },
      { id: "e3", from: "n3", to: "n4", label: "是" },
      { id: "e4", from: "n3", to: "n5", label: "否" },
      { id: "e5", from: "n4", to: "n6", label: "" },
      { id: "e6", from: "n5", to: "n7", label: "" }
    ]
  },
  selectedNodeId: null,
  selectedEdgeId: null,
  drag: null,
  canvasOffset: { x: 0, y: 0 },
  canvasScale: 1,
  pendingCenterViewport: true
};
