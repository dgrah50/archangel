import { Box, Button, Code, Flex, Input, Text, Textarea, chakra } from "@chakra-ui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { Workflow } from "../../src/core/workflow.js";
import { describeChange, fromForm, loadPr, loadSkills, prNumberOf, propose, proposingEnabled, summarizeChecks, toForm, unresolvedSkills, type DraftForm, type PrStatus, type PreviewResult } from "./workflow-draft";

// Draft values are repo-controlled text: rendered only as React children or input values, never as HTML.
// Unsent edits are outlined in violet (`unsent`); stricter/looser marks come from the server's classifyChange, via the propose route's dry run.

const EFFECT: Record<string, string> = { loosen: "Looser", tighten: "Stricter", changed: "Changed, read it" };

export function PreviewView({ preview }: { preview: PreviewResult }) {
  if (preview.changes.length === 0) return <Text textStyle="body13">No workflow changes.</Text>;
  return (
    <Box>
      {preview.loosens ? (
        <Text role="alert" textStyle="body13" color="owner" mb="2">
          This change loosens a limit. The PR will be labelled policy:loosens; read it before merging.
        </Text>
      ) : null}
      <Box textStyle="command" whiteSpace="pre-wrap" aria-label="raw diff">
        {preview.rawDiff.map((l, i) => (
          <Text key={i} as="div" color={l.op === "+" ? "fg" : "fg.subtle"} textDecoration={l.op === "-" ? "line-through" : undefined}>
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
    <Box role="alert" borderTopWidth="1px" borderColor="fg" py="2">
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
  if (n === null) return <Text role="alert" color="owner" textStyle="sm">Cannot read PR status: the PR URL has no number ({url}).</Text>;
  const c = pr ? summarizeChecks(pr.statusCheckRollup) : null;
  return (
    <Box borderTopWidth="1px" borderColor="fg" py="3" aria-label={`PR status ${repo}#${n}`}>
      <Text fontWeight="medium">PR #{n}</Text>
      {error ? <Text role="alert" color="owner" textStyle="sm">PR status read failed: {error}</Text> : null}
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

function SkillsPicker({ selected, available, onChange, dirty }: { selected: string[]; available: string[]; onChange: (v: string[]) => void; dirty?: boolean }) {
  const toggle = (ref: string) => onChange(selected.includes(ref) ? selected.filter((r) => r !== ref) : [...selected, ref]);
  const unknown = selected.filter((r) => !available.includes(r) && !(r.endsWith("/*") && available.some((a) => a.startsWith(r.slice(0, -1)))));
  return (
    <Box {...(dirty ? { borderWidth: "1.5px", borderColor: "unsent", rounded: "12px", p: "3" } : { p: "3", borderWidth: "1.5px", borderColor: "transparent" })}>
      <Text textStyle="body13" color="fg.muted">Skills</Text>
      {available.map((ref) => (
        <label key={ref} style={{ display: "block", fontSize: "0.85em" }}>
          <input type="checkbox" checked={selected.includes(ref)} onChange={() => toggle(ref)} /> {ref}
        </label>
      ))}
      {selected.filter((r) => !available.includes(r)).map((r) => (
        <Text key={r} textStyle="xs" color={unknown.includes(r) ? "owner" : "fg.muted"}>
          {r}{unknown.includes(r) ? " does not resolve" : " (folder wildcard)"}
        </Text>
      ))}
    </Box>
  );
}

export type Draft = ReturnType<typeof useDraft>;

/** The draft and its base sha are pinned together when editing starts; later polls never swap in a newer sha under an old form. */
export function useDraft(repo: string, initial: Workflow, baseFileSha256: string) {
  const [pinned, setPinned] = useState({ initial, sha: baseFileSha256 });
  const [form, setForm] = useState<DraftForm>(() => toForm(initial));
  const [live, setLive] = useState<PreviewResult | { error: string } | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [skills, setSkills] = useState<{ list: string[] } | { error: string } | null>(null);
  const stale = isStale(pinned.sha, baseFileSha256);
  const enabled = typeof document !== "undefined" && proposingEnabled() && !stale;
  const base = toForm(pinned.initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  useEffect(() => {
    if (!proposingEnabled()) return;
    void loadSkills().then((r) => setSkills(r.ok ? { list: r.value } : { error: r.error }));
  }, []);
  // The dry run is pure (it never touches gh): it is how each unsent edit gets its Stricter / Looser mark from classifyChange.
  useEffect(() => {
    if (!dirty || !enabled) return setLive(null);
    let dead = false;
    const t = setTimeout(() => {
      void propose(repo, fromForm(form, pinned.initial), pinned.sha, true).then((out) => {
        if (!dead) setLive("preview" in out ? out.preview : { error: "error" in out ? out.error : "unexpected reply" });
      });
    }, 300);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [form, enabled]);
  const reset = (f: DraftForm) => {
    setForm(f);
    setLive(null);
    setPreview(null);
    setMessage(null);
    setUrl(null);
    setConfirming(false);
  };
  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) => {
    reset({ ...form, [k]: v });
  };
  const reload = () => {
    setPinned({ initial, sha: baseFileSha256 });
    reset(toForm(initial));
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
        setConfirming(false);
      }
    } catch (e) {
      setMessage(`unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return { repo, pinned, form, base, set, dirty, live, preview, message, url, busy, confirming, setConfirming, skills, stale, enabled, reload, run, discard: () => reset(base) };
}

const inputProps = (dirty: boolean) => ({ size: "sm" as const, h: "36px", borderRadius: "10px", textStyle: "body13", ...(dirty ? { borderColor: "unsent", borderWidth: "1.5px" } : {}) });

function Field({ label, dirty, was, children, w }: { label: string; dirty?: boolean; was?: ReactNode; children: ReactNode; w?: string }) {
  return (
    <Box as="label" display="block" w={w}>
      <Text textStyle="body13" color="fg.muted" mb="2">
        {label}
        {dirty && was !== undefined ? <Text as="span" color="fg.subtle" textDecoration="line-through" ml="2">{was}</Text> : null}
      </Text>
      {children}
    </Box>
  );
}

function NumField({ label, k, d, unit }: { label: string; k: "maxNonTestLines" | "maxTotalLines" | "maxFiles" | "baseTestRuns" | "headTestRuns"; d: Draft; unit: string }) {
  const dirty = d.form[k] !== d.base[k];
  return (
    <Field label={label} dirty={dirty} was={d.base[k]} w="150px">
      <Flex align="center" gap="2" position="relative">
        <Input {...inputProps(dirty)} type="number" min={0} value={d.form[k]} onChange={(e) => d.set(k, num(e.target.value, d.form[k]))} />
        <Text textStyle="body13" color="fg.subtle" position="absolute" right="12px" pointerEvents="none">
          {unit}
        </Text>
      </Flex>
    </Field>
  );
}

const lineList = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function Chip({ children, tone }: { children: ReactNode; tone: "builtin" | "own" | "unsent" }) {
  return (
    <Flex align="center" gap="2" h="28px" px="10px" rounded="8px" textStyle="command" color="fg" {...(tone === "builtin" ? { bg: "bg.muted" } : { borderWidth: "1px", borderColor: tone === "unsent" ? "unsent" : "border.emphasized" })}>
      {children}
    </Flex>
  );
}

function ProtectedPaths({ d, builtIn }: { d: Draft; builtIn: string[] }) {
  const [adding, setAdding] = useState("");
  const paths = lineList(d.form.protectedPaths);
  const was = lineList(d.base.protectedPaths);
  const add = () => {
    const v = adding.trim();
    if (v && !paths.includes(v)) d.set("protectedPaths", [...paths, v].join("\n"));
    setAdding("");
  };
  return (
    <Box>
      <Text textStyle="body13" color="fg.muted" mb="2">
        Files the factory may never touch
      </Text>
      <Flex wrap="wrap" gap="2" align="center">
        {builtIn.map((p) => (
          <Chip key={p} tone="builtin">
            {p}
          </Chip>
        ))}
        {paths.map((p) => (
          <Chip key={p} tone={was.includes(p) ? "own" : "unsent"}>
            {p}
            <Button variant="plain" size="2xs" h="auto" minW="0" p="0" color="fg.subtle" aria-label={`Stop protecting ${p}`} onClick={() => d.set("protectedPaths", paths.filter((x) => x !== p).join("\n"))}>
              ×
            </Button>
          </Chip>
        ))}
        <Input {...inputProps(false)} w="170px" h="28px" borderRadius="8px" fontFamily="mono" placeholder="+ add a path" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? add() : undefined)} onBlur={add} />
      </Flex>
      {was.some((p) => !paths.includes(p)) ? (
        <Text textStyle="meta" color="fg.subtle" mt="2" textDecoration="line-through">
          {was.filter((p) => !paths.includes(p)).join(", ")}
        </Text>
      ) : null}
      <Text textStyle="meta" color="fg.subtle" mt="3">
        Grey ones are built in. Violet outlines are your unsent edits.
      </Text>
    </Box>
  );
}

const Select = chakra("select");
const selectProps = (dirty: boolean) => ({ ...inputProps(dirty), px: "10px", borderWidth: dirty ? "1.5px" : "1px", borderStyle: "solid", bg: "bg" });

/** The editor for one stage. Every field carries the same rule: it is a draft until the PR is merged. */
export function StageEditor({ stage, d, builtIn }: { stage: "gate" | "review" | "landing" | "scouts"; d: Draft; builtIn: string[] }) {
  const f = d.form;
  const b = d.base;
  const disabled = !d.enabled && !d.stale;
  return (
    <Flex direction="column" gap="5" pt="5" aria-label={`edit ${stage}`}>
      {disabled ? (
        <Text textStyle="body13" color="fg.muted">
          Editing is disabled on this page (remote mode, or the server has no gh runner).
        </Text>
      ) : null}
      {stage === "gate" ? (
        <>
          <Flex wrap="wrap" gap="5">
            <NumField label="Largest change" k="maxNonTestLines" d={d} unit="lines" />
            <NumField label="Most lines in total" k="maxTotalLines" d={d} unit="lines" />
            <NumField label="Most files" k="maxFiles" d={d} unit="files" />
            <NumField label="Proof runs on main" k="baseTestRuns" d={d} unit="runs" />
            <NumField label="Proof runs on the branch" k="headTestRuns" d={d} unit="runs" />
            <Field label="Test command" dirty={f.testCmd !== b.testCmd} was={b.testCmd} w="260px">
              <Input {...inputProps(f.testCmd !== b.testCmd)} fontFamily="mono" value={f.testCmd} onChange={(e) => d.set("testCmd", e.target.value)} />
            </Field>
          </Flex>
          <ProtectedPaths d={d} builtIn={builtIn} />
          <Field label="Required checks, one per line: Gate plus at least one other. Applies to the next landing." dirty={f.requiredChecks !== b.requiredChecks}>
            <Textarea {...inputProps(f.requiredChecks !== b.requiredChecks)} h="auto" fontFamily="mono" rows={2} value={f.requiredChecks} onChange={(e) => d.set("requiredChecks", e.target.value)} />
          </Field>
        </>
      ) : null}
      {stage === "review" ? (
        <Field label="Review rubric" dirty={f.rubric !== b.rubric}>
          <Textarea {...inputProps(f.rubric !== b.rubric)} h="auto" rows={3} value={f.rubric} onChange={(e) => d.set("rubric", e.target.value)} />
        </Field>
      ) : null}
      {stage === "landing" ? (
        <Field label="Bug fix landing" dirty={f.landing !== b.landing} was={b.landing} w="320px">
          <Select {...selectProps(f.landing !== b.landing)} value={f.landing} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => d.set("landing", e.target.value as DraftForm["landing"])}>
            <option value="owner">owner (you merge)</option>
            <option value="autonomous">autonomous (host shadowMode still decides)</option>
          </Select>
        </Field>
      ) : null}
      {stage === "scouts" ? (
        <>
          {d.skills && "error" in d.skills ? (
            <Text role="alert" color="owner" textStyle="body13">
              Skill list unavailable: {d.skills.error}. Scouts that use skills cannot be previewed.
            </Text>
          ) : null}
          {f.scouts.length === 0 ? (
            <Text textStyle="body13" color="fg.muted">
              No Scouts declared. Scout prompts are files in the repo and are not edited here.
            </Text>
          ) : null}
          {f.scouts.map((s, i) => {
            const was = b.scouts.find((x) => x.name === s.name) ?? s;
            const up = (patch: Partial<DraftForm["scouts"][number]>) => d.set("scouts", f.scouts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <Box key={s.name} borderTopWidth="1px" borderColor="border" pt="4">
                <Text textStyle="rowTitle" mb="3">
                  {s.name}
                </Text>
                <Flex wrap="wrap" gap="5" align="end">
                  <Field label="Kind" dirty={s.kind !== was.kind} was={was.kind} w="150px">
                    <Select {...selectProps(s.kind !== was.kind)} value={s.kind} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => up({ kind: e.target.value as "bug" | "pitch" })}>
                      <option value="bug">bug</option>
                      <option value="pitch">pitch (you decide)</option>
                    </Select>
                  </Field>
                  <Field label="Looks" dirty={s.schedule !== was.schedule} was={was.schedule} w="150px">
                    <Select {...selectProps(s.schedule !== was.schedule)} value={s.schedule} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => up({ schedule: e.target.value as "daily" | "weekly" | "manual" })}>
                      <option value="manual">manual</option>
                      <option value="daily">daily</option>
                      <option value="weekly">weekly</option>
                    </Select>
                  </Field>
                  <Field label="Most per run (1 to 3)" dirty={s.maxProposals !== was.maxProposals} was={was.maxProposals} w="150px">
                    <Input {...inputProps(s.maxProposals !== was.maxProposals)} type="number" value={s.maxProposals} onChange={(e) => up({ maxProposals: num(e.target.value, s.maxProposals) })} />
                  </Field>
                  <Field label="Promotion" dirty={s.promotion !== was.promotion} was={was.promotion} w="150px">
                    <Select {...selectProps(s.promotion !== was.promotion)} value={s.promotion} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => up({ promotion: e.target.value as "owner" | "auto" })}>
                      <option value="owner">owner</option>
                      <option value="auto">auto</option>
                    </Select>
                  </Field>
                  <Field label="Include factory metrics" dirty={s.includeMetrics !== was.includeMetrics}>
                    <input type="checkbox" checked={s.includeMetrics} onChange={(e) => up({ includeMetrics: e.target.checked })} />
                  </Field>
                </Flex>
                <Box mt="3">
                  <SkillsPicker selected={s.skills} available={d.skills && "list" in d.skills ? d.skills.list : []} onChange={(v) => up({ skills: v })} dirty={JSON.stringify(s.skills) !== JSON.stringify(was.skills)} />
                </Box>
              </Box>
            );
          })}
        </>
      ) : null}
    </Flex>
  );
}

/** The right-hand panel: every unsent change with its Stricter / Looser mark, then preview, discard and (after a preview) the PR. */
export function DraftPanel({ d, pollSeconds }: { d: Draft; pollSeconds: number | null }) {
  const next = fromForm(d.form, d.pinned.initial);
  const changes = d.live && "changes" in d.live ? d.live.changes : [];
  const pending = d.dirty && d.live === null && d.enabled;
  const heading = !d.dirty ? "No changes yet" : changes.length > 0 ? `${changes.length} change${changes.length === 1 ? "" : "s"}, not sent yet` : "Changes, not sent yet";
  const loosens = d.preview?.loosens ?? false;
  const open = () => (loosens && !d.confirming ? d.setConfirming(true) : void d.run(false));
  return (
    <Flex direction="column" gap="3.5" borderTopWidth="1px" borderTopColor="fg" pt="3" aria-label="draft changes">
      <Box>
        <Text textStyle="figure" fontSize="20px" lineHeight="26px">
          {heading}
        </Text>
        <Text textStyle="body13" color="fg.muted" mt="1">
          {d.dirty ? "Nothing changes until you merge the PR." : "Open a stage and edit it. Edits are listed here and change nothing until you merge the PR."}
        </Text>
      </Box>
      {d.stale ? <StaleNotice onReload={d.reload} /> : null}
      {d.live && "error" in d.live ? (
        <Text role="alert" color="owner" textStyle="body13">
          {d.live.error}
        </Text>
      ) : null}
      {pending ? (
        <Text textStyle="meta" color="fg.subtle">
          Checking what this changes...
        </Text>
      ) : null}
      {changes.length > 0 ? (
        <Flex direction="column" borderTopWidth="1px" borderTopColor="border" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
          {changes.map((c) => {
            const { title, stage } = describeChange(c, d.pinned.initial, next);
            return (
              <Box key={c.field} py="3">
                <Flex justify="space-between" gap="4">
                  <Text textStyle="label" fontSize="15px">
                    {title}
                  </Text>
                  <Text textStyle="body13" color={c.direction === "loosen" ? "owner" : "fg.subtle"} flexShrink={0}>
                    {EFFECT[c.direction]}
                  </Text>
                </Flex>
                <Text textStyle="body13" color="fg.muted">
                  {stage}
                </Text>
                {c.field === "landing.bugfix" && c.direction === "loosen" ? (
                  <Text textStyle="body13" color="owner" mt="2">
                    This gives the factory more room. This machine's shadow mode and daily cap still decide what actually merges.
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Flex>
      ) : null}
      {d.dirty ? (
        <Flex gap="3">
          <Button flex="1" size="sm" borderRadius="12px" disabled={!d.enabled || d.busy} onClick={() => void d.run(true)}>
            Preview the PR
          </Button>
          <Button variant="outline" size="sm" borderRadius="12px" onClick={d.discard}>
            Discard
          </Button>
        </Flex>
      ) : null}
      {d.message ? (
        <Text role="alert" color="owner" textStyle="body13">
          {d.message}
        </Text>
      ) : null}
      {d.preview ? (
        <Box>
          <PreviewView preview={d.preview} />
          {d.preview.changes.length > 0 && d.url === null ? (
            <Box mt="3">
              {d.confirming ? (
                <Text role="alert" textStyle="body13" color="owner" mb="2">
                  This loosens a limit. Open the PR anyway? You still have to read and merge it on GitHub.
                </Text>
              ) : null}
              <Flex gap="3">
                <Button size="sm" borderRadius="12px" disabled={!d.enabled || d.busy} onClick={open}>
                  {d.confirming ? "Yes, open the PR that loosens" : "Open the PR"}
                </Button>
                {d.confirming ? (
                  <Button variant="outline" size="sm" borderRadius="12px" onClick={() => d.setConfirming(false)}>
                    Cancel
                  </Button>
                ) : null}
              </Flex>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {d.url ? (
        <Text textStyle="body13">
          Opened <Code>{d.url}</Code>. It is not merged; review it on GitHub.
        </Text>
      ) : null}
      {d.url ? <PrStatusCard repo={d.repo} url={d.url} /> : null}
      <Text textStyle="body13" color="fg.subtle">
        Based on the policy at <Text as="span" textStyle="command">{d.pinned.sha.slice(0, 8)}</Text>. If the file changes before you send, you will be asked to review the difference. Rules apply {pollSeconds === null ? "on the daemon's next tick" : `about ${pollSeconds} seconds`} after you merge.
      </Text>
    </Flex>
  );
}
