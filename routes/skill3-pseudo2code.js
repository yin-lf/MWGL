import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();

const SYSTEM_PROMPT =
  "你是代码生成器。将结构化伪代码转为可执行的真实代码。只输出代码，不要 markdown/代码块标记/解释。\n\n" +
  "关键字映射：BEGIN/END WORKFLOW→函数入口，STEP→语句，IF/ELSE IF/ELSE→条件，WHILE/END WHILE→循环，PARALLEL/END PARALLEL→并发（BRANCH→分支体），WAIT→用户输入，SUCCESS→正常返回，FAILURE→错误返回。\n\n" +
  "要求：完整可执行含 import，保留变量名定义，只输出可直接复制运行的可执行代码，关键步骤加中文注释。默认 Python，用户指定则用对应语言。";

router.post("/api/mwgl/code", async (req, res) => {
  try {
    if (!hasKey()) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const pseudocode = String(req.body?.pseudocode || "").trim();
    if (!pseudocode) {
      return res.status(400).json({ error: "pseudocode is required" });
    }

    const language = String(req.body?.language || "Python").trim();
    const userMessage = `目标语言：${language}\n\n${pseudocode}`;

    const content = await callDeepSeek([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
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
