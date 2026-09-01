const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, SMTP_FROM } = process.env;

const isConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: SMTP_SECURE === 'true',
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    })
  : null;

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`[Email] SMTP is not configured; skipping real delivery to ${to} ("${subject}").`);
    return { delivered: false };
  }

  try {
    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to,
      subject,
      text,
      html
    });

    return { delivered: true };
  } catch (error) {
    console.error(`[Email] Failed to send "${subject}" to ${to}:`, error.message);
    return { delivered: false, error: error.message };
  }
}

module.exports = { sendMail, isConfigured };
