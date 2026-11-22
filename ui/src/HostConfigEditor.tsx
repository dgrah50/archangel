import { Box, Button, Checkbox, Code, Flex, Text, Textarea } from "@chakra-ui/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ApplyResult, HostConfigRead, PreviewResult } from "../../src/core/ui-host-config.js";
import { applyHostConfig, loadHostConfig, previewHostConfig, type HostError } from "./host-config-client";
import { checkIndependence, hostChanges, readForm, type HostChange } from "./host-edit";

const STARTER = "ownerUserId: 1\nprojects:\n  - repo: owner/name\n";

const TITLE: Record<HostError["kind"], string> = {
  conflict: "archangel.yaml changed on disk since you loaded it.",
  stale_plan: "The plan or preview expired or no longer matches. Nothing was changed: plan or preview it again.",
  validation: "The change was rejected.",
  forbidden: "Editing is disabled for this dashboard (remote mode, or not wired). Nothing was changed.",
  unauthorized: "This page has no valid token, so it cannot edit. Reload the page from the local dashboard.",
  schema_behind: "The Ledger schema is behind. Restart the daemon so it can migrate, then try again.",
  network: "Could not reach the dashboard server.",
  error: "The request failed.",
};

/** A problem: a hairline rule and plain text, no box. Used for every failure state on the Settings page. */
export function Problem({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <Box role="alert" borderTopWidth="1px" borderTopColor="red.solid" pt="2" mt="4">
      <Text textStyle="label" color="red.fg">{title}</Text>
      {children}
    </Box>
  );
}

/** Every failure kind of the host-config client has its own visible state. */
export function HostErrorNotice({ error, onReload }: { error: HostError; onReload: () => void }) {
  return (
    <Problem title={TITLE[error.kind]}>
      <Text textStyle="meta" color="fg.muted">{error.message}</Text>
      {error.kind === "conflict" ? <Button size="xs" variant="outline" borderRadius="10px" mt="2" onClick={onReload}>Reload the file and reapply my edits</Button> : null}
    </Problem>
  );
}

export function PreviewPanel({ preview, confirm, onConfirm, onApply, busy, blocked }: { preview: PreviewResult; confirm: boolean; onConfirm: (v: boolean) => void; onApply: () => void; busy: boolean; blocked: string | null }) {
  const loosens = preview.loosening.length > 0;
  return (
    <Flex direction="column" gap="2" borderTopWidth="1px" borderTopColor="border" pt="3" mt="3">
      <Text textStyle="label">The file change</Text>
      {!preview.valid ? (
        <Box role="alert" textStyle="meta" color="red.fg">
          <Text textStyle="label">archangel.yaml would be invalid:</Text>
          {preview.errors.map((e) => <Text key={e}>{e}</Text>)}
        </Box>
      ) : null}
      {preview.warnings.map((w) => <Text key={w} textStyle="meta" color="fg.muted">Warning: {w}</Text>)}
      <Code as="pre" display="block" whiteSpace="pre-wrap" textStyle="command" p="2" maxH="20rem" overflow="auto" bg="bg.subtle" rounded="10px">{preview.diff || "(no changes)"}</Code>
      {preview.valid ? (
        <>
          {loosens ? (
            <Flex direction="column" gap="1" textStyle="meta">
              <Text textStyle="label" color="owner">This gives the factory more room:</Text>
              {preview.loosening.map((l) => <Text key={l} color="owner">{l}</Text>)}
              <Checkbox.Root mt="1" checked={confirm} onCheckedChange={(e) => onConfirm(e.checked === true)}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label textStyle="body13">I understand and want to loosen these</Checkbox.Label>
              </Checkbox.Root>
            </Flex>
          ) : null}
          {blocked ? <Text textStyle="meta" color="red.fg">{blocked}</Text> : null}
          <Flex><Button size="sm" borderRadius="12px" onClick={onApply} disabled={busy || blocked !== null || (loosens && !confirm)}>Save to file</Button></Flex>
        </>
      ) : null}
    </Flex>
  );
}

type Op = (text: string) => string;

/** The text is the single draft; the form edits it through YAML Document operations that are replayed if the file changes under us. */
export function useHostDraft(onSaved: () => void) {
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

  const edited = () => { setPreview(null); setConfirm(false); setDone(null); };
  const change = (op: Op) => { setOps((o) => [...o, op]); edited(); };
  const setRaw = (v: string) => { setOps([() => v]); edited(); };
  const discard = () => { setOps([]); setPreview(null); setConfirm(false); setError(null); };
  const blocked = (() => { const f = readForm(text); return f && checkIndependence(f).problems.length > 0 ? "Fix the reviewer independence problem before saving." : null; })();

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
    setConfirm(false);
    await reload(false);
    onSaved();
  };

  return { read, base, text, dirty, loadError, error, preview, confirm, setConfirm, busy, done, blocked, change, setRaw, discard, reload, runPreview, runApply };
}
export type HostDraft = ReturnType<typeof useHostDraft>;

