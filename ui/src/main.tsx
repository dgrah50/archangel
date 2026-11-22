import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";
import { AppView, POLL_MS, type Feed } from "./AppView";
import { ErrorBoundary } from "./ErrorBoundary";
import { fetchFeed, isUiState, isWorkflowsState } from "./payload";
import { Provider } from "./provider";

const empty = <T,>(): Feed<T> => ({ data: null, at: null, error: null });

function App() {
  const [state, setState] = useState<Feed<UiState>>(empty());
  const [workflows, setWorkflows] = useState<Feed<WorkflowsState>>(empty());
  const [now, setNow] = useState(Date.now());
  const load = useCallback(() => {
    const run = <T,>(url: string, valid: (v: unknown) => v is T, set: React.Dispatch<React.SetStateAction<Feed<T>>>) =>
      fetchFeed(url, valid).then(
        (data) => set({ data, at: Date.now(), error: null }),
        (e: unknown) => set((f) => ({ ...f, error: e instanceof Error ? e.message : String(e) })),
      );
    void run("/api/state", isUiState, setState);
    void run("/api/workflows", isWorkflowsState, setWorkflows);
  }, []);
  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);
  return <AppView state={state} workflows={workflows} now={now} onRetry={load} />;
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <Provider>
      <App />
    </Provider>
  </ErrorBoundary>,
);
