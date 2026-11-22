import { Badge, Box, Button, Code, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import type { Workflow } from "../../src/core/workflow.js";
import { countEdits, fromForm, loadPr, loadSkills, prNumberOf, propose, proposingEnabled, summarizeChecks, toForm, unresolvedSkills, type DraftForm, type PrStatus, type PreviewResult } from "./workflow-draft";

// Draft values are repo-controlled text: rendered only as React children or input values, never as HTML.

const EFFECT: Record<string, string> = { loosen: "LOOSENS", tighten: "tightens", changed: "changed: read it" };

export function PreviewView({ preview }: { preview: PreviewResult }) {
  if (preview.changes.length === 0) return <Text textStyle="sm">No workflow changes.</Text>;
  return (
    <Box>
      {preview.loosens ? (
        <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="2" mb="2" color="red.fg">
          This change loosens a limit. The PR will be labelled policy:loosens; read it before merging.
        </Box>
      ) : null}
      {preview.changes.map((c) => (
        <Text key={c.field} textStyle="sm" color={c.direction === "loosen" ? "red.fg" : undefined} fontWeight={c.direction === "loosen" ? "bold" : undefined}>
          {c.field}: {EFFECT[c.direction]}
        </Text>
      ))}
      <Box mt="2" fontFamily="mono" textStyle="xs" whiteSpace="pre-wrap" aria-label="raw diff">
        {preview.rawDiff.map((l, i) => (
          <Text key={i} as="div" color={l.op === "+" ? "green.fg" : l.op === "-" ? "red.fg" : "fg.muted"}>
            {l.op} {l.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Math.trunc(Number(v)) : fallback);

/** The draft was started from one version of the workflow file; polling brought a different one. */
export const isStale = (pinnedSha: string, currentSha: string) => pinnedSha !== currentSha;

export function StaleNotice({ onReload }: { onReload: () => void }) {
  return (
    <Box role="alert" borderWidth="1px" borderColor="orange.solid" rounded="md" p="2" mt="2">
      <Text textStyle="sm">The workflow changed upstream, so this draft is out of date and cannot be submitted.</Text>
      <Button size="sm" mt="2" onClick={onReload}>
        Workflow changed upstream: reload draft
      </Button>
    </Box>
  );
}

/** The opened PR's live state through U9's gh read. A failed read is shown as an error, never as "unknown means fine". */
export function PrStatusCard({ repo, url }: { repo: string; url: string }) {
  const n = prNumberOf(url);
  const [pr, setPr] = useState<PrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (n === null) return;
    setBusy(true);
    const r = await loadPr(repo, n);
    setBusy(false);
    if (r.ok) {
      setPr(r.value);
      setError(null);
    } else setError(r.error);
  };
  useEffect(() => {
    void refresh();
  }, [repo, n]);
  if (n === null) return <Text role="alert" color="red.fg" textStyle="sm">Cannot read PR status: the PR URL has no number ({url}).</Text>;
  const c = pr ? summarizeChecks(pr.statusCheckRollup) : null;
  return (
    <Box borderWidth="1px" rounded="md" p="3" mt="2" aria-label={`PR status ${repo}#${n}`}>
      <Text fontWeight="medium">PR #{n}</Text>
      {error ? <Text role="alert" color="red.fg" textStyle="sm">PR status read failed: {error}</Text> : null}
      {pr ? (
        <Text textStyle="sm">
          {pr.state}{pr.isDraft ? " (draft)" : ""} · mergeable: {pr.mergeable} · review: {pr.reviewDecision || "none"} · checks: {c!.pass} passing, {c!.fail} failing, {c!.pending} pending
          {pr.state === "MERGED" ? ". Merged; the daemon applies the file on its next tick (the file sha above changes when it has)." : ""}
        </Text>
      ) : null}
      <Button size="xs" mt="1" disabled={busy} onClick={() => void refresh()}>
        Refresh status
      </Button>
    </Box>
  );
}

function SkillsPicker({ selected, available, onChange }: { selected: string[]; available: string[]; onChange: (v: string[]) => void }) {
  const toggle = (ref: string) => onChange(selected.includes(ref) ? selected.filter((r) => r !== ref) : [...selected, ref]);
  const unknown = selected.filter((r) => !available.includes(r) && !(r.endsWith("/*") && available.some((a) => a.startsWith(r.slice(0, -1)))));
  return (
    <Box>
      <Text textStyle="xs" color="fg.muted">skills</Text>
      {available.map((ref) => (
        <label key={ref} style={{ display: "block", fontSize: "0.85em" }}>
          <input type="checkbox" checked={selected.includes(ref)} onChange={() => toggle(ref)} /> {ref}
        </label>
      ))}
      {selected.filter((r) => !available.includes(r)).map((r) => (
        <Text key={r} textStyle="xs" color={unknown.includes(r) ? "red.fg" : "fg.muted"}>
          {r}{unknown.includes(r) ? " does not resolve" : " (folder wildcard)"}
        </Text>
      ))}
    </Box>
  );
}

function Stage({ title, applies, children }: { title: string; applies: string; children: React.ReactNode }) {
  return (
    <Box borderWidth="1px" rounded="md" p="3" aria-label={`stage ${title}`}>
      <Text fontWeight="medium">
        {title} <Badge ml="1">{applies}</Badge>
      </Text>
      <Stack gap="2" mt="2">
        {children}
      </Stack>
    </Box>
  );
}

export function WorkflowEditor({ repo, initial, baseFileSha256 }: { repo: string; initial: Workflow; baseFileSha256: string }) {
  // The draft and its base sha are pinned together when editing starts; later polls never swap in a newer sha under an old form.
  const [pinned, setPinned] = useState({ initial, sha: baseFileSha256 });
  const [form, setForm] = useState<DraftForm>(() => toForm(initial));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<{ list: string[] } | { error: string } | null>(null);
  const stale = isStale(pinned.sha, baseFileSha256);
  const enabled = typeof document !== "undefined" && proposingEnabled() && !stale;
  useEffect(() => {
    if (!proposingEnabled()) return;
    void loadSkills().then((r) => setSkills(r.ok ? { list: r.value } : { error: r.error }));
  }, []);
  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(null);
    setMessage(null);
    setUrl(null);
  };
  const edits = countEdits(toForm(pinned.initial), form);
  const reload = () => {
    setPinned({ initial, sha: baseFileSha256 });
    setForm(toForm(initial));
    setPreview(null);
    setMessage(null);
    setUrl(null);
  };
  const run = async (dryRun: boolean) => {
    // Skill references are checked against the host's bundled list before anything is sent; no list means no proposal.
    if (form.scouts.some((x) => x.skills.length > 0)) {
      if (skills === null) return setMessage("The skill list has not loaded yet; try again in a moment.");
      if ("error" in skills) return setMessage(`Cannot check skills (${skills.error}); nothing was sent.`);
      const bad = unresolvedSkills(form, skills.list);
      if (bad.length > 0) return setMessage(`Unknown skills: ${bad.join(", ")}. Fix them before previewing.`);
    }
    setBusy(true);
    setMessage(null);
    try {
      const out = await propose(repo, fromForm(form, pinned.initial), pinned.sha, dryRun);
      if ("error" in out) setMessage(out.error);
      else if ("preview" in out) setPreview(out.preview);
      else {
        setUrl(out.url);
        setPreview(null);
      }
    } catch (e) {
      setMessage(`unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: "block" }}>
      <Text textStyle="xs" color="fg.muted">
        {label}
      </Text>
      {node}
    </label>
  );

  return (
    <Box borderWidth="1px" rounded="md" p="3" mt="3" aria-label={`edit workflow ${repo}`}>
      <Text fontWeight="medium" mb="2">
        Edit workflow <Badge ml="1">repo-owned values only</Badge>
      </Text>
      {stale ? <StaleNotice onReload={reload} /> : null}
      {!enabled && !stale ? (
        <Text textStyle="sm" color="fg.muted" mb="2">
          Editing is disabled on this page (remote mode, or the server has no gh runner).
        </Text>
      ) : null}
      <Stack gap="3">
        <Stage title="Gate" applies="applies to the next PR">
          {field("max non-test lines", <Input size="sm" type="number" value={form.maxNonTestLines} onChange={(e) => set("maxNonTestLines", num(e.target.value, form.maxNonTestLines))} />)}
          {field("max total lines", <Input size="sm" type="number" value={form.maxTotalLines} onChange={(e) => set("maxTotalLines", num(e.target.value, form.maxTotalLines))} />)}
          {field("max files", <Input size="sm" type="number" value={form.maxFiles} onChange={(e) => set("maxFiles", num(e.target.value, form.maxFiles))} />)}
          {field("base test runs", <Input size="sm" type="number" value={form.baseTestRuns} onChange={(e) => set("baseTestRuns", num(e.target.value, form.baseTestRuns))} />)}
          {field("head test runs", <Input size="sm" type="number" value={form.headTestRuns} onChange={(e) => set("headTestRuns", num(e.target.value, form.headTestRuns))} />)}
          {field("test command", <Input size="sm" value={form.testCmd} onChange={(e) => set("testCmd", e.target.value)} />)}
          {field("protected paths (one per line)", <Textarea size="sm" rows={3} value={form.protectedPaths} onChange={(e) => set("protectedPaths", e.target.value)} />)}
        </Stage>
        <Stage title="Required checks" applies="applies to the next landing">
          {field("required checks (one per line; Gate plus at least one other)", <Textarea size="sm" rows={2} value={form.requiredChecks} onChange={(e) => set("requiredChecks", e.target.value)} />)}
        </Stage>
        <Stage title="Review rubric" applies="applies to the next review">
          {field("review rubric", <Textarea size="sm" rows={3} value={form.rubric} onChange={(e) => set("rubric", e.target.value)} />)}
        </Stage>
        <Stage title="Landing (auto-implement)" applies="applies to the next landing">
          {field(
            "bugfix landing",
            <select value={form.landing} onChange={(e) => set("landing", e.target.value as DraftForm["landing"])}>
              <option value="owner">owner (you merge)</option>
              <option value="autonomous">autonomous (host shadowMode still decides)</option>
            </select>,
          )}
        </Stage>
        <Stage title="Scouts" applies="applies at the next Scout run">
          {skills && "error" in skills ? (
            <Text role="alert" color="red.fg" textStyle="sm">Skill list unavailable: {skills.error}. Scouts that use skills cannot be previewed.</Text>
          ) : null}
          {form.scouts.length === 0 ? <Text textStyle="sm" color="fg.muted">No Scouts declared. Scout prompts are files in the repo and are not edited here.</Text> : null}
          {form.scouts.map((s, i) => {
            const up = (patch: Partial<DraftForm["scouts"][number]>) => set("scouts", form.scouts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <Box key={s.name} borderTopWidth="1px" pt="2">
                <Text textStyle="sm" fontWeight="medium">
                  Scout {s.name}
                </Text>
                {field("kind", <select value={s.kind} onChange={(e) => up({ kind: e.target.value as "bug" | "pitch" })}><option value="bug">bug</option><option value="pitch">pitch (owner decides, weekly or manual, 1 proposal)</option></select>)}
                {field("schedule", <select value={s.schedule} onChange={(e) => up({ schedule: e.target.value as "daily" | "weekly" | "manual" })}><option value="manual">manual</option><option value="daily">daily</option><option value="weekly">weekly</option></select>)}
                {field("max proposals per run (1-3)", <Input size="sm" type="number" value={s.maxProposals} onChange={(e) => up({ maxProposals: num(e.target.value, s.maxProposals) })} />)}
                {field("promotion", <select value={s.promotion} onChange={(e) => up({ promotion: e.target.value as "owner" | "auto" })}><option value="owner">owner</option><option value="auto">auto</option></select>)}
                {field("include factory metrics", <input type="checkbox" checked={s.includeMetrics} onChange={(e) => up({ includeMetrics: e.target.checked })} />)}
                <SkillsPicker selected={s.skills} available={skills && "list" in skills ? skills.list : []} onChange={(v) => up({ skills: v })} />
              </Box>
            );
          })}
        </Stage>
      </Stack>
      <Stack direction="row" gap="2" mt="3" align="center" position="sticky" bottom="0" bg="bg" py="2" borderTopWidth="1px" aria-label="draft footer">
        <Text textStyle="sm" fontWeight="medium">
          {edits} change{edits === 1 ? "" : "s"}
        </Text>
        <Button size="sm" disabled={!enabled || busy || edits === 0} onClick={() => void run(true)}>
          Preview PR
        </Button>
        <Button size="sm" colorPalette="blue" disabled={!enabled || busy || url !== null || preview === null || preview.changes.length === 0} onClick={() => void run(false)}>
          Open PR
        </Button>
      </Stack>
      {message ? (
        <Text role="alert" color="red.fg" textStyle="sm" mt="2">
          {message}
        </Text>
      ) : null}
      {preview ? (
        <Box mt="3">
          <PreviewView preview={preview} />
        </Box>
      ) : null}
      {url ? (
        <Text mt="2" textStyle="sm">
          Opened <Code>{url}</Code>. It is not merged; review it on GitHub.
        </Text>
      ) : null}
      {url ? <PrStatusCard repo={repo} url={url} /> : null}
    </Box>
  );
}
