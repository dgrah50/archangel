import { Box, Button, Flex, Input, NativeSelect, Switch, Text } from "@chakra-ui/react";
import { useState, type ReactNode } from "react";
import { Account, AccountsPanel, useAccounts } from "./AccountsPanel";
import { HostDraftBlock, HostErrorNotice, Problem, RawFile, SavedBlock, useHostDraft, type HostDraft } from "./HostConfigEditor";
import { PROVIDERS, VENDOR, WRITER_CHAINS, addAccount, addChainEntry, removeAccount, setAccountField, checkIndependence, editField, moveChainEntry, readForm, removeChainEntry, setChainEntry, type ChainEntry, type HostForm, type Provider } from "./host-edit";
import SegmentedControl from "./arc/segmented-control/segmented-control";
import { Badge } from "./arc/badge/badge";
import { Skeleton } from "./arc/skeleton/skeleton";
import { CopyCommand, Issues, Page, PageHeadline } from "./page";
import { PrStatusCard, PreviewView, StaleNotice, isStale } from "./WorkflowEditor";
import { fromForm, propose, proposingEnabled, toForm, type PreviewResult } from "./workflow-draft";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { WorkflowsState } from "../../src/core/ui-state.js";
import type { Workflow } from "../../src/core/workflow.js";
import type { Feed } from "./AppView";

const RESTART = "Applies after the daemon restarts";
const RESTART_COMMAND = "archangel daemon restart";

export type SettingsScope = "machine" | "repo" | "kernel" | "raw";
const SCOPES: Array<{ scope: SettingsScope; label: string; hash: string }> = [
  { scope: "machine", label: "This machine", hash: "#/settings" },
  { scope: "repo", label: "Per repo", hash: "#/settings/repo" },
  { scope: "kernel", label: "Built in", hash: "#/settings/kernel" },
  { scope: "raw", label: "Raw file", hash: "#/settings/raw" },
];

const SUB: Record<SettingsScope, string> = {
  machine: "Saved to archangel.yaml. Changes take effect after the daemon restarts.",
  raw: "Saved to archangel.yaml. Changes take effect after the daemon restarts.",
  repo: "Each repo's own rules live in its workflow file. Changes open a pull request that you merge.",
  kernel: "Built in, cannot change. No config file, repo or dashboard can change these.",
};

function Tabs({ scope }: { scope: SettingsScope }) {
  return <SegmentedControl label="Settings scope" value={scope} onValueChange={(v) => (window.location.hash = SCOPES.find((x) => x.scope === v)!.hash)} options={SCOPES.map((x) => ({ value: x.scope, label: x.label }))} />;
}

/** One settings section: its name and when it applies on the left, its rows on the right, a hairline above. */
function Block({ title, applies, children }: { title: string; applies: string; children: ReactNode }) {
  return (
    <Flex as="section" gap="6" py="5" direction={{ base: "column", md: "row" }} borderTopWidth="1px" borderTopColor="border" _first={{ borderTopWidth: "0" }}>
      <Flex direction="column" gap="1" w={{ md: "139px" }} flexShrink={0}>
        <Text as="h2" textStyle="figure">{title}</Text>
        <Text textStyle="caption" color="fg.subtle">{applies}</Text>
      </Flex>
      <Flex direction="column" flex="1" minW="0" gap="3">
        {children}
      </Flex>
    </Flex>
  );
}

const unsentOutline = { borderColor: "unsent", boxShadow: "0 0 0 1px var(--chakra-colors-unsent)" };

function NumberField({ label, value, base, onCommit, min, prefix = "" }: { label: string; value: number | null; base: number | null; onCommit: (n: number) => void; min?: number; prefix?: string }) {
  const changed = value !== base;
  return (
    <Flex direction="column" gap="1.5" flex="1" minW="130px">
      <Text textStyle="body13" color="fg.muted">{label}</Text>
      <Box position="relative">
        <Input
          key={String(value)}
          type="number"
          h="36px"
          borderRadius="10px"
          textStyle="label"
          min={min}
          defaultValue={value ?? ""}
          aria-label={label}
          {...(changed ? unsentOutline : {})}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n) && n !== value) onCommit(n);
          }}
        />
        {changed && base !== null ? <Text position="absolute" right="12px" top="9px" textStyle="meta" color="fg.subtle" textDecoration="line-through" pointerEvents="none">{prefix}{base}</Text> : null}
      </Box>
    </Flex>
  );
}

