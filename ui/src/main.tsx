import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { Box } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";
import { Dashboard } from "./Dashboard";
import { Pipeline } from "./Pipeline";
import { Provider } from "./provider";

function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const get = <T,>(url: string) =>
      fetch(url).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`))));
    const load = () =>
      Promise.all([get<UiState>("/api/state"), get<WorkflowsState>("/api/workflows")])
        .then(([s, w]) => {
          setState(s);
          setWorkflows(w);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!state) return <p style={{ padding: 24 }}>{error ? `Failed to load state: ${error}` : "Loading..."}</p>;
  return (
    <>
      {error ? <p style={{ padding: 8 }}>Refresh failed: {error}</p> : null}
      <Dashboard state={state} />
      {workflows ? (
        <Box maxW="64rem" mx="auto" px="6" pb="6">
          <Pipeline data={workflows} />
        </Box>
      ) : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <Provider>
    <App />
  </Provider>,
);
