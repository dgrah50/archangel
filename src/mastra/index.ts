import path from "node:path";
import { createArchangelMastra } from "../agents/reviewers.js";

const mastraDbPath = path.resolve(process.env.ARCHANGEL_MASTRA_DB ?? ".archangel/mastra.db");

// Read-only Mastra Studio entry point (ADR-0001): points strictly at mastra.db with
// non-calling placeholder keys when secrets are scrubbed from Studio's environment.
const { mastra } = createArchangelMastra({
  openaiApiKey: process.env.OPENAI_API_KEY ?? "studio-readonly-no-key",
  googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "studio-readonly-no-key",
  openaiModel: process.env.ARCHANGEL_OPENAI_MODEL ?? "gpt-5.4",
  geminiModel: process.env.ARCHANGEL_GEMINI_MODEL ?? "gemini-2.5-pro",
  mastraDbPath,
});

export { mastra };
