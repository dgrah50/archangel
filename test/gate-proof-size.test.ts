import { expect, test } from "bun:test";

test("fitProofMessage finishes within the annotation byte limit when JUnit IDs are oversized", () => {
  const script = `
    import { fitProofMessage, PROOF_MESSAGE_MAX_BYTES } from "./src/gate/gate.ts";
    const message = fitProofMessage("a".repeat(40), {
      head_output: "x",
      junit: {
        base_failed: Array(20).fill("b".repeat(160)),
        head_passed: Array(20).fill("c".repeat(160)),
      },
    });
    console.log(Buffer.byteLength(message), PROOF_MESSAGE_MAX_BYTES);
  `;
  const result = Bun.spawnSync(["bun", "-e", script], { timeout: 10_000 });

  expect(result.exitCode).toBe(0);
  const [bytes, limit] = result.stdout.toString().trim().split(/\s+/).map(Number);
  expect(bytes).toBeLessThanOrEqual(limit!);
});
