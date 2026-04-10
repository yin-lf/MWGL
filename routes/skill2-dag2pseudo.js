import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();

const SYSTEM_PROMPT =
  "你是 MWGL v2 伪代码生成器。用户会提供一个 MWGL v2 工作流 JSON，你需要把它转换为结构化、专业的伪代码描述，以便下游代码生成使用。只输出伪代码文本本身，不要 markdown、不要代码块、不要解释。\n" +
  "输出格式要求：\n" +
  "- 使用缩进表示层级关系，每级缩进 2 个空格。\n" +
  "- 使用结构化关键字：BEGIN WORKFLOW / END WORKFLOW、STEP、IF / ELSE IF / ELSE、WHILE / END WHILE、PARALLEL / END PARALLEL、WAIT、SUCCESS、FAILURE。\n" +
  "- 每个步骤写明节点语义（从节点 text 字段提取），如果步骤间有边标签承载条件语义，应在对应位置体现。\n\n" +
  "节点类型到伪代码的映射规则：\n" +
  "1. start → 用 STEP 描述入口动作，语义从 text 字段提取。\n" +
  "2. wait_user → 用 WAIT 描述等待用户交互，语义从 text 字段提取。\n" +
  "3. switch → 用 IF / ELSE IF / ELSE 表示条件分支。switch 的每条出边 label 是分支条件（直接写在 IF/ELSE IF 后面）。每个分支下描述该分支的目标节点动作。\n" +
  "4. loop_start / loop_end → 用 WHILE ... END WHILE 表示循环。loop_start 的 text 描述循环条件或入口语义；loop_end 的 text 描述本轮结束的收束逻辑。两者之间的节点构成循环体。\n" +
  "5. parallel → 用 PARALLEL ... END PARALLEL 表示并行，每条出边为一个并行分支，用 BRANCH 标记。\n" +
  "6. case → 用 STEP 描述具体动作，语义从 text 字段提取。\n" +
  "7. success → 用 SUCCESS 表示成功终态。\n" +
  "8. failure → 用 FAILURE 表示失败终态。\n\n" +
  "边的语义：\n" +
  "- 边表达顺序连接。如果边的 label 非空且不是 switch 出边，则在伪代码中以注释形式体现该边承载的触发/转移语义。\n" +
  "- switch 出边的 label 直接映射为 IF/ELSE IF 的条件表达式。\n\n" +
  "注意事项：\n" +
  "- 伪代码应从 start 出发，按拓扑顺序（边的连接关系）逐步展开。\n" +
  "- 如果存在从 start 不可达的节点，在末尾以注释形式列出（// 草稿节点: ...）。\n" +
  "- 保持伪代码简洁、可读、可直接用于下游代码生成。";

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
