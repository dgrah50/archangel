import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppView } from "./AppView";
import { ErrorBoundary } from "./ErrorBoundary";
import { useFeed, useHash } from "./feeds";
import { isEvalsState, isHostStatus, isPitchesState, isSettingsState, isThreadDetail, isUiState, isWorkflowsState } from "./payload";
import { Provider } from "./provider";
import { parseRoute } from "./route";

function App() {
  const route = parseRoute(useHash());
  const [state, loadState] = useFeed("/api/state", isUiState);
  // Each page polls only its own feeds.
  const [workflows, loadWorkflows] = useFeed("/api/workflows", isWorkflowsState, route.page === "pipeline" || route.page === "setup" || route.page === "settings");
  const [evals, loadEvals] = useFeed("/api/evals", isEvalsState, route.page === "setup");
  const [settings, loadSettings] = useFeed("/api/settings", isSettingsState, route.page === "settings" || route.page === "setup" || route.page === "pipeline");
  const [host, loadHost] = useFeed("/api/host", isHostStatus);
  const first = state.data?.needsYou[0];
  const t = route.page === "thread" ? route.item : route.page === "needs-you" ? (route.item ?? (first ? { repo: first.repo, issue: first.issueNumber } : null)) : null;
  const key = t ? `${encodeURI(t.repo)}/${t.issue}` : "";
  const [thread, loadThread] = useFeed(`/api/threads/${key}`, isThreadDetail, t !== null);
  const [pitches, loadPitches] = useFeed("/api/pitches", isPitchesState, route.page === "pitches");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, []);
  const retry = () => {
    loadState();
    loadHost();
    if (route.page === "pipeline" || route.page === "setup" || route.page === "settings") loadWorkflows();
    if (route.page === "settings" || route.page === "setup" || route.page === "pipeline") loadSettings();
    if (route.page === "setup") loadEvals();
    if (route.page === "pitches") loadPitches();
    if (t) loadThread();
  };
  return <AppView route={route} state={state} workflows={workflows} evals={evals} settings={settings} host={host} thread={thread} pitches={pitches} now={now} onRetry={retry} />;
}

createRoot(document.getElementById("root")!).render(
  <Provider>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </Provider>,
);
