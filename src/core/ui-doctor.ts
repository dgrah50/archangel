import type { DoctorCheck, DoctorReport } from "./doctor.js";

export type DoctorScope = "machine" | "repo";
export type DoctorRunner = (o: { scope: DoctorScope; smoke: boolean }) => Promise<DoctorReport>;

export interface DoctorPayload {
  generatedAt: number;
  scope: DoctorScope;
  smoke: boolean;
  ok: boolean;
  checks: DoctorCheck[];
}

/** Replaces every env value long enough to be a secret with its variable name, so no check text can leak one to the browser. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && /(KEY|TOKEN|PEM|SECRET|PASSWORD)/i.test(name)) out = out.split(value).join(`<${name}>`);
  }
  return out;
}

const redactCheck = (c: DoctorCheck, env: NodeJS.ProcessEnv): DoctorCheck => ({
  ...c,
  name: redactSecrets(c.name, env),
  detail: redactSecrets(c.detail, env),
  ...(c.remediation ? { remediation: redactSecrets(c.remediation, env) } : {}),
});

/**
 * Runs the doctor and shapes it for the browser: `machine` is the offline ladder, `repo` the GitHub-facing checks (the online run's
 * extra rows). Non-smoke results are cached for 30 s and concurrent identical requests share one run, so a polling or hostile page
 * cannot spawn processes in a loop. Smoke results are never cached.
 */
export function makeDoctorHandler(run: DoctorRunner, env: NodeJS.ProcessEnv = process.env, ttlMs = 30_000) {
  const cache = new Map<string, { at: number; payload: DoctorPayload }>();
  const inflight = new Map<string, Promise<DoctorPayload>>();
  return async (scope: DoctorScope, smoke: boolean, now = Date.now()): Promise<DoctorPayload> => {
    const key = `${scope}:${smoke}`;
    const hit = cache.get(key);
    if (!smoke && hit && now - hit.at < ttlMs) return hit.payload;
    let p = inflight.get(key);
    if (!p) {
      p = run({ scope, smoke })
        .then((report) => {
          const checks = report.checks.filter((c) => (scope === "machine" ? c.scope !== "repo" : c.scope === "repo")).map((c) => redactCheck(c, env));
          const payload: DoctorPayload = { generatedAt: now, scope, smoke, ok: checks.every((c) => c.status !== "fail"), checks };
          if (!smoke) cache.set(key, { at: now, payload });
          return payload;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
}
