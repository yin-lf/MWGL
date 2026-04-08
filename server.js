import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT || 3001);
const deepseekKey = process.env.DEEPSEEK_API_KEY || "";
const deepseekBase = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com/v1").replace(/\/$/, "");
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(deepseekKey), deepseekBase });
});

app.post("/api/mwgl/generate", async (req, res) => {
  try {
    if (!deepseekKey) {
      return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY in server env." });
    }

    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const body = {
      model: "deepseek-chat",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "你是 MWGL v2 严格编译器。把用户需求转换成可通过 MWGL v2 校验的 JSON。只输出 JSON 对象本身，不要 markdown、不要代码块、不要解释。\n" +
            "输出结构必须是：{mwgl_version:2,rule_id:string,rule_name:string,nodes:[...],edges:[...]}；edges 必须显式输出，不允许省略。\n" +
            "nodes 每项必须包含：id,type,text,x,y。edges 每项必须包含：id,from,to,label（label 可为空字符串，但 switch/loop 出边除外）。\n" +
            "节点 type 只能是：start,wait_user,trigger,switch,loop,parallel,case,success,failure。\n" +
            "硬性约束（必须全部满足）：\n" +
            "1) 必须且仅有 1 个 start。\n" +
            "2) start 至少 1 条出边。\n" +
            "3) success/failure 不能有任何出边。\n" +
            "4) 禁止自环（from===to），全图必须 DAG（不能有有向环）。\n" +
            "5) 边的 from/to 必须引用存在的节点 id。\n" +
            "6) switch 每个节点至少 1 条出边；loop/parallel 每个节点至少 2 条出边。\n" +
            "7) switch/loop 的每条出边 label 必须非空；同一节点下 label 不可重复。\n" +
            "8) loop 的出边 label 必须同时包含「继续」与「退出」。\n" +
            "9) start 不能被 switch/case/loop/trigger 指向，且禁止 start->start。\n" +
            "10) 所有非 start 节点必须从 start 可达。\n" +
            "11) 至少存在 1 个从 start 可达的终态（success 或 failure）。\n" +
            "建模偏好：\n" +
            "- 有明确条件判断时使用 switch；可单分支（仅 if）或多分支。多分支时确保每条分支 label 唯一且语义明确。\n" +
            "- 有迭代语义时优先使用 loop，并显式给出「继续」「退出」两条分支；严禁用回边表达循环。\n" +
            "- 有并行语义时使用 parallel，至少给出 2 条并行分支，再在后续节点汇聚。\n" +
            "- trigger 常用于 start/wait_user 与 switch 之间（如 start->trigger->switch）。\n" +
            "- case 文本可用中文短句；如需文本表达内部循环，可用「【循环】」前缀，但图结构仍需保持 DAG。\n" +
            "输出前请在内部自检并修正，直到满足全部硬性约束再输出最终 JSON。"
        },
        { role: "user", content: prompt }
      ]
    };

    const upstream = await fetch(`${deepseekBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deepseekKey}`
      },
      body: JSON.stringify(body)
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: text.slice(0, 600) });
    }

    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content || "";
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: error.message || "server error" });
  }
});

app.listen(port, () => {
  console.log(`MWGL v2 server listening on http://localhost:${port}`);
});
