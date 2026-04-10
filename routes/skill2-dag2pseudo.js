import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();

const SYSTEM_PROMPT =
  "你是 MWGL v2 伪代码生成器。将工作流 JSON 转为结构化伪代码。只输出伪代码，不要 markdown/代码块/解释。\n\n" +
  "格式：缩进 2 空格，用关键字 BEGIN WORKFLOW / END WORKFLOW、STEP、IF / ELSE IF / ELSE、WHILE / END WHILE、PARALLEL / END PARALLEL（内含 BRANCH）、WAIT、SUCCESS、FAILURE。\n\n" +
  "映射：start→STEP, wait_user→WAIT, case→STEP, success→SUCCESS, failure→FAILURE。\n" +
  "switch→IF/ELSE IF/ELSE，出边 label 直接作为条件。loop_start/loop_end→WHILE/END WHILE，中间节点为循环体。parallel→PARALLEL，每条出边一个 BRANCH。\n\n" +
  "边：顺序连接；非 switch 的非空 label 以注释体现。从 start 按拓扑顺序展开。不可达节点末尾注释列出。";
router.post("/api/mwgl/pseudocode", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const workflow = req.body?.workflow;
    if (!workflow || !workflow.nodes) {
      return res.status(400).json({ error: "workflow with nodes is required" });
    }

    const content = await callDeepSeek([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(workflow, null, 2) }
    ]);

    res.json({ content });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || "server error" });
  }
});

export default router;