type Op = (text: string) => string;

function Chip({ e, selected, changed, onClick }: { e: ChainEntry; selected: boolean; changed: boolean; onClick: () => void }) {
  return (
    <Box as="button" onClick={onClick} aria-pressed={selected} h="30px" px="13px" rounded="15px" borderWidth="1px" {...(changed && !selected ? unsentOutline : { borderColor: selected ? "fg" : "border.emphasized" })} bg="bg" color="fg" textStyle="body13" fontSize="14px" whiteSpace="nowrap">
      <Box as="span" fontWeight="500">{e.provider}</Box>
      {e.model ? <Box as="span" color="fg.subtle"> {e.model}</Box> : null}
    </Box>
  );
}

/** A chain as ordered chips. Click a chip to change its provider or model, move it, or remove it. */
function ChainRow({ label, chain, base, path, onOp, backup }: { label: string; chain: ChainEntry[]; base: ChainEntry[]; path: string[]; onOp: (op: Op) => void; backup?: boolean }) {
  const [sel, setSel] = useState<number | null>(null);
  const changed = JSON.stringify(chain) !== JSON.stringify(base);
  const e = sel !== null ? chain[sel] : undefined;
  const sep = (i: number) => (!backup ? "then" : i === 1 ? "and" : "backup");
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="3" wrap="wrap" minH="40px">
        <Text textStyle="body13" fontSize="14px" color="fg.muted" w="56px" flexShrink={0}>{label}</Text>
        {chain.map((c, i) => (
          <Flex key={`${i}-${c.provider}-${c.model ?? ""}`} align="center" gap="3">
            {i > 0 ? <Text textStyle="body13" fontSize="14px" color="fg.muted">{sep(i)}</Text> : null}
            <Chip e={c} selected={sel === i} changed={changed} onClick={() => setSel(sel === i ? null : i)} />
          </Flex>
        ))}
        <Button variant="plain" size="xs" h="auto" minW="0" p="0" color="fg.subtle" fontWeight="400" aria-label={`Add to ${label} models`} onClick={() => { onOp((t) => addChainEntry(t, path, "claude")); setSel(chain.length); }}>+ add</Button>
      </Flex>
      {e && sel !== null ? (
        <Flex gap="2" wrap="wrap" align="center" ml={{ md: "68px" }}>
          <NativeSelect.Root size="sm" w="8rem">
            <NativeSelect.Field aria-label={`${label} entry ${sel + 1} provider`} value={e.provider} onChange={(ev) => onOp((t) => setChainEntry(t, path, sel, { ...e, provider: ev.target.value as Provider }))}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Input size="sm" w="14rem" placeholder="model (optional)" aria-label={`${label} entry ${sel + 1} model`} defaultValue={e.model ?? ""} onBlur={(ev) => { if (ev.target.value !== (e.model ?? "")) onOp((t) => setChainEntry(t, path, sel, { provider: e.provider, ...(ev.target.value ? { model: ev.target.value } : {}) })); }} />
          <Button size="2xs" variant="outline" aria-label="Move earlier" disabled={sel === 0} onClick={() => { onOp((t) => moveChainEntry(t, path, sel, -1)); setSel(sel - 1); }}>Earlier</Button>
          <Button size="2xs" variant="outline" aria-label="Move later" disabled={sel === chain.length - 1} onClick={() => { onOp((t) => moveChainEntry(t, path, sel, 1)); setSel(sel + 1); }}>Later</Button>
          <Button size="2xs" variant="outline" aria-label="Remove" disabled={chain.length <= 1} onClick={() => { onOp((t) => removeChainEntry(t, path, sel)); setSel(null); }}>Remove</Button>
        </Flex>
      ) : null}
    </Flex>
  );
}

