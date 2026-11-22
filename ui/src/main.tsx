import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppView } from "./AppView";
import { ErrorBoundary } from "./ErrorBoundary";
import { useFeed, useHash } from "./feeds";
import { isHostStatus, isLogs, isThreadDetail, isUiState, isWorkflowsState } from "./payload";
import { Provider } from "./provider";
import { parseRoute } from "./route";

function App() {
  const route = parseRoute(useHash());
  const [state, loadState] = useFeed("/api/state", isUiState);
  // Each page polls only its own feeds.
  const [workflows, loadWorkflows] = useFeed("/api/workflows", isWorkflowsState, route.page === "pipeline");
  const [host, loadHost] = useFeed("/api/host", isHostStatus);
  const t = route.page === "thread" ? route.item : null;
  const key = t ? `${encodeURI(t.repo)}/${t.issue}` : "";
  const [thread, loadThread] = useFeed(`/api/threads/${key}`, isThreadDetail, t !== null);
  const [logs, loadLogs] = useFeed(t ? `/api/logs?repo=${encodeURIComponent(t.repo)}&issue=${t.issue}&limit=100` : "/api/logs", isLogs, t !== null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, []);
  const retry = () => {
    loadState();
    loadHost();
    if (route.page === "pipeline") loadWorkflows();
    if (t) {
      loadThread();
      loadLogs();
    }
  };
  return <AppView route={route} state={state} workflows={workflows} host={host} thread={thread} logs={logs} now={now} onRetry={retry} />;
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <Provider>
      <App />
    </Provider>
  </ErrorBoundary>,
);
