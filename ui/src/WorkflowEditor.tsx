import { Badge, Box, Button, Code, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { useState } from "react";
import type { Workflow } from "../../src/core/workflow.js";
import { fromForm, propose, proposingEnabled, toForm, type DraftForm, type PreviewResult } from "./workflow-draft";

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

export function WorkflowEditor({ repo, initial, baseFileSha256 }: { repo: string; initial: Workflow; baseFileSha256: string }) {
  const [form, setForm] = useState<DraftForm>(() => toForm(initial));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = typeof document !== "undefined" && proposingEnabled();
  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(null);
  };
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setMessage(null);
    const out = await propose(repo, fromForm(form, initial), baseFileSha256, dryRun);
    setBusy(false);
    if ("error" in out) setMessage(out.error);
    else if ("preview" in out) setPreview(out.preview);
    else setUrl(out.url);
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
      {!enabled ? (
        <Text textStyle="sm" color="fg.muted" mb="2">
          Editing is disabled on this page (remote mode, or the server has no gh runner).
        </Text>
      ) : null}
      <Stack gap="2">
        {field("max non-test lines", <Input size="sm" type="number" value={form.maxNonTestLines} onChange={(e) => set("maxNonTestLines", num(e.target.value, form.maxNonTestLines))} />)}
        {field("max total lines", <Input size="sm" type="number" value={form.maxTotalLines} onChange={(e) => set("maxTotalLines", num(e.target.value, form.maxTotalLines))} />)}
        {field("max files", <Input size="sm" type="number" value={form.maxFiles} onChange={(e) => set("maxFiles", num(e.target.value, form.maxFiles))} />)}
        {field("base test runs", <Input size="sm" type="number" value={form.baseTestRuns} onChange={(e) => set("baseTestRuns", num(e.target.value, form.baseTestRuns))} />)}
        {field("head test runs", <Input size="sm" type="number" value={form.headTestRuns} onChange={(e) => set("headTestRuns", num(e.target.value, form.headTestRuns))} />)}
        {field("test command", <Input size="sm" value={form.testCmd} onChange={(e) => set("testCmd", e.target.value)} />)}
        {field("protected paths (one per line)", <Textarea size="sm" rows={3} value={form.protectedPaths} onChange={(e) => set("protectedPaths", e.target.value)} />)}
        {field("required checks (one per line; Gate plus at least one other)", <Textarea size="sm" rows={2} value={form.requiredChecks} onChange={(e) => set("requiredChecks", e.target.value)} />)}
        {field("review rubric", <Textarea size="sm" rows={3} value={form.rubric} onChange={(e) => set("rubric", e.target.value)} />)}
        {field(
          "bugfix landing",
          <select value={form.landing} onChange={(e) => set("landing", e.target.value as DraftForm["landing"])}>
            <option value="owner">owner (you merge)</option>
            <option value="autonomous">autonomous (host shadowMode still decides)</option>
          </select>,
        )}
        {form.scouts.map((s, i) => {
          const up = (patch: Partial<DraftForm["scouts"][number]>) => set("scouts", form.scouts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <Box key={s.name} borderTopWidth="1px" pt="2">
              <Text textStyle="sm" fontWeight="medium">
                Scout {s.name}
              </Text>
              {field("schedule", <select value={s.schedule} onChange={(e) => up({ schedule: e.target.value as "daily" | "manual" })}><option value="manual">manual</option><option value="daily">daily</option></select>)}
              {field("max proposals per run (1-3)", <Input size="sm" type="number" value={s.maxProposals} onChange={(e) => up({ maxProposals: num(e.target.value, s.maxProposals) })} />)}
              {field("promotion", <select value={s.promotion} onChange={(e) => up({ promotion: e.target.value as "owner" | "auto" })}><option value="owner">owner</option><option value="auto">auto</option></select>)}
              {field("include factory metrics", <input type="checkbox" checked={s.includeMetrics} onChange={(e) => up({ includeMetrics: e.target.checked })} />)}
            </Box>
          );
        })}
      </Stack>
      <Stack direction="row" gap="2" mt="3">
        <Button size="sm" disabled={!enabled || busy} onClick={() => void run(true)}>
          Preview
        </Button>
        <Button size="sm" colorPalette="blue" disabled={!enabled || busy || preview === null || preview.changes.length === 0} onClick={() => void run(false)}>
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
    </Box>
  );
}