const providerOf = (v: string) => PROVIDERS.find((p) => VENDOR[p] === v) ?? v;

/** The live sentence about reviewer independence (ADR-0003), computed from the unsaved text. */
function Independence({ f }: { f: HostForm }) {
  const ind = checkIndependence(f);
  if (ind.problems.length > 0) {
    return (
      <Box role="alert" color="owner" textStyle="body13" ml={{ md: "68px" }}>
        <Text textStyle="label">Reviewers are not independent of the writers.</Text>
        {ind.problems.map((p) => <Text key={p}>{p}</Text>)}
      </Box>
    );
  }
  if (f.authMode === "api") return <Text textStyle="body13" color="fg.muted" ml={{ md: "68px" }}>In api mode the reviewers are fixed, so there is nothing to check here.</Text>;
  return (
    <Flex direction="column" gap="0.5" ml={{ md: "68px" }}>
      {ind.writers.map((w) => {
        const from = ind.reviewers.filter((v) => v !== w).slice(0, 2).map(providerOf);
        return (
          <Flex key={w} gap="2" align="baseline" color="passed" textStyle="body13" fontSize="14px">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <Text>With {providerOf(w)} building, reviews come from {from.join(" and ")}: two vendors that did not write the fix.</Text>
          </Flex>
        );
      })}
    </Flex>
  );
}

function Models({ f, b, onOp }: { f: HostForm; b: HostForm; onOp: (op: Op) => void }) {
  return (
    <Block title="Models" applies={RESTART}>
      {WRITER_CHAINS.map((r) => <ChainRow key={r} label={r === "implement" ? "Build" : `${r[0]!.toUpperCase()}${r.slice(1)}`} chain={f.chains[r]} base={b.chains[r]} path={["chains", r]} onOp={onOp} />)}
      <ChainRow label="Review" chain={f.reviewerChain} base={b.reviewerChain} path={["reviewerChain"]} onOp={onOp} backup />
      <Independence f={f} />
      <Flex align="center" gap="3" wrap="wrap">
        <Text textStyle="body13" fontSize="14px" color="fg.muted" w="56px" flexShrink={0}>Sign-in</Text>
        <NativeSelect.Root size="sm" w="12rem">
          <NativeSelect.Field aria-label="Auth mode" value={f.authMode} {...(f.authMode !== b.authMode ? unsentOutline : {})} onChange={(e) => onOp((t) => editField(t, ["authMode"], e.target.value))}>
            <option value="subscription">subscription</option>
            <option value="api">api</option>
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
        <Text textStyle="meta" color="fg.subtle">Subscription uses each CLI's own login. Api uses metered keys.</Text>
      </Flex>
    </Block>
  );
}

function Limits({ f, b, onOp }: { f: HostForm; b: HostForm; onOp: (op: Op) => void }) {
  const set = (key: string) => (n: number) => onOp((t) => editField(t, [key], n));
  return (
    <Block title="Limits" applies={RESTART}>
      <Flex gap="4" wrap="wrap">
        <NumberField label="Spend per day" prefix="$" value={f.maxDailyUsd} base={b.maxDailyUsd} min={1} onCommit={set("maxDailyUsd")} />
        <NumberField label="Steps without you" value={f.maxAutonomousStepsWithoutOwner} base={b.maxAutonomousStepsWithoutOwner} min={1} onCommit={set("maxAutonomousStepsWithoutOwner")} />
        <NumberField label="Attempts per Thread" value={f.maxImplementAttemptsPerThread} base={b.maxImplementAttemptsPerThread} min={1} onCommit={set("maxImplementAttemptsPerThread")} />
      </Flex>
      <Flex gap="4" wrap="wrap">
        <NumberField label="Revisions per Thread" value={f.maxRevisionsPerThread} base={b.maxRevisionsPerThread} min={0} onCommit={set("maxRevisionsPerThread")} />
        <NumberField label="Rebases per Thread" value={f.maxRebasesPerThread} base={b.maxRebasesPerThread} min={0} onCommit={set("maxRebasesPerThread")} />
        <Box flex="1" minW="130px" display={{ base: "none", md: "block" }} />
      </Flex>
    </Block>
  );
}

