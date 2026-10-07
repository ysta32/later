import nodemailer from "nodemailer";

export interface MailAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

/** Outbound mail transport (injectable so tests never touch SMTP). */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Real SMTP mailer backed by nodemailer (SMTP_URL, e.g. smtps://user:pass@host:465). */
export function createSmtpMailer(smtpUrl: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      await transport.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength),
          contentType: a.contentType,
        })),
      });
    },
  };
}

/** Default From address: LATER_MAIL_FROM, else later@<public host>. */
export function defaultMailFrom(publicUrl: string): string {
  let host = "localhost";
  try {
    host = new URL(publicUrl).hostname || host;
  } catch {
    /* invalid publicUrl: keep localhost */
  }
  return `later@${host}`;
}
