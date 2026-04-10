import { Router } from "express";
import { hasKey, callDeepSeek } from "./deepseek.js";

const router = Router();

const SYSTEM_PROMPT =
  "你是代码生成器。接收结构化伪代码（由 MWGL v2 伪代码生成器产生），生成可执行的真实代码。\n" +
  "只输出代码文本本身，不要 markdown、不要代码块标记（```）、不要解释。\n\n" +
  "伪代码结构关键字映射规则：\n" +
  "- BEGIN WORKFLOW / END WORKFLOW → 整体函数或主程序入口\n" +
  "- STEP → 语句或赋值操作\n" +
  "- IF / ELSE IF / ELSE → if / elif / else（或对应语言的条件语句）\n" +
  "- WHILE / END WHILE → while 循环\n" +
  "- PARALLEL / END PARALLEL → 多线程/异步并发（用目标语言的惯用并发模式）\n" +
  "- BRANCH → 并行分支中的单个分支体\n" +
  "- WAIT → 等待用户输入（input / scanf / readline 等）\n" +
  "- SUCCESS → return 成功结果或正常退出\n" +
  "- FAILURE → return 错误结果、抛异常或错误退出\n\n" +
  "代码生成要求：\n" +
  "1. 生成完整可执行的函数，包含必要的 import / include / using。\n" +
  "2. 保留伪代码中的业务语义：变量名、条件表达式、字符串内容尽量原样保留或合理转换为目标语言命名风格。\n" +
  "3. 函数签名需包含有意义的参数名和类型（如果语言支持）。\n" +
  "4. 添加必要的错误处理（基于 FAILURE 节点语义）。\n" +
  "5. 在关键步骤添加简短中文注释（对应伪代码中的 STEP 描述）。\n" +
  "6. 如果用户指定了目标语言，使用该语言；否则默认使用 Python。";

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