type Landing = Workflow["landing"]["bugfix"];
/** A landing switch the owner flipped. It pins the workflow file it started from, like the Pipeline editor does. */
interface Flip {
  to: Landing;
  sha: string;
  draft: Workflow;
}

function Repos({ s, wf, flips, onFlip }: { s: Extract<SettingsState["host"], { state: "ok" }>; wf: Feed<WorkflowsState>; flips: Record<string, Flip>; onFlip: (repo: string, to: Landing) => void }) {
  const canPropose = proposingEnabled();
  return (
    <Block title="Repos" applies="Landing applies after its pull request merges">
      <Flex direction="column" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
        {s.config.projects.map((p) => {
          const r = wf.data?.repos.find((x) => x.repo === p.repo);
          const own = r?.status === "ok" && r.draft && r.fileSha256 ? r.draft.landing.bugfix : null;
          const landing = flips[p.repo]?.to ?? own;
          const scouts = p.scouts.enabled ? "Scouts on." : "Scouts off.";
          const why = !canPropose ? "Editing is disabled on this page (remote mode, or the server has no gh runner)." : own === null ? (wf.error ? `The workflow could not be loaded (${wf.error}).` : r ? `This repo's workflow is ${r.status}, so landing cannot change here.` : "The workflow has not loaded yet.") : null;
          return (
            <Flex key={p.repo} gap="4" align="center" py="3" wrap="wrap">
              <Text textStyle="command" fontSize="13px" w="170px" flexShrink={0}>{p.repo}</Text>
              <Flex direction="column" flex="1" minW="220px">
                <Text textStyle="body13" fontSize="14px">
                  {p.shadowMode ? 'Shadow mode: it says "would merge" and you merge.' : landing === "autonomous" ? `Bug fixes may merge on their own, up to ${p.maxAutoMergesPerDay} a day.` : "You merge every fix."} {scouts}
                </Text>
                {p.shadowMode && landing === "autonomous" ? <Text textStyle="meta" color="fg.subtle">Landing is already on, for when shadow mode ends.</Text> : null}
                {why ? <Text textStyle="meta" color="fg.subtle">{why}</Text> : null}
              </Flex>
              <Switch.Root checked={landing === "autonomous"} disabled={why !== null} onCheckedChange={(e) => onFlip(p.repo, e.checked ? "autonomous" : "owner")}>
                <Switch.HiddenInput aria-label={`Let bug fixes land on their own in ${p.repo}`} />
                <Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch.Root>
            </Flex>
          );
        })}
      </Flex>
    </Block>
  );
}

/** A flipped landing switch is repo policy: it becomes a workflow draft that goes through the propose route as a PR, never a direct write. */
function RepoPolicyDraft({ repo, flip, currentSha, onDiscard }: { repo: string; flip: Flip; currentSha: string | null; onDiscard: () => void }) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stale = currentSha !== null && isStale(flip.sha, currentSha);
  const looser = flip.to === "autonomous";
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const out = await propose(repo, fromForm({ ...toForm(flip.draft), landing: flip.to }, flip.draft), flip.sha, dryRun);
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
  return (
    <Flex direction="column" gap="2" borderTopWidth="1px" borderTopColor="border" pt="2.5" aria-label={`repo policy ${repo}`}>
      <Flex justify="space-between" gap="3">
        <Text textStyle="label" fontSize="14px">{repo.split("/").pop()}: bug fixes {looser ? "may land on their own" : "wait for you to merge"}</Text>
        <Badge size="sm" tone={looser ? "warning" : "neutral"}>{looser ? "Looser" : "Stricter"}</Badge>
      </Flex>
      <Text textStyle="body13" color="fg.muted">This is repo policy, so it opens a pull request that you merge. Nothing is written until you do.</Text>
      {stale ? <StaleNotice onReload={onDiscard} /> : null}
      <Flex gap="2">
        <Button size="sm" borderRadius="12px" disabled={busy || stale || url !== null} onClick={() => void run(true)}>Preview the PR</Button>
        <Button size="sm" borderRadius="12px" disabled={busy || stale || url !== null || preview === null || preview.changes.length === 0} onClick={() => void run(false)}>Open the PR</Button>
        <Button size="sm" variant="outline" borderRadius="12px" onClick={onDiscard}>Discard</Button>
      </Flex>
      {message ? <Text role="alert" textStyle="meta" color="owner">{message}</Text> : null}
      {preview ? <PreviewView preview={preview} /> : null}
      {url ? <Text textStyle="body13">Opened <Text as="span" textStyle="command">{url}</Text>. It is not merged; review it on GitHub.</Text> : null}
      {url ? <PrStatusCard repo={repo} url={url} /> : null}
    </Flex>
  );
}

