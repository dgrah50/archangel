import { Badge, Box, Button, Checkbox, Code, Flex, Heading, Input, NativeSelect, Stack, Text, Textarea } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { ApplyResult, HostConfigRead, PreviewResult } from "../../src/core/ui-host-config.js";
import { applyHostConfig, loadHostConfig, previewHostConfig, type HostError } from "./host-config-client";
import { PROVIDERS, WRITER_CHAINS, addChainEntry, checkIndependence, editField, moveChainEntry, readForm, removeChainEntry, setChainEntry, type ChainEntry, type Provider } from "./host-edit";

const STARTER = "ownerUserId: 1\nprojects:\n  - repo: owner/name\n";

const TITLE: Record<HostError["kind"], string> = {
  conflict: "archangel.yaml changed on disk since you loaded it.",
  validation: "The change was rejected.",
  forbidden: "Editing is disabled for this dashboard (remote mode, or not wired). Nothing was changed.",
  unauthorized: "This page has no valid token, so it cannot edit. Reload the page from the local dashboard.",
  schema_behind: "The Ledger schema is behind. Restart the daemon so it can migrate, then try again.",
  network: "Could not reach the dashboard server.",
  error: "The request failed.",
};

/** Every failure kind of the host-config client has its own visible state. */
export function HostErrorNotice({ error, onReload }: { error: HostError; onReload: () => void }) {
  return (
    <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="3" mt="4">
      <Text fontWeight="medium">{TITLE[error.kind]}</Text>
      <Text textStyle="sm">{error.message}</Text>
      {error.kind === "conflict" ? (
        <Button size="xs" mt="2" onClick={onReload}>Reload the file and reapply my edits</Button>
      ) : null}
    </Box>
  );
}

export function IndependenceNotice({ problems }: { problems: string[] }) {
  if (problems.length === 0) return <Text textStyle="sm" color="fg.muted" mt="2">Independence check: reviewers differ from the writers.</Text>;
  return (
    <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" px="3" py="2" mt="2" textStyle="sm">
      <Text fontWeight="medium">Reviewers are not independent of the writers.</Text>
      {problems.map((p) => <Text key={p}>{p}</Text>)}
    </Box>
  );
}

export function PreviewPanel({ preview, confirm, onConfirm, onApply, busy, blocked }: { preview: PreviewResult; confirm: boolean; onConfirm: (v: boolean) => void; onApply: () => void; busy: boolean; blocked: string | null }) {
  const loosens = preview.loosening.length > 0;
  return (
    <Box mt="4" borderWidth="1px" rounded="md" p="3">
      <Heading size="sm">Preview</Heading>
      {!preview.valid ? (
        <Box role="alert" mt="2" textStyle="sm" color="red.fg">
          <Text fontWeight="medium">archangel.yaml would be invalid:</Text>
          {preview.errors.map((e) => <Text key={e}>{e}</Text>)}
        </Box>
      ) : null}
      {preview.warnings.map((w) => <Text key={w} textStyle="sm" color="orange.fg" mt="2">Warning: {w}</Text>)}
      <Code as="pre" display="block" whiteSpace="pre-wrap" mt="2" p="2" maxH="20rem" overflow="auto">{preview.diff || "(no changes)"}</Code>
      {preview.valid ? (
        <Stack mt="3" gap="2">
          {loosens ? (
            <Box borderWidth="1px" borderColor="orange.solid" rounded="md" p="2" textStyle="sm">
              <Text fontWeight="medium">This loosens limits:</Text>
              {preview.loosening.map((l) => <Text key={l}>{l}</Text>)}
              <Checkbox.Root mt="2" checked={confirm} onCheckedChange={(e) => onConfirm(e.checked === true)}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>I understand and want to loosen these</Checkbox.Label>
              </Checkbox.Root>
            </Box>
          ) : null}
          {blocked ? <Text textStyle="sm" color="red.fg">{blocked}</Text> : null}
          <Flex><Button size="sm" colorPalette="blue" onClick={onApply} disabled={busy || blocked !== null || (loosens && !confirm)}>Apply</Button></Flex>
        </Stack>
      ) : null}
    </Box>
  );
}

type Op = (text: string) => string;

function NumberField({ label, value, onCommit, min }: { label: string; value: number | null; onCommit: (n: number) => void; min?: number }) {
  return (
    <Box>
      <Text textStyle="sm" color="fg.muted">{label}</Text>
      <Input key={String(value)} type="number" size="sm" min={min} defaultValue={value ?? ""} aria-label={label} onBlur={(e) => { const n = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(n) && n !== value) onCommit(n); }} />
    </Box>
  );
}