const direction = (c: HostChange) => (c.direction === "looser" ? "Looser" : c.direction === "stricter" ? "Stricter" : null);

/** The unsaved host-file change: what differs, the guarded preview, and the save (a second confirmation when it loosens). */
export function HostDraftBlock({ draft: d }: { draft: HostDraft }) {
  const changes = hostChanges(d.base ?? "", d.text);
  const n = changes.length;
  return (
    <Flex direction="column" gap="2.5" borderTopWidth="1px" borderTopColor="fg" pt="3">
      <Text textStyle="figure" fontSize="20px" lineHeight="26px" color="fg">
        {d.dirty ? (n === 0 ? "Raw edits, not saved yet" : `${n} change${n === 1 ? "" : "s"}, not saved yet`) : "Nothing unsaved"}
      </Text>
      <Text textStyle="body13" color="fg.muted">
        {d.dirty ? "Saving writes the file. The daemon keeps its old settings until it restarts." : "Edits you make here wait for you to preview and save them."}
      </Text>
      {d.error ? <HostErrorNotice error={d.error} onReload={() => void d.reload(true)} /> : null}
      {d.error?.kind === "conflict" ? <Text textStyle="meta" color="fg.muted">Form edits are replayed onto the new file. Raw edits replace the whole file: check the diff before saving.</Text> : null}
      {changes.map((c) => (
        <Flex key={c.key} direction="column" gap="1" borderTopWidth="1px" borderTopColor="border" pt="2.5">
          <Flex justify="space-between" gap="3">
            <Text textStyle="label" fontSize="14px">{c.label} {c.from} to {c.to}</Text>
            {direction(c) ? <Text textStyle="body13" color={c.direction === "looser" ? "owner" : "fg.muted"} flexShrink={0}>{direction(c)}</Text> : null}
          </Flex>
          {c.direction === "looser" ? <Text textStyle="body13" color="owner">This gives the factory more room, so saving asks you to confirm a second time.</Text> : null}
        </Flex>
      ))}
      {d.dirty ? (
        <>
          <Flex gap="2" borderTopWidth="1px" borderTopColor="border" pt="3">
            <Button flex="1" h="40px" borderRadius="12px" onClick={() => void d.runPreview()} disabled={d.busy}>Preview the file change</Button>
            <Button variant="outline" h="40px" borderRadius="12px" onClick={d.discard}>Discard</Button>
          </Flex>
          <Text textStyle="meta" color="fg.subtle">A backup of the old file is kept. Saving here never counts as the factory hearing from you, so it cannot reset the step count.</Text>
        </>
      ) : null}
      {d.preview ? <PreviewPanel preview={d.preview} confirm={d.confirm} onConfirm={d.setConfirm} onApply={() => void d.runApply()} busy={d.busy} blocked={d.blocked} /> : null}
    </Flex>
  );
}

/** Changes that are already in the file and wait for a restart. The dashboard never restarts the daemon: it shows the command. */
export function SavedBlock({ done, children }: { done: ApplyResult | null; children: ReactNode }) {
  return (
    <Flex direction="column" gap="2" role={done ? "status" : undefined}>
      <Text textStyle="label" fontSize="14px">Already saved, waiting for a restart</Text>
      {done ? <Text textStyle="body13" color="fg.muted">Written to <Code>{done.path}</Code>{done.backup ? <>, previous version saved as <Code>{done.backup}</Code></> : null}.</Text> : null}
      {children}
    </Flex>
  );
}

/** The Raw tab: the same draft as the form, edited as text. Raw edits replace the whole file. */
export function RawFile({ draft: d }: { draft: HostDraft }) {
  return (
    <Flex direction="column" gap="2" borderTopWidth="1px" borderTopColor="fg" pt="3" flex="1" minW="0">
      <Flex gap="2" align="center" wrap="wrap">
        <Text textStyle="body13" color="fg.muted">Applies after the daemon restarts.</Text>
        {d.read?.state === "missing" ? <Text textStyle="body13">No archangel.yaml yet: saving creates it.</Text> : <Text textStyle="body13" color="fg.muted">Comments and layout outside your edits are kept.</Text>}
      </Flex>
      {!readForm(d.text) ? <Text role="alert" textStyle="body13" color="red.fg">The text does not parse as YAML. Fix it here before previewing.</Text> : null}
      <Textarea textStyle="command" rows={28} spellCheck={false} aria-label="archangel.yaml" value={d.text} borderColor={d.dirty ? "unsent" : undefined} onChange={(e) => d.setRaw(e.target.value)} />
    </Flex>
  );
}
