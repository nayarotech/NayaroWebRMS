import type { OutgoingEmail } from './mailer';

/**
 * Transactional email in the Nayaro identity: navy header, the NAYARO
 * wordmark with its product tag, brand blue #1F5EFF, plain white body.
 *
 * Written for email clients, not browsers: tables and inline styles only, and
 * the wordmark is live text rather than an image, because most inboxes block
 * images until the reader allows them - and a verification code must be
 * readable on the first open.
 */
const NAVY = '#0a0e17';
const BLUE = '#1f5eff';
const INK = '#111726';
const MUTED = '#5a6478';
const LINE = '#e4e8f0';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(options: { preheader: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Nayaro RMS</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fa;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
<tr><td style="background:${NAVY};padding:22px 32px;border-bottom:3px solid ${BLUE};">
<span style="font-family:${FONT};font-size:20px;font-weight:800;letter-spacing:1px;color:#ffffff;">NAYARO</span>
<span style="font-family:${MONO};font-size:10px;letter-spacing:2px;color:#ffffff;border:1px solid rgba(255,255,255,0.4);border-radius:4px;padding:3px 6px;margin-left:8px;vertical-align:3px;">RMS</span>
</td></tr>
<tr><td style="padding:32px;font-family:${FONT};color:${INK};">
${options.body}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid ${LINE};background:#fafbfd;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">
Nayaro RMS · Restaurant management and POS for Nepal<br>
A product by Nayaro Technology · <a href="https://nayaro.tech" style="color:${BLUE};text-decoration:none;">nayaro.tech</a>
</td></tr>
</table>
<p style="font-family:${FONT};font-size:11px;color:#9aa2b4;margin:16px 0 0;">This is an automatic message from noreply@nayaro.tech. Replies are not read.</p>
</td></tr>
</table>
</body>
</html>`;
}

export function verificationCodeEmail(options: {
  readonly to: string;
  readonly code: string;
  readonly ownerName: string;
  readonly restaurantName: string;
  readonly expiresInMinutes: number;
}): OutgoingEmail {
  const firstName = options.ownerName.trim().split(/\s+/)[0] ?? options.ownerName;
  const digits = options.code
    .split('')
    .map(
      (digit) =>
        `<td style="width:44px;height:54px;border:1px solid ${LINE};border-radius:8px;background:#f7f9fc;text-align:center;font-family:${MONO};font-size:26px;font-weight:700;color:${INK};">${digit}</td>`,
    )
    .join('<td style="width:8px;"></td>');

  const body = `
<p style="margin:0 0 6px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BLUE};">Verify your email</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:30px;font-weight:800;color:${INK};">Your sign-up code</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${MUTED};">
Namaste ${escapeHtml(firstName)}, enter this code to finish registering <strong style="color:${INK};">${escapeHtml(options.restaurantName)}</strong> on Nayaro RMS.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr>${digits}</tr></table>
<p style="margin:0 0 24px;font-size:14px;line-height:22px;color:${MUTED};">
The code expires in ${String(options.expiresInMinutes)} minutes. Do not share it with anyone - Nayaro staff will never ask for it.
</p>
<p style="margin:0;padding-top:20px;border-top:1px solid ${LINE};font-size:13px;line-height:20px;color:${MUTED};">
Did not try to sign up? You can ignore this email - no account is created until the code is entered.
</p>`;

  const text = [
    `Namaste ${firstName},`,
    '',
    `Your Nayaro RMS sign-up code is: ${options.code}`,
    '',
    `Enter it to finish registering ${options.restaurantName}. It expires in ${String(options.expiresInMinutes)} minutes.`,
    'Do not share this code. Nayaro staff will never ask for it.',
    '',
    'Did not try to sign up? Ignore this email - no account is created until the code is entered.',
    '',
    '- Nayaro RMS, a product by Nayaro Technology · https://nayaro.tech',
  ].join('\n');

  return {
    to: options.to,
    subject: `${options.code} is your Nayaro RMS verification code`,
    html: layout({ preheader: `Your sign-up code is ${options.code}. It expires in ${String(options.expiresInMinutes)} minutes.`, body }),
    text,
  };
}
