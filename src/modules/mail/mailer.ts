import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { env } from "../../config/env";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// "outbox" writes messages to MAIL_OUTBOX_DIR (development/tests). Messages carry
// one-time links, so they go to files, never to logs. "resend" is the production
// transport; swap it for your provider here if needed.
export async function sendMail(message: MailMessage): Promise<void> {
  if (env.MAIL_TRANSPORT === "outbox") {
    await mkdir(env.MAIL_OUTBOX_DIR, { recursive: true });
    const file = path.join(env.MAIL_OUTBOX_DIR, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(
      file,
      JSON.stringify({ ...message, from: env.MAIL_FROM, sentAt: new Date().toISOString() }, null, 2),
    );
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [message.to], subject: message.subject, text: message.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Mail provider responded with HTTP ${response.status}`);
  }
}
