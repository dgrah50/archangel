import { STAGES, type UiItem, type UiState } from "./ui-state.js";

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const n = (v: number | null, unit = "") => (v === null ? "n/a" : `${v}${unit}`);

/** Repo slug comes from the Ledger (untrusted): only link when it looks like owner/name. */
const link = (repo: string, kind: "issues" | "pull", num: number, text: string) =>
  /^[\w.-]+\/[\w.-]+$/.test(repo)
    ? `<a href="https://github.com/${esc(repo)}/${kind}/${num}" rel="noreferrer noopener">${esc(text)}</a>`
    : esc(text);

function itemRow(i: UiItem, now: number): string {
  const pr = i.prNumber ? ` (${link(i.repo, "pull", i.prNumber, `PR #${i.prNumber}`)})` : "";
  return `<li>${link(i.repo, "issues", i.issueNumber, `${i.repo}#${i.issueNumber}`)}${pr} ${esc(i.title)} <span class="m">${esc(i.phase)}, ${age(now - i.since)}</span></li>`;
}

/** Static, read-only HTML. Every Ledger-derived string goes through `esc`. */
export function renderPage(s: UiState): string {
  const o = s.outcomes;
  const needs = s.needsYou.length
    ? `<ul>${s.needsYou
        .map(
          (i) =>
            `<li>${link(i.repo, "issues", i.issueNumber, `${i.repo}#${i.issueNumber}`)} ${esc(i.title)} <span class="m">${esc(i.decisionClass)}, waiting ${age(s.generatedAt - i.since)}</span><br>${esc(i.recommendation)}</li>`,
        )
        .join("")}</ul>`
    : "<p class=m>Nothing needs you.</p>";
  const stages = STAGES.map((st) => {
    const items = s.stages[st];
    return `<h3>${esc(st)} (${items.length})</h3>${items.length ? `<ul>${items.map((i) => itemRow(i, s.generatedAt)).join("")}</ul>` : ""}`;
  }).join("");
  const vendors = Object.entries(o.vendorAgreement)
    .map(([v, a]) => `<li>${esc(v)}: ${a.rate === null ? "n/a" : `${Math.round(a.rate * 100)}%`} (${a.undisputed}/${a.approvedMerges})</li>`)
    .join("");
  const steps = Object.entries(s.autonomySteps)
    .map(([r, c]) => `<li>${esc(r)}: ${c} autonomous steps since owner</li>`)
    .join("");
  const scouts = s.scouts.length
    ? `<table><tr><th>Repo</th><th>Issue</th><th>Scout</th><th>Auto-promoted</th><th>Has Thread</th></tr>${s.scouts
        .map(
          (p) =>
            `<tr><td>${esc(p.repo)}</td><td>${link(p.repo, "issues", p.issueNumber, `#${p.issueNumber}`)}</td><td>${esc(p.scoutName)}</td><td>${p.autoPromoted ? "yes" : "no"}</td><td>${p.hasThread ? "yes" : "no"}</td></tr>`,
        )
        .join("")}</table>`
    : "<p class=m>No Scout proposals.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Archangel</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--mu:#666;--bd:#ddd;--ln:#0b57d0}
@media(prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e6e6ea;--mu:#999;--bd:#333;--ln:#8ab4f8}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:60rem;margin:1rem auto;padding:0 1rem}
a{color:var(--ln)}.m{color:var(--mu);font-size:.85em}h2{border-bottom:1px solid var(--bd);margin-top:2rem}
table{border-collapse:collapse}td,th{border:1px solid var(--bd);padding:.2rem .5rem;text-align:left}
</style></head><body>
<h1>Archangel</h1><p class=m>Read-only. Approvals and merges happen on GitHub. Updated ${esc(new Date(s.generatedAt).toISOString())}, refreshes every 15s.</p>
<h2>Needs You</h2>${needs}
<h2>Threads</h2>${stages}
<h2>Outcomes (all time, per merged fix)</h2>
<p>Merged fixes: ${o.mergedFixes} <span class=m>(volume)</span></p>
<ul>
<li>Metered cost: ${o.costUsdPerFix === null ? "n/a" : `$${o.costUsdPerFix}`} (total $${o.meteredUsdTotal}; subscription runs count $0)</li>
<li>Attempts: ${n(o.attemptsPerFix)}, attempt time ${n(o.attemptMinutesPerFix, "m")}</li>
<li>Reverts: ${n(o.revertsPerFix)} (${o.reverts})</li>
<li>Rework: ${n(o.reworkAttemptsPerFix)} extra attempts (${o.reworkAttemptsTotal} total)</li>
</ul>
<h3>Vendor agreement with owner</h3><ul>${vendors || "<li>n/a</li>"}</ul>
<h3>Autonomy</h3><ul>${steps || "<li>n/a</li>"}</ul>
<h2>Scout activity</h2>${scouts}
</body></html>`;
}
