import type { ComputeProvider, PrepareSpec, Workspace } from "./provider.js";

/** A provider and the Attempt's workspace on it, prepared (and set up) on first use so a provider no chain entry needs is never started. */
export interface WorkspaceHandle {
  compute: ComputeProvider;
  workspace(): Promise<Workspace>;
}

export class LazyWorkspace implements WorkspaceHandle {
  private pending: Promise<Workspace> | null = null;
  private created: Workspace | null = null;

  constructor(
    readonly compute: ComputeProvider,
    private readonly spec: PrepareSpec,
    private readonly setup: (ws: Workspace) => Promise<void> = async () => undefined,
  ) {}

  workspace(): Promise<Workspace> {
    return (this.pending ??= (async () => {
      const ws = await this.compute.prepare(this.spec);
      this.created = ws;
      await this.setup(ws);
      return ws;
    })());
  }

  /** Safe to call whether or not it was ever used. */
  destroy(): void {
    if (this.created) this.compute.destroy(this.created);
    this.created = null;
    this.pending = null;
  }
}
