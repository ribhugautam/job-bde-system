import nodemailer from "nodemailer";

let _transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER / GMAIL_APP_PASSWORD are not set. Enable 2FA on the Gmail " +
        "account you want to send from, generate an App Password " +
        "(https://myaccount.google.com/apppasswords), and add both as env " +
        "vars in Vercel."
    );
  }
  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return _transporter;
}

export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Sends the daily digest to the owner (Ribhu), never to a third party.
export async function sendDigest(subject: string, body: string) {
  const owner = process.env.OWNER_EMAIL || process.env.GMAIL_USER;
  if (!owner) return { ok: false as const, error: "OWNER_EMAIL not set" };
  return sendMail({ to: owner, subject, text: body });
}
