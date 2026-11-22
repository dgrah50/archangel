import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UiState } from "../../src/core/ui-state.js";
import { Dashboard } from "./Dashboard";
import { Provider } from "./provider";

function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/state")
        .then((r) => (r.ok ? (r.json() as Promise<UiState>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((s) => {
          setState(s);
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
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <Provider>
    <App />
  </Provider>,
);