const city = (tz: string) => `${tz.split("/").pop()!.replace(/_/g, " ")} time`;

function Alerts({ s, f, b, onOp }: { s: SettingsState; f: HostForm; b: HostForm; onOp: (op: Op) => void }) {
  const env = s.status.reported ? s.status.envPresence : null;
  const tg = env ? [env.ARCHANGEL_TELEGRAM_BOT_TOKEN, env.ARCHANGEL_TELEGRAM_CHAT_ID] : null;
  const telegram = !tg ? "Telegram status is unknown until the daemon reports." : tg[0] && tg[1] ? "Telegram is connected." : !tg[0] && !tg[1] ? "Telegram is not set up." : "Telegram is half set up: it needs both the bot token and the chat id.";
  const hh = String(f.digestHour).padStart(2, "0");
  return (
    <Block title="Alerts" applies={RESTART}>
      <Flex gap="6" justify="space-between" wrap="wrap" align="flex-start">
        <Text textStyle="body13" fontSize="14px" maxW="26rem">{telegram} A digest goes out at {hh}:00, {city(f.dailyTimezone)}.</Text>
        <Text textStyle="meta" color="fg.subtle">Secrets stay in .env and are never shown here.</Text>
      </Flex>
      <Flex gap="4" wrap="wrap">
        <NumberField label="Digest hour (0-23)" value={f.digestHour} base={b.digestHour} min={0} onCommit={(n) => onOp((t) => editField(t, ["digestHour"], n))} />
        <Flex direction="column" gap="1.5" flex="2" minW="200px">
          <Text textStyle="body13" color="fg.muted">Timezone</Text>
          <Input key={f.dailyTimezone} h="36px" borderRadius="10px" textStyle="label" aria-label="Timezone" defaultValue={f.dailyTimezone} {...(f.dailyTimezone !== b.dailyTimezone ? unsentOutline : {})} onBlur={(e) => { if (e.target.value && e.target.value !== f.dailyTimezone) onOp((t) => editField(t, ["dailyTimezone"], e.target.value)); }} />
        </Flex>
      </Flex>
      <Box as="details">
        <Box as="summary" cursor="pointer" textStyle="meta" color="fg.muted">Environment names the daemon saw</Box>
        <Text textStyle="meta" color="fg.subtle" mt="1">{env ? "Presence as the daemon saw it when it started. Values are never shown." : "The daemon has not reported its environment yet (restart it on this version). Presence is unknown, not unset."}</Text>
        <Flex direction="column" mt="1">
          {s.env.map((e) => (
            <Flex key={e.name} gap="3" py="1" textStyle="meta">
              <Text textStyle="ref" w="16rem">{e.name}</Text>
              <Text color="fg.muted" flex="1">{e.feature}</Text>
              <Text color="fg.muted">{e.set === null ? "unknown" : e.set ? "set" : "unset"}</Text>
            </Flex>
          ))}
        </Flex>
      </Box>
    </Block>
  );
}

