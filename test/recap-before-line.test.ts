import { expect, it } from "bun:test";
import { beforeLine } from "../src/core/recap.js";

it("keeps Reproducibly prose and stops at Expected and Repro headings", () => {
  const line = beforeLine(
    7,
    "Digest drops items",
    "Reproducibly, the digest drops the last item when the list has one entry.\n\nExpected: every item is listed.",
  );

  expect(line).toContain("the digest drops the last item");
  expect(line).not.toContain("every item is listed");

  const emphasizedLine = beforeLine(
    7,
    "Digest drops items",
    "Digest drops the last item.\n\n_Expected_: every item is listed.",
  );
  expect(emphasizedLine).not.toContain("every item is listed");

  const multiWordLabelsLine = beforeLine(
    7,
    "Digest drops items",
    "Digest drops the last item.\n\n**Reproduction steps:** open a digest.\n\n**Expected result:** every item is listed.",
  );
  expect(multiWordLabelsLine).not.toContain("open a digest");
  expect(multiWordLabelsLine).not.toContain("every item is listed");

  const markdownHeadingLine = beforeLine(
    7,
    "Digest drops items",
    "Digest drops the last item.\n\n## Expected/Actual\nThe digest should list every item.",
  );
  expect(markdownHeadingLine).not.toContain("The digest should list every item");

  const reproHeadingLine = beforeLine(
    7,
    "Digest drops items",
    "Digest drops the last item.\n\n## Repro.\nSteps follow.",
  );
  expect(reproHeadingLine).not.toContain("Steps follow");

  const reproduceHeadingLine = beforeLine(
    7,
    "Digest drops items",
    "Digest drops the last item.\n\n## Reproducing the bug\nSteps follow.",
  );
  expect(reproduceHeadingLine).not.toContain("Steps follow");
});
