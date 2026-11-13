/**
 * LLM planners. Both speak the same protocol: system prompt + one user message describing the
 * alert and every step so far; the model replies with one JSON action. No vendor function-calling
 * format is used, so swapping providers changes nothing else.
 */
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";
import type { Planner, PlannerInput, PlannerReply } from "./types.js";

function parseJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("model reply was not JSON");
  }
}

export class GeminiPlanner implements Planner {
  name = "gemini";
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async next(input: PlannerInput): Promise<PlannerReply> {
    const prompt = userPrompt(input);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1200, responseMimeType: "application/json" },
        }),
      },
    );
    if (!res.ok) {
      // Never surface the provider's error body to users; it can echo request details.
      throw new Error(res.status === 429 ? "Gemini quota reached" : `Gemini request failed (${res.status})`);
    }
    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const completion = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      action: parseJson(completion),
      usage: {
        input: body.usageMetadata?.promptTokenCount ?? 0,
        output: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
      prompt,
      completion,
      model: this.model,
    };
  }
}

export class OllamaPlanner implements Planner {
  name = "ollama";
  constructor(
    private url: string,
    private model: string,
  ) {}

  async next(input: PlannerInput): Promise<PlannerReply> {
    const prompt = userPrompt(input);
    const res = await fetch(new URL("/api/chat", this.url), {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama request failed (${res.status})`);
    const body = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const completion = body.message?.content ?? "";
    return {
      action: parseJson(completion),
      usage: { input: body.prompt_eval_count ?? 0, output: body.eval_count ?? 0 },
      prompt,
      completion,
      model: this.model,
    };
  }
}