function ChainEditor({ label, chain, onOp, path }: { label: string; chain: ChainEntry[]; onOp: (op: Op) => void; path: string[] }) {
  return (
    <Box mt="3">
      <Text fontWeight="medium" textStyle="sm">{label}</Text>
      {chain.map((e, i) => (
        <Flex key={`${i}-${e.provider}-${e.model ?? ""}`} gap="2" mt="1" align="center">
          <NativeSelect.Root size="sm" w="8rem">
            <NativeSelect.Field aria-label={`${label} entry ${i + 1} provider`} value={e.provider} onChange={(ev) => onOp((t) => setChainEntry(t, path, i, { ...e, provider: ev.target.value as Provider }))}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Input size="sm" w="14rem" placeholder="model (optional)" aria-label={`${label} entry ${i + 1} model`} defaultValue={e.model ?? ""} onBlur={(ev) => { if (ev.target.value !== (e.model ?? "")) onOp((t) => setChainEntry(t, path, i, { provider: e.provider, ...(ev.target.value ? { model: ev.target.value } : {}) })); }} />
          <Button size="2xs" variant="outline" aria-label="Move up" disabled={i === 0} onClick={() => onOp((t) => moveChainEntry(t, path, i, -1))}>Up</Button>
          <Button size="2xs" variant="outline" aria-label="Move down" disabled={i === chain.length - 1} onClick={() => onOp((t) => moveChainEntry(t, path, i, 1))}>Down</Button>
          <Button size="2xs" variant="outline" aria-label="Remove" disabled={chain.length <= 1} onClick={() => onOp((t) => removeChainEntry(t, path, i))}>Remove</Button>
        </Flex>
      ))}
      <Button size="2xs" variant="outline" mt="1" onClick={() => onOp((t) => addChainEntry(t, path, "claude"))}>Add entry</Button>
    </Box>
  );
}

function FormFields({ text, onOp }: { text: string; onOp: (op: Op) => void }) {
  const f = readForm(text);
  if (!f) return <Text mt="4" color="red.fg" role="alert">The text on the Raw tab does not parse as YAML, so the form cannot show it. Fix it there first.</Text>;
  const set = (key: string) => (n: number) => onOp((t) => editField(t, [key], n));
  const ind = checkIndependence(f);
  return (
    <Box mt="4">
      <Flex gap="4" wrap="wrap">
        <NumberField label="Owner user id" value={f.ownerUserId} min={1} onCommit={set("ownerUserId")} />
        <NumberField label="Digest hour (0-23)" value={f.digestHour} min={0} onCommit={set("digestHour")} />
        <NumberField label="Max daily spend (USD)" value={f.maxDailyUsd} min={1} onCommit={set("maxDailyUsd")} />
        <Box>
          <Text textStyle="sm" color="fg.muted">Timezone</Text>
          <Input key={f.dailyTimezone} size="sm" aria-label="Timezone" defaultValue={f.dailyTimezone} onBlur={(e) => { if (e.target.value && e.target.value !== f.dailyTimezone) onOp((t) => editField(t, ["dailyTimezone"], e.target.value)); }} />
        </Box>
        <Box>
          <Text textStyle="sm" color="fg.muted">Auth mode</Text>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field aria-label="Auth mode" value={f.authMode} onChange={(e) => onOp((t) => editField(t, ["authMode"], e.target.value))}>
              <option value="subscription">subscription</option>
              <option value="api">api</option>
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Box>
      </Flex>
      <Heading size="sm" mt="6">Limits</Heading>
      <Flex gap="4" wrap="wrap" mt="2">
        <NumberField label="Autonomous steps without owner" value={f.maxAutonomousStepsWithoutOwner} min={1} onCommit={set("maxAutonomousStepsWithoutOwner")} />
        <NumberField label="Implement attempts per Thread" value={f.maxImplementAttemptsPerThread} min={1} onCommit={set("maxImplementAttemptsPerThread")} />
        <NumberField label="Revisions per Thread" value={f.maxRevisionsPerThread} min={0} onCommit={set("maxRevisionsPerThread")} />
        <NumberField label="Rebases per Thread" value={f.maxRebasesPerThread} min={0} onCommit={set("maxRebasesPerThread")} />
      </Flex>
      <Heading size="sm" mt="6">Chains</Heading>
      {WRITER_CHAINS.map((r) => <ChainEditor key={r} label={`${r[0]!.toUpperCase()}${r.slice(1)} chain (writer)`} chain={f.chains[r]} path={["chains", r]} onOp={onOp} />)}
      <ChainEditor label="Reviewer chain" chain={f.reviewerChain} path={["reviewerChain"]} onOp={onOp} />
      <IndependenceNotice problems={ind.problems} />
      {ind.problems.length === 0 ? <Text textStyle="xs" color="fg.muted">Writers: {ind.writers.join(", ")}. Reviewers: {ind.reviewers.join(", ")}.</Text> : null}
    </Box>
  );
}