/** The accounts in archangel.yaml: each one's live state from the Ledger, with its home and daily cap to edit, plus add and remove. Like every edit here it waits for preview and save. */
function AccountsEditor({ f, b, onOp }: { f: HostForm; b: HostForm; onOp: (op: Op) => void }) {
  const live = useAccounts();
  const [id, setId] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  const slug = /^[a-z0-9][a-z0-9-]{0,30}$/.test(id) && !f.accounts.some((a) => a.id === id);
  const field = { h: "36px", borderRadius: "10px", textStyle: "label" } as const;
  // Anything but a clean read (no token, load failure, unreadable config) is the panel's to explain.
  if (!live.data || live.data.state !== "ok" || live.error) return <AccountsPanel />;
  const rows = live.data.accounts;
  return (
    <Flex direction="column" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
      {live.data.warnings.map((w) => <Text key={w} role="alert" textStyle="body13" py="2.5">{w}</Text>)}
      {f.accounts.map((a, i) => {
        const was = b.accounts.find((x) => x.id === a.id);
        const row = rows.find((x) => x.id === a.id);
        return (
          <Flex key={a.id} direction="column" pb="3">
            {row ? <Account a={row} /> : (
              <Flex gap="4" align="baseline" py="2.5">
                <Text textStyle="command" fontSize="13px" w="120px" flexShrink={0} color="unsent">{a.id}</Text>
                <Text textStyle="body13" color="fg.muted">New {a.provider} account, not saved yet. Log in with that CLI before the daemon uses it.</Text>
              </Flex>
            )}
            <Flex gap="3" align="center">
              <Input key={`home-${a.id}-${a.home ?? ""}`} {...field} flex="1" minW="0" placeholder="Home folder (CLI default)" aria-label={`${a.id} home folder`} defaultValue={a.home ?? ""} {...(was && (was.home ?? "") !== (a.home ?? "") ? unsentOutline : {})} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (a.home ?? "")) onOp((t) => setAccountField(t, i, "home", v === "" ? undefined : v)); }} />
              <Input key={`cap-${a.id}-${a.maxAttemptsPerDay ?? ""}`} {...field} w="140px" flexShrink={0} type="number" min={1} placeholder="Daily cap (none)" aria-label={`${a.id} attempts a day`} defaultValue={a.maxAttemptsPerDay ?? ""} {...(was && was.maxAttemptsPerDay !== a.maxAttemptsPerDay ? unsentOutline : {})} onBlur={(e) => { const n = e.target.value === "" ? undefined : Number(e.target.value); if (n !== a.maxAttemptsPerDay && (n === undefined || (Number.isInteger(n) && n >= 1))) onOp((t) => setAccountField(t, i, "maxAttemptsPerDay", n)); }} />
              <Button size="sm" variant="outline" borderRadius="10px" h="36px" flexShrink={0} aria-label={`Remove ${a.id}`} disabled={f.accounts.length <= 1} onClick={() => onOp((t) => removeAccount(t, i))}>Remove</Button>
            </Flex>
          </Flex>
        );
      })}
      <Flex direction="column" gap="2" py="3">
        <Text textStyle="meta" color="fg.subtle">One account is one login of a CLI. A second login of the same CLI needs its own home folder. The login itself happens in that CLI, never here.</Text>
        <Flex gap="3" align="center">
          <Input {...field} flex="1" minW="0" placeholder="New account name" aria-label="New account name" value={id} onChange={(e) => setId(e.target.value)} />
          <NativeSelect.Root size="sm" w="140px" flexShrink={0}>
            <NativeSelect.Field h="36px" borderRadius="10px" aria-label="New account CLI" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Button size="sm" borderRadius="10px" h="36px" flexShrink={0} disabled={!slug} onClick={() => { onOp((t) => addAccount(t, { id, provider })); setId(""); }}>Add account</Button>
        </Flex>
        {id !== "" && !slug ? <Text textStyle="meta" color="owner">Use a new name in lowercase letters, digits and dashes.</Text> : null}
      </Flex>
    </Flex>
  );
}

