import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { parse as parseYaml } from "yaml";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Two PRs in flight: when the first merges, the second's Gate must still judge only the second's own diff.
it("the Gate workflow diffs a PR against the base its merge was built on, not the base when the PR was opened", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-wf-"));
  try {
    const commit = (file: string) => {
      fs.writeFileSync(path.join(dir, file), file);
      git(dir, ["add", "-A"]);
      git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", file]);
      return git(dir, ["rev-parse", "HEAD"]);
    };
    git(dir, ["init", "-q", "-b", "main"]);
    commit("opened-on");
    git(dir, ["checkout", "-q", "-b", "factory/2"]);
    const prHead = commit("pr.txt");
    git(dir, ["checkout", "-q", "main"]);
    const mainNow = commit("merged-meanwhile.txt");
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge", "factory/2"]);

    for (const file of ["workflows/archangel-gate.yml", ".github/workflows/archangel-gate.yml"]) {
      const wf = parseYaml(fs.readFileSync(file, "utf8")) as { jobs: { gate: { steps: Array<{ id?: string; run?: string }> } } };
      const step = wf.jobs.gate.steps.find((s) => s.id === "base")!;
      const run = (headSha: string) => {
        const envFile = path.join(dir, ".git", "github-env");
        fs.writeFileSync(envFile, "");
        const r = spawnSync("bash", ["-c", step.run!], { cwd: dir, env: { PATH: process.env.PATH!, GITHUB_ENV: envFile, HEAD_SHA: headSha }, encoding: "utf8" });
        return { status: r.status, env: fs.readFileSync(envFile, "utf8").trim() };
      };
      const ok = run(prHead);
      expect(ok).toEqual({ status: 0, env: `BASE_SHA=${mainNow}` });
      expect(git(dir, ["diff", "--name-only", mainNow, "HEAD"])).toBe("pr.txt");
      // A merge of some other head (the branch moved after the event) is refused, so a proof is never attributed to code it did not test.
      expect(run(mainNow).status).toBe(1);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
