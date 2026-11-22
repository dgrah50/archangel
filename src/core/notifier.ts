export interface Notifier {
  notifyNeedsYou(input: {
    issueNumber: number | null;
    title: string;
    reason: string;
    decisionClass: string;
    recommendation: string;
    url?: string;
  }): Promise<void>;
  /** Plain-text daily digest across all projects. */
  sendDigest(text: string): Promise<void>;
}

/**
 * Quiet-by-default single-owner notifier (Polaris pattern):
 * only fires on `Needs You` escalations and red-main circuit-breaker trips.
 */
export class TelegramNotifier implements Notifier {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  /** Both settings or neither: with neither this is the explicit "no Telegram" notifier; with only one, alerts would silently vanish. */
  constructor(opts: { botToken?: string; chatId?: string; apiBase?: string; timeoutMs?: number }) {
    if (Boolean(opts.botToken) !== Boolean(opts.chatId)) {
      throw new Error("Telegram needs both a bot token and a chat id (or neither)");
    }
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.apiBase = opts.apiBase ?? "https://api.telegram.org";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async notifyNeedsYou(input: {
    issueNumber: number | null;
    title: string;
    reason: string;
    decisionClass: string;
    recommendation: string;
    url?: string;
  }): Promise<void> {
    const prefix = input.issueNumber ? `Archangel Needs You (#${input.issueNumber})` : "Archangel Needs You";
    const text = [
      prefix,
      input.title,
      "",
      `Decision: ${input.decisionClass}`,
      `Reason: ${input.reason}`,
      `Recommended: ${input.recommendation}`,
      input.url ? `Link: ${input.url}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await this.send(text);
  }

  async sendDigest(text: string): Promise<void> {
    await this.send(text);
  }

  private async send(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      return;
    }

    const res = await fetch(`${this.apiBase}/bot${this.botToken}/sendMessage`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Telegram notify failed (${res.status}): ${await res.text()}`);
    }
  }
}
