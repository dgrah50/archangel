import { execFile } from "node:child_process";

export interface PeakRssPoll {
  /** Stops polling for good and returns the highest summed RSS seen (KB), or null when no sample found the group. */
  stop(): number | null;
}

function sampleGroupRssKb(pgid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pgid=,rss="], (err, out) => {
      if (err) return resolve(null);
      let sum = 0;
      let seen = false;
      for (const line of out.split("\n")) {
        const [g, r] = line.trim().split(/\s+/);
        if (Number(g) === pgid) {
          sum += Number(r) || 0;
          seen = true;
        }
      }
      resolve(seen ? sum : null);
    });
  });
}

/** Sums `ps` RSS over one process group now and every `intervalMs`, keeping the max. The timer is unref'd and cleared by `stop`. */
export function startPeakRssPoll(pgid: number, intervalMs: number): PeakRssPoll {
  let peak: number | null = null;
  let stopped = false;
  const sample = () => {
    void sampleGroupRssKb(pgid).then((kb) => {
      if (!stopped && kb !== null) peak = Math.max(peak ?? 0, kb);
    });
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      return peak;
    },
  };
}