/** Settings form and Raw tab on W2. The text is the single draft; the form edits it through YAML Document operations that are replayed if the file changes under us. */
export function HostConfigEditor({ view, onSaved }: { view: "form" | "raw"; onSaved: () => void }) {
  const [read, setRead] = useState<HostConfigRead | null>(null);
  const [loadError, setLoadError] = useState<HostError | null>(null);
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<HostError | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ApplyResult | null>(null);

  const base = read ? (read.text ?? STARTER) : null;
  const text = base === null ? "" : ops.reduce((t, op) => { try { return op(t); } catch { return t; } }, base);
  const dirty = ops.length > 0;

  const reload = useCallback(async (keepEdits: boolean) => {
    const r = await loadHostConfig();
    if (!r.ok) return setLoadError(r.error);
    setLoadError(null);
    setError(null);
    setPreview(null);
    setRead(r.value);
    if (!keepEdits) setOps([]);
  }, []);
  useEffect(() => { void reload(false); }, [reload]);

  const change = (op: Op) => { setOps((o) => [...o, op]); setPreview(null); setConfirm(false); setDone(null); };
  const blocked = (() => { const f = readForm(text); return f && checkIndependence(f).problems.length > 0 ? "Fix the reviewer independence problem before applying." : null; })();

  const runPreview = async () => {
    if (!read) return;
    setBusy(true);
    setError(null);
    const r = await previewHostConfig(read.sha256, text);
    setBusy(false);
    if (r.ok) setPreview(r.value);
    else { setPreview(null); setError(r.error); }
  };
  const runApply = async () => {
    if (!read || !preview?.previewSha256) return;
    setBusy(true);
    setError(null);
    const r = await applyHostConfig(read.sha256, text, preview.previewSha256, confirm);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDone(r.value);
    setOps([]);
    setPreview(null);
    await reload(false);
    onSaved();
  };

  if (loadError) return (
    <>
      <HostErrorNotice error={loadError} onReload={() => void reload(true)} />
      <Button size="sm" mt="2" onClick={() => void reload(false)}>Retry</Button>
    </>
  );
  if (!read) return <Text color="fg.muted" mt="6">Loading archangel.yaml...</Text>;
  return (
    <Box mt="4">
      <Flex gap="2" align="center" wrap="wrap">
        <Badge colorPalette="orange">Applies after the daemon restarts</Badge>
        {read.state === "missing" ? <Text textStyle="sm">No archangel.yaml yet: this creates it.</Text> : <Text textStyle="sm" color="fg.muted">Comments and layout outside your edits are kept.</Text>}
      </Flex>
      {done ? (
        <Box role="status" borderWidth="1px" borderColor="green.solid" rounded="md" p="3" mt="4" textStyle="sm">
          Written to <Code>{done.path}</Code>{done.backup ? <>, previous version saved as <Code>{done.backup}</Code></> : null}. Restart the daemon to apply.
        </Box>
      ) : null}
      {error ? <HostErrorNotice error={error} onReload={() => void reload(true)} /> : null}
      {error?.kind === "conflict" ? <Text textStyle="sm" color="fg.muted" mt="1">Form edits are replayed onto the new file. Raw edits replace the whole file: check the diff before applying.</Text> : null}
      {view === "form" ? <FormFields text={text} onOp={change} /> : (
        <Textarea mt="4" fontFamily="mono" rows={28} spellCheck={false} aria-label="archangel.yaml" value={text} onChange={(e) => { const v = e.target.value; setOps([() => v]); setPreview(null); setConfirm(false); setDone(null); }} />
      )}
      <Flex gap="2" mt="4">
        <Button size="sm" onClick={() => void runPreview()} disabled={busy || !dirty}>Preview changes</Button>
        {dirty ? <Button size="sm" variant="outline" onClick={() => { setOps([]); setPreview(null); setError(null); }}>Discard edits</Button> : null}
      </Flex>
      {preview ? <PreviewPanel preview={preview} confirm={confirm} onConfirm={setConfirm} onApply={() => void runApply()} busy={busy} blocked={blocked} /> : null}
    </Box>
  );
}
