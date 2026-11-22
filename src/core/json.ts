export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: SyntaxError };

export function tryParseJson(raw: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    if (err instanceof SyntaxError) return { ok: false, error: err };
    throw err;
  }
}