function Owner({ f, b, onOp }: { f: HostForm; b: HostForm; onOp: (op: Op) => void }) {
  return (
    <Flex gap="4" align="flex-end" wrap="wrap" pt="3" borderTopWidth="1px" borderTopColor="border">
      <NumberField label="Owner user id" value={f.ownerUserId} base={b.ownerUserId} min={1} onCommit={(n) => onOp((t) => editField(t, ["ownerUserId"], n))} />
      <Text textStyle="meta" color="fg.subtle" flex="2" minW="200px" pb="3">The GitHub user whose word counts as the owner's. {RESTART}.</Text>
    </Flex>
  );
}

function Kernel({ s }: { s: SettingsState }) {
  const k = s.kernel;
  const rows: Array<[string, string]> = [
    ["Gate bounds (maxima)", `${k.maxNonTestLines} non-test lines, ${k.maxTotalLines} total, ${k.maxFiles} files`],
    ["Test runs (minimums)", `base ${k.minBaseTestRuns}, head ${k.minHeadTestRuns}`],
    ["Required check", k.gateCheck],
    ["Review quorum", `${k.reviewQuorum} independent vendors, never the implementer's`],
    ["Max Scouts per repo", String(k.maxScouts)],
    ["Always protected paths", k.universalProtected.join(", ")],
  ];
  return (
    <Flex direction="column" bg="bg.panel" borderWidth="1px" borderColor="border" rounded="surface" px="5" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
      {rows.map(([k2, v]) => (
        <Flex key={k2} gap="6" py="3.5" direction={{ base: "column", md: "row" }}>
          <Text textStyle="label" fontSize="14px" w="14rem" flexShrink={0}>{k2}</Text>
          <Text textStyle="body13" fontSize="14px" color="fg.muted" wordBreak="break-word">{v}</Text>
        </Flex>
      ))}
    </Flex>
  );
}

