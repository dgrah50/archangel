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

  constructor(opts: { botToken?: string; chatId?: string }) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
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

    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
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
