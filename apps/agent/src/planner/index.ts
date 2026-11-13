import type { Config } from "../config.js";
import { GeminiPlanner, OllamaPlanner } from "./llm.js";
import { PlaybookPlanner } from "./playbook.js";
import type { Planner } from "./types.js";

export function createPlanner(cfg: Config): Planner {
  switch (cfg.provider) {
    case "gemini":
      if (!cfg.gemini.apiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY");
      return new GeminiPlanner(cfg.gemini.apiKey, cfg.gemini.model);
    case "ollama":
      return new OllamaPlanner(cfg.ollama.url, cfg.ollama.model);
    default:
      return new PlaybookPlanner();
  }
}

export * from "./types.js";
export { PlaybookPlanner } from "./playbook.js";
