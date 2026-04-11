// utils/emailService.js
//
//  Email service powered by Resend (https://resend.com).
//  Drop-in replacement for the previous nodemailer/SMTP setup.
//
//  Required env vars:
//    RESEND_API_KEY  – from resend.com dashboard → API Keys
//    EMAIL_FROM      – "Melani Scan <onboarding@resend.dev>"
//                      (use onboarding@resend.dev on free tier until you
//                       verify your own domain e.g. noreply@melaniscan.ng)
//
const { Resend } = require('resend');
const logger     = require('./logger');

// Lazy-init so missing key only throws when mail is actually attempted
let _resend = null;
function getClient() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not set in environment variables.');
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// ── Base send helper ──────────────────────────────────────────
async function sendMail({ to, subject, html, text }) {
  const from   = process.env.EMAIL_FROM || 'Melani Scan <onboarding@resend.dev>';
  const client = getClient();

  const { data, error } = await client.emails.send({
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  });

  if (error) {
    logger.error(`Resend error sending to ${to}:`, error);
    throw new Error(error.message || 'Failed to send email via Resend.');
  }

  logger.info(`Email sent to ${to} — Resend ID: ${data?.id}`);
  return data;
}

// ── OTP email (signup verification) ──────────────────────────
async function sendVerificationOTP(user, otp) {
  const firstName = user.firstName || 'there';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    </head>
    <body style="margin:0;padding:0;background:#0F0500;font-family:'DM Sans',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0500;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="520" cellpadding="0" cellspacing="0"
              style="background:#1A0A02;border:1px solid rgba(200,134,10,0.22);border-radius:16px;padding:40px 36px;max-width:520px;">

              <!-- Logo -->
              <tr>
                <td align="center" style="padding-bottom:28px;">
                  <div style="display:inline-block;width:52px;height:52px;border-radius:26px;border:1.5px solid #C8860A;background:rgba(200,134,10,0.14);text-align:center;line-height:52px;">
                    <span style="color:#C8860A;font-size:22px;font-weight:900;">M</span>
                  </div>
                  <p style="color:#C8860A;font-size:18px;font-weight:700;letter-spacing:0.1em;margin:10px 0 0;">MELANI SCAN</p>
                </td>
              </tr>

              <!-- Heading -->
              <tr>
                <td align="center" style="padding-bottom:8px;">
                  <h1 style="color:#F5DEB3;font-size:24px;font-weight:800;margin:0;">Verify Your Email</h1>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:30px;">
                  <p style="color:rgba(245,222,179,0.55);font-size:14px;line-height:1.6;margin:0;">
                    Hi ${firstName}, welcome to Melani Scan.<br/>
                    Enter this code in the app to verify your account.
                  </p>
                </td>
              </tr>

              <!-- OTP box -->
              <tr>
                <td align="center" style="padding-bottom:30px;">
                  <div style="background:rgba(200,134,10,0.10);border:2px solid #C8860A;border-radius:14px;padding:22px 40px;display:inline-block;">
                    <span style="color:#C8860A;font-size:38px;font-weight:900;letter-spacing:10px;">${otp}</span>
                  </div>
                  <p style="color:rgba(245,222,179,0.45);font-size:12px;margin:10px 0 0;">
                    This code expires in <strong style="color:#F5DEB3;">10 minutes</strong>
                  </p>
                </td>
              </tr>

              <!-- Note -->
              <tr>
                <td style="border-top:1px solid rgba(200,134,10,0.15);padding-top:22px;">
                  <p style="color:rgba(245,222,179,0.35);font-size:11px;text-align:center;margin:0;">
                    If you didn't create a Melani Scan account, you can safely ignore this email.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const text = `Hi ${firstName},\n\nYour Melani Scan verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not create an account, ignore this email.`;

  return sendMail({
    to:      user.email,
    subject: 'Verify your Melani Scan account',
    html,
    text,
  });
}

// ── Password reset OTP ────────────────────────────────────────
async function sendPasswordResetOTP(user, otp) {
  const firstName = user.firstName || 'there';

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8" /></head>
    <body style="margin:0;padding:0;background:#0F0500;font-family:'DM Sans',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0500;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="520" cellpadding="0" cellspacing="0"
              style="background:#1A0A02;border:1px solid rgba(200,134,10,0.22);border-radius:16px;padding:40px 36px;max-width:520px;">

              <tr>
                <td align="center" style="padding-bottom:28px;">
                  <div style="display:inline-block;width:52px;height:52px;border-radius:26px;border:1.5px solid #C8860A;background:rgba(200,134,10,0.14);text-align:center;line-height:52px;">
                    <span style="color:#C8860A;font-size:22px;font-weight:900;">M</span>
                  </div>
                  <p style="color:#C8860A;font-size:18px;font-weight:700;letter-spacing:0.1em;margin:10px 0 0;">MELANI SCAN</p>
                </td>
              </tr>

              <tr>
                <td align="center" style="padding-bottom:8px;">
                  <h1 style="color:#F5DEB3;font-size:24px;font-weight:800;margin:0;">Reset Your Password</h1>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:30px;">
                  <p style="color:rgba(245,222,179,0.55);font-size:14px;line-height:1.6;margin:0;">
                    Hi ${firstName}, we received a password reset request.<br/>
                    Enter this code in the app to continue.
                  </p>
                </td>
              </tr>

              <tr>
                <td align="center" style="padding-bottom:30px;">
                  <div style="background:rgba(200,134,10,0.10);border:2px solid #C8860A;border-radius:14px;padding:22px 40px;display:inline-block;">
                    <span style="color:#C8860A;font-size:38px;font-weight:900;letter-spacing:10px;">${otp}</span>
                  </div>
                  <p style="color:rgba(245,222,179,0.45);font-size:12px;margin:10px 0 0;">
                    This code expires in <strong style="color:#F5DEB3;">10 minutes</strong>
                  </p>
                </td>
              </tr>

              <tr>
                <td style="border-top:1px solid rgba(200,134,10,0.15);padding-top:22px;">
                  <p style="color:rgba(245,222,179,0.35);font-size:11px;text-align:center;margin:0;">
                    If you did not request this, your account is safe — just ignore this email.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const text = `Hi ${firstName},\n\nYour Melani Scan password reset code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, ignore this email.`;

  return sendMail({
    to:      user.email,
    subject: 'Reset your Melani Scan password',
    html,
    text,
  });
}

module.exports = { sendVerificationOTP, sendPasswordResetOTP };
