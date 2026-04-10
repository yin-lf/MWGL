import { normalizeWorkflow } from "./mwgl.js";

export async function buildWorkflowByDeepSeek({ base, prompt }) {
  const res = await fetch(`${base}/api/mwgl/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  const content = data?.content || "";
  const cleaned = content
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  return normalizeWorkflow(parsed);
}

export async function dagToPseudocode({ base, workflow }) {
  const res = await fetch(`${base}/api/mwgl/pseudocode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ workflow })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  return data?.content || "";
}

export async function pseudoToCode({ base, pseudocode, language }) {
  const res = await fetch(`${base}/api/mwgl/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ pseudocode, language })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }

  const data = await res.json();
  return data?.content || "";
}
