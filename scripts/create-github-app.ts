import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.ARCHANGEL_APP_SETUP_PORT ?? 4321);
const CALLBACK_URL = `http://127.0.0.1:${PORT}/callback`;
const PEM_DIR = path.join(os.homedir(), ".config", "archangel");
const PEM_PATH = path.join(PEM_DIR, "github-app.pem");
const ENV_PATH = path.resolve(".env");

const appSuffix = Math.random().toString(36).slice(2, 6);
const manifest = {
  name: `archangel-pilot-${appSuffix}`,
  url: "https://github.com/dgrah50/archangel",
  redirect_url: CALLBACK_URL,
  public: false,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "read",
  },
  default_events: [],
};

function upsertEnvFile(updates: Record<string, string>): void {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = `${content.trimEnd()}\n${line}\n`.replace(/^\n/, "");
    }
  }
  fs.writeFileSync(ENV_PATH, content, { encoding: "utf8", mode: 0o600 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
<body style="font-family: system-ui; max-width: 640px; margin: 48px auto; line-height: 1.5;">
  <h2>Create Least-Privilege Archangel GitHub App</h2>
  <p>This submits GitHub's official App Manifest with exact ADR-0004 permissions:</p>
  <ul>
    <li><b>Allowed:</b> <code>contents:write</code>, <code>pull_requests:write</code>, <code>issues:write</code>, <code>checks:read</code></li>
    <li><b>Forbidden (absent):</b> <code>workflows</code>, <code>administration</code>, <code>checks:write</code></li>
  </ul>
  <form action="https://github.com/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}" />
    <button type="submit" style="font-size: 16px; padding: 10px 20px; cursor: pointer;">
      Create GitHub App on GitHub &rarr;
    </button>
  </form>
</body>
</html>`);
    return;
  }

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Missing ?code parameter from GitHub");
      return;
    }

    try {
      const ghRes = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "archangel-setup",
        },
      });
      if (!ghRes.ok) {
        const text = await ghRes.text();
        throw new Error(`GitHub manifest conversion failed (${ghRes.status}): ${text}`);
      }
      const data = (await ghRes.json()) as {
        id: number;
        slug: string;
        name: string;
        pem: string;
        html_url: string;
      };

      fs.mkdirSync(PEM_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(PEM_PATH, data.pem, { encoding: "utf8", mode: 0o600 });
      upsertEnvFile({
        ARCHANGEL_GITHUB_APP_ID: String(data.id),
        ARCHANGEL_GITHUB_PRIVATE_KEY_PATH: PEM_PATH,
      });

      const installUrl = `https://github.com/apps/${data.slug}/installations/new`;
      console.log(`\n[archangel] Created GitHub App '${data.name}' (ID: ${data.id})`);
      console.log(`[archangel] Saved chmod 600 PEM to ${PEM_PATH}`);
      console.log(`[archangel] Updated ${ENV_PATH} with ARCHANGEL_GITHUB_APP_ID=${data.id}`);
      console.log(`[archangel] Next: install it ONLY on dgrah50/gijq at: ${installUrl}\n`);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<body style="font-family: system-ui; max-width: 640px; margin: 48px auto; line-height: 1.5;">
  <h2>GitHub App Created!</h2>
  <p><b>App:</b> ${escapeHtml(data.name)} (ID: <code>${data.id}</code>)</p>
  <p>Saved PEM to <code>${escapeHtml(PEM_PATH)}</code> (<code>chmod 600</code>) and updated <code>.env</code>.</p>
  <p><a href="${escapeHtml(installUrl)}" style="font-size: 16px;">Step 2: Install ONLY on <code>dgrah50/gijq</code> &rarr;</a></p>
  <p>After clicking Install, you can close this tab and tell Archangel "installed" so it auto-fills <code>ARCHANGEL_GITHUB_INSTALLATION_ID</code>.</p>
</body>
</html>`);
      setTimeout(() => server.close(), 1500);
    } catch (err) {
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`[archangel] GitHub App Manifest helper listening at ${url}`);
  try {
    execFileSync("open", [url]);
  } catch {
    console.log(`[archangel] Open ${url} in your browser.`);
  }
});
