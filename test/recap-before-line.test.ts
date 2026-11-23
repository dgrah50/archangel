import { expect, it } from "bun:test";
import { beforeLine } from "../src/core/recap.js";

it("keeps prose beginning with Reproducibly and stops at an Expected heading", () => {
  const line = beforeLine(
    7,
    "Digest drops items",
    "Reproducibly, the digest drops the last item when the list has one entry.\n\nExpected: every item is listed.",
  );

  expect(line).toContain("the digest drops the last item");
  expect(line).not.toContain("every item is listed");
});
