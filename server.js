import "dotenv/config";
import express from "express";
import cors from "cors";
import { hasKey, getBase } from "./routes/deepseek.js";
import skill1 from "./routes/skill1-nl2dag.js";
import skill2 from "./routes/skill2-dag2pseudo.js";
import skill3 from "./routes/skill3-pseudo2code.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: hasKey(), deepseekBase: getBase() });
});

app.use(skill1);
app.use(skill2);
app.use(skill3);

app.listen(port, () => {
  console.log(`MWGL v2 server listening on http://192.168.1.151:${port}`);
});
