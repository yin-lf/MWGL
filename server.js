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
            "nodes 每项必须包含：id,type,text,x,y。edges 每项必须包含：id,from,to,label（switch 出边 label 不可为空；其他可为空字符串）。\n" +
            "语义规范（非常重要）：边表达顺序连接，且在分支/触发场景中由边 label 承载条件语义。\n" +
            "节点 type 只能是：start,wait_user,switch,loop_start,loop_end,parallel,case,success,failure。\n" +
            "硬性约束（必须全部满足）：\n" +
            "1) 必须且仅有 1 个 start。\n" +
            "2) start 至少 1 条出边。\n" +
            "3) success/failure 不能有任何出边。\n" +
            "4) 禁止自环（from===to），全图必须 DAG（不能有有向环）。\n" +
            "5) 边的 from/to 必须引用存在的节点 id。\n" +
            "6) switch 每个节点至少 1 条出边；loop_start 必须且仅能有 1 条出边（进入循环体）；parallel 至少 2 条出边；loop_end 至少 1 条出边。\n" +
            "7) switch 的每条出边 label 必须非空；同一 switch 下 label 不可重复。\n" +
            "7.1) switch 的每条出边 label 必须是可判定条件（业务语义），明确说明何时触发该分支；禁止使用纯数字或“分支N”等占位标签。\n" +
            "8) loop_start/loop_end 必须完整成对：每个 loop_start 必须存在至少一个可达的 loop_end，且每个 loop_end 必须由至少一个 loop_start 可达。\n" +
            "9) start 不能被 switch/case/loop_start/loop_end/parallel 指向，且禁止 start->start。\n" +
            "10) 允许存在从 start 不可达的节点（作为设计中的草稿节点，不参与执行）。\n" +
            "11) 至少存在 1 个从 start 可达的终态（success 或 failure）。\n" +
            "建模偏好：\n" +
            "- 有明确条件判断时使用 switch；可单分支（仅 if）或多分支。每条出边 label 都要写成可判定条件（业务语义），能直接映射为 if/else if 判断。\n" +
            "- 有迭代语义时使用 loop_start/loop_end：loop_start 仅连接循环体入口，循环体可复杂并在 loop_end 收束，退出路径统一从 loop_end 后续节点表达；严禁用回边表达循环。\n" +
            "- 当需求可被 loop_start/loop_end 自然表达为循环时，不要使用 switch 模拟循环；switch 仅用于条件分流，不用于迭代控制。\n" +
            "- 有并行语义时使用 parallel，至少给出 2 条并行分支，再在后续节点汇聚。\n" +
            "- 可把触发条件写在前序边 label（例如 start->switch 的 label 为“已认证且金额>1000”）。\n" +
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
