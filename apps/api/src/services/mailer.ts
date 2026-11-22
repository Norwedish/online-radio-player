/** SMTP mailer (alerts, password reset). Placeholder SMTP hosts log instead of sending. */
import nodemailer, { type Transporter } from "nodemailer";
import { secret, type RuntimeConfig } from "@radio/shared";

export interface SentMail {
  to: string[];
  subject: string;
  text: string;
  at: string;
}

export class Mailer {
  private transport: Transporter;
  readonly outbox: SentMail[] = [];
  readonly live: boolean;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly log: (m: string) => void = () => {},
  ) {
    const host = process.env.SMTP_HOST ?? config.email.smtpHost;
    this.live = !/example\.(com|org|net)$/.test(host) && config.nodeEnv !== "test";
    this.transport = this.live
      ? nodemailer.createTransport({
          host,
          port: Number(process.env.SMTP_PORT ?? config.email.smtpPort),
          secure: Number(process.env.SMTP_PORT ?? config.email.smtpPort) === 465,
          requireTLS: config.email.smtpSecure,
          auth: secret(config.email.authUserEnv)
            ? {
                user: secret(config.email.authUserEnv)!,
                pass: secret(config.email.authPasswordEnv) ?? "",
              }
            : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }

  async send(to: string[], subject: string, text: string): Promise<void> {
    if (to.length === 0) return;
    this.outbox.push({ to, subject, text, at: new Date().toISOString() });
    if (this.outbox.length > 50) this.outbox.shift();
    if (!this.live) {
      this.log(`mail (not sent, SMTP not configured) to=${to.join(",")} subject="${subject}"`);
      return;
    }
    await this.transport.sendMail({
      from: process.env.SMTP_FROM ?? this.config.email.from,
      to: to.join(", "),
      subject,
      text,
    });
  }
}
