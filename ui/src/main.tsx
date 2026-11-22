import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppView } from "./AppView";
import { ErrorBoundary } from "./ErrorBoundary";
import { useFeed, useHash } from "./feeds";
import { isUiState, isWorkflowsState } from "./payload";
import { Provider } from "./provider";
import { parseRoute } from "./route";

function App() {
  const route = parseRoute(useHash());
  const [state, loadState] = useFeed("/api/state", isUiState);
  // Each page polls only its own feeds.
  const [workflows, loadWorkflows] = useFeed("/api/workflows", isWorkflowsState, route.page === "pipeline");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, []);
  const retry = () => {
    loadState();
    if (route.page === "pipeline") loadWorkflows();
  };
  return <AppView route={route} state={state} workflows={workflows} now={now} onRetry={retry} />;
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <Provider>
      <App />
    </Provider>
  </ErrorBoundary>,
);
