/**
 * MWGL 生成鲁棒管线（借鉴 RobustFlow / AFlow 中的多样本 + 自洽择优 + 修复重试）
 * - 多样本：不同 temperature 并行调用，降低单样本随机失效
 * - 校验：复用前端同源 validateWorkflowConstraints + normalizeWorkflow
 * - 择优：多个通过校验时，可选 LLM 评审（类似 ScEnsemble，见 arXiv:2203.11171）
 * - 修复：均未通过时，用校验错误驱动 1～多轮修正
 */
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl-v2.js";
import { callDeepSeek } from "../routes/deepseek.js";

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function boolEnv(name, defaultTrue) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultTrue;
  return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
}

/** 与 temperature 样本数对应的温度曲线：首样本偏稳，后续略高以增加多样性 */
function temperaturesForCount(n) {
  const base = [0.2, 0.42, 0.62, 0.78, 0.55, 0.68];
  if (n <= base.length) return base.slice(0, n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(0.25 + (0.55 * i) / Math.max(1, n - 1));
  return out;
}

export function extractMwglJsonObject(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function ensemblePickBestValid(userPrompt, workflows, { maxChars = 12000 } = {}) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const chunks = workflows.map((w, i) => ({
    letter: letters[i],
    json: JSON.stringify(w)
  }));
  let body = `用户需求：\n${userPrompt}\n\n`;
  for (const { letter, json } of chunks) {
    let slice = json;
    if (slice.length > maxChars) slice = slice.slice(0, maxChars) + "\n…(截断)";
    body += `候选 ${letter}：\n${slice}\n\n`;
  }
  body +=
    "以上候选均已通过 MWGL 结构校验。请选出最贴合用户需求、分支语义最清晰的一个。\n" +
    "只输出一个大写字母（A、B、C…），不要其他任何字符。";

  const raw = await callDeepSeek([{ role: "user", content: body }], 0.1);
  const letter = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .charAt(0);
  const idx = letters.indexOf(letter);
  return idx >= 0 ? idx : 0;
}

function buildRepairUserMessage(userPrompt, lastRawContent, errors) {
  const errText = (errors || []).join("\n");
  const snippet = String(lastRawContent || "").slice(0, 12000);
  return (
    `【用户需求】\n${userPrompt}\n\n` +
    `【上一轮模型输出（可能含多余包裹，请忽略非 JSON 部分）】\n${snippet}\n\n` +
    `【校验失败原因（须全部消除）】\n${errText}\n\n` +
    `请输出修正后的完整 MWGL v2 JSON 对象（仅此一个 JSON，不要 markdown、不要解释）。`
  );
}

/**
 * @returns {{ content: string, robust?: object }}
 */
export async function generateMwglWithRobustFlow(userPrompt, systemPrompt) {
  const sampleCount = Math.max(1, intEnv("MWGL_ROBUST_SAMPLES", 3));
  const repairMax = Math.max(0, intEnv("MWGL_ROBUST_REPAIR_MAX", 2));
  const useEnsemble = boolEnv("MWGL_ROBUST_ENSEMBLE", true);
  const temps = temperaturesForCount(sampleCount);

  const meta = {
    samples: sampleCount,
    repairMax,
    ensemble: useEnsemble,
    stages: []
  };

  const messagesBase = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  const rawList = await Promise.all(
    temps.map((t) => callDeepSeek(messagesBase, t))
  );
  meta.stages.push({ phase: "multi_sample", temperatures: temps });

  function evaluateRaw(content) {
    let parsed = null;
    let parseError = null;
    try {
      parsed = extractMwglJsonObject(content);
    } catch (e) {
      parseError = e?.message || String(e);
    }
    const normalized = parsed ? normalizeWorkflow(parsed) : null;
    const validation = normalized
      ? validateWorkflowConstraints(normalized)
      : { ok: false, errors: [`JSON 解析失败：${parseError}`] };
    return { content, normalized, validation, parseError };
  }

  let candidates = rawList.map((content) => evaluateRaw(content));
  let valids = candidates
    .map((c, i) => ({ ...c, sampleIndex: i }))
    .filter((c) => c.validation.ok);

  if (valids.length === 1) {
    meta.stages.push({ phase: "select", reason: "single_valid" });
    return {
      content: JSON.stringify(valids[0].normalized),
      robust: meta
    };
  }

  if (valids.length > 1) {
    valids.sort((a, b) => a.sampleIndex - b.sampleIndex);
    let chosen = valids[0];
    if (useEnsemble) {
      try {
        const pick = await ensemblePickBestValid(
          userPrompt,
          valids.map((v) => v.normalized)
        );
        chosen = valids[pick] ?? valids[0];
        meta.stages.push({ phase: "ensemble_pick", pickedIndex: pick });
      } catch {
        meta.stages.push({ phase: "ensemble_pick_failed", pickedIndex: 0 });
      }
    } else {
      meta.stages.push({ phase: "select", reason: "first_valid_by_sample_order" });
    }
    return {
      content: JSON.stringify(chosen.normalized),
      robust: meta
    };
  }

  // 无通过样本：选错误最少；并列取首条
  candidates = candidates.map((c, i) => ({ ...c, sampleIndex: i }));
  candidates.sort(
    (a, b) =>
      a.validation.errors.length - b.validation.errors.length ||
      a.sampleIndex - b.sampleIndex
  );
  let best = candidates[0];
  meta.stages.push({
    phase: "repair_prep",
    errorCount: best.validation.errors.length,
    errors: best.validation.errors
  });

  let lastContent = best.content;
  for (let r = 0; r < repairMax; r++) {
    const repairUser = buildRepairUserMessage(
      userPrompt,
      lastContent,
      best.validation.errors
    );
    lastContent = await callDeepSeek(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: repairUser }
      ],
      0.15
    );
    const ev = evaluateRaw(lastContent);
    meta.stages.push({ phase: "repair_attempt", index: r + 1, ok: ev.validation.ok });
    if (ev.validation.ok) {
      return { content: JSON.stringify(ev.normalized), robust: meta };
    }
    best = ev;
  }

  meta.stages.push({ phase: "give_up", note: "return_last_model_output" });
  return { content: lastContent, robust: meta };
}
