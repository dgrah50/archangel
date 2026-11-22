import { z } from "zod";
import { tryParseJson } from "./json.js";
import { scanForSecrets } from "./secrets.js";

/**
 * What fed a revise or LLM-rebase Attempt, kept so the model-tier benchmark can replay it. Structured and bounded on purpose:
 * review findings (file, severity, short text), Gate violation lines, and the conflicting base sha. Never a log, a transcript
 * or test output. If anything in it looks like a secret the whole input is dropped (that Attempt is then simply not replayable).
 */
const MAX_FINDINGS_PER_VENDOR = 20;
const MAX_VIOLATIONS = 10;
const TEXT_MAX = 400;

const Finding = z.object({
  file: z.string().max(300),
  line: z.number().int().optional(),
  severity: z.enum(["blocker", "major", "minor"]),
  summary: z.string().max(TEXT_MAX),
  suggestion: z.string().max(TEXT_MAX).optional(),
});
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const AttemptInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("revise"),
    findings: z.array(z.object({ vendor: z.string().max(40), findings: z.array(Finding).max(MAX_FINDINGS_PER_VENDOR) })).max(6),
    gateViolations: z.array(z.string().max(300)).max(MAX_VIOLATIONS),
  }),
  z.object({ kind: z.literal("rebase"), conflictBase: Sha }),
]);
export type AttemptInput = z.infer<typeof AttemptInputSchema>;

const cut = (s: string, n: number) => s.slice(0, n);

/** The JSON to store for an Attempt, or null when it has no replayable input or the input looks like it holds a secret. */
export function captureAttemptInput(
  kind: "implement" | "revise" | "rebase",
  src: { mainSha: string; gateViolations: string[]; structuredFindings: Array<{ vendor: string; findings: Array<{ file: string; line?: number; severity: "blocker" | "major" | "minor"; summary: string; suggestion?: string }> }> },
): string | null {
  if (kind === "implement") return null;
  const input: AttemptInput =
    kind === "rebase"
      ? { kind, conflictBase: src.mainSha }
      : {
          kind,
          findings: src.structuredFindings.slice(0, 6).map((v) => ({
            vendor: cut(v.vendor, 40),
            findings: v.findings.slice(0, MAX_FINDINGS_PER_VENDOR).map((f) => ({
              file: cut(f.file, 300),
              ...(f.line === undefined ? {} : { line: f.line }),
              severity: f.severity,
              summary: cut(f.summary, TEXT_MAX),
              ...(f.suggestion === undefined ? {} : { suggestion: cut(f.suggestion, TEXT_MAX) }),
            })),
          })),
          gateViolations: src.gateViolations.slice(0, MAX_VIOLATIONS).map((v) => cut(v, 300)),
        };
  const parsed = AttemptInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const json = JSON.stringify(parsed.data);
  return scanForSecrets(json) === null ? json : null;
}

/** A stored input back into its type; anything that does not validate is not replayable. */
export function parseAttemptInput(json: string): AttemptInput | null {
  const raw = tryParseJson(json);
  if (!raw.ok) return null;
  const parsed = AttemptInputSchema.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
}