/** The right column: the unsaved host change, the unsent repo-policy changes, and what is saved but waiting for a restart. */
function SidePanel({ s, draft, flips, wf, onDiscardFlip }: { s: SettingsState | null; draft: HostDraft; flips: Record<string, Flip>; wf: Feed<WorkflowsState>; onDiscardFlip: (repo: string) => void }) {
  const pending = s?.status.restartPending === true;
  const loadedAt = s?.status.loadedAt ?? null;
  return (
    <Flex direction="column" gap="5" w={{ lg: "340px" }} flexShrink={0}>
      <HostDraftBlock draft={draft} />
      {Object.keys(flips).length > 0 ? (
        <Flex direction="column" gap="2.5">
          <Text textStyle="label" fontSize="14px">Repo policy, goes through a pull request</Text>
          {Object.entries(flips).map(([repo, flip]) => (
            <RepoPolicyDraft key={repo} repo={repo} flip={flip} currentSha={wf.data?.repos.find((r) => r.repo === repo)?.fileSha256 ?? null} onDiscard={() => onDiscardFlip(repo)} />
          ))}
        </Flex>
      ) : null}
      {pending || draft.done ? (
        <SavedBlock done={draft.done}>
          <Text textStyle="body13" color="fg.muted">{pending ? `The file on disk differs from what the daemon loaded${loadedAt ? ` at ${new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. Those changes wait for a restart.` : "Restart the daemon to apply it."}</Text>
          <CopyCommand command={RESTART_COMMAND} />
        </SavedBlock>
      ) : null}
    </Flex>
  );
}

function Machine({ s, draft, wf, flips, onFlip }: { s: SettingsState; draft: HostDraft; wf: Feed<WorkflowsState>; flips: Record<string, Flip>; onFlip: (repo: string, to: Landing) => void }) {
  if (s.host.state !== "ok") {
    const missing = s.host.state === "missing";
    return (
      <Problem title={missing ? "No archangel.yaml." : s.host.state === "invalid" ? "archangel.yaml is invalid." : "archangel.yaml could not be read."}>
        {missing ? <Text textStyle="meta" color="fg.muted">{s.host.error}</Text> : <Issues text={s.host.error} />}
        {missing ? <Text textStyle="meta" color="fg.muted" mt="1">Copy archangel.example.yaml to archangel.yaml and edit it, or write it on the Raw file tab.</Text> : <Text textStyle="meta" color="fg.muted" mt="1">Fix it on the Raw file tab.</Text>}
      </Problem>
    );
  }
  const f = readForm(draft.text);
  const b = readForm(draft.base ?? "");
  if (draft.loadError) return <LoadFailed draft={draft} />;
  if (!draft.read) return <Skeleton label="Loading archangel.yaml" lines={4} />;
  if (!f || !b) return <Text role="alert" textStyle="body13" color="owner">The text on the Raw file tab does not parse as YAML, so the form cannot show it. Fix it there first.</Text>;
  return (
    <Flex direction="column" bg="bg.panel" borderWidth="1px" borderColor="border" rounded="surface" px="5">
      <Models f={f} b={b} onOp={draft.change} />
      <Block title="Accounts" applies="Live state from the Ledger; edits apply after the daemon restarts">
        <AccountsEditor f={f} b={b} onOp={draft.change} />
        <Owner f={f} b={b} onOp={draft.change} />
      </Block>
      <Limits f={f} b={b} onOp={draft.change} />
      <Repos s={s.host} wf={wf} flips={flips} onFlip={onFlip} />
      <Alerts s={s} f={f} b={b} onOp={draft.change} />
    </Flex>
  );
}

function LoadFailed({ draft }: { draft: HostDraft }) {
  return (
    <>
      <HostErrorNotice error={draft.loadError!} onReload={() => void draft.reload(true)} />
      <Button size="xs" variant="outline" borderRadius="10px" mt="2" onClick={() => void draft.reload(false)}>Retry</Button>
    </>
  );
}

export function SettingsPage({ scope, settings, workflows, onRetry, children }: { scope: SettingsScope; settings: Feed<SettingsState>; workflows: Feed<WorkflowsState>; onRetry: () => void; children?: ReactNode }) {
  const draft = useHostDraft(onRetry);
  const [flips, setFlips] = useState<Record<string, Flip>>({});
  const onFlip = (repo: string, to: Landing) => {
    const r = workflows.data?.repos.find((x) => x.repo === repo);
    if (!r?.draft || !r.fileSha256) return;
    setFlips((m) => {
      const { [repo]: _drop, ...rest } = m;
      return r.draft!.landing.bugfix === to ? rest : { ...rest, [repo]: { to, sha: r.fileSha256!, draft: r.draft! } };
    });
  };
  const discardFlip = (repo: string) => setFlips(({ [repo]: _drop, ...rest }) => rest);

  const s = settings.data;
  const unavailable =
    s === null ? (
      settings.error ? (
        <Problem title="Settings unavailable.">
          <Text textStyle="meta" color="fg.muted">{settings.error}</Text>
          <Button size="xs" variant="outline" borderRadius="10px" mt="2" onClick={onRetry}>Retry</Button>
        </Problem>
      ) : (
        <Skeleton label="Loading settings" lines={4} />
      )
    ) : null;
  const stale = s && settings.error ? <Problem title={`Refresh failed (${settings.error}); showing the last loaded copy.`} /> : null;

  const wide = scope === "repo" || scope === "kernel";
  return (
    <Page>
      <PageHeadline title="Settings" right={<Tabs scope={scope} />}>{SUB[scope]}</PageHeadline>
      <Flex direction={{ base: "column", lg: "row" }} gap="48px" flex="1">
        <Box flex="1" minW="0">
          {scope === "repo" ? (
            children
          ) : scope === "raw" ? (
            draft.loadError ? <LoadFailed draft={draft} /> : draft.read ? <RawFile draft={draft} /> : <Skeleton label="Loading archangel.yaml" lines={4} />
          ) : unavailable ? (
            unavailable
          ) : scope === "kernel" ? (
            <Kernel s={s!} />
          ) : (
            <>
              {stale}
              <Machine s={s!} draft={draft} wf={workflows} flips={flips} onFlip={onFlip} />
            </>
          )}
        </Box>
        {wide ? null : <SidePanel s={s} draft={draft} flips={flips} wf={workflows} onDiscardFlip={discardFlip} />}
      </Flex>
    </Page>
  );
}
