const crypto = require('crypto');
const db = require('../db');
const mailer = require('../mailer');
const { APP_BASE_URL } = require('../config');

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendVerificationEmail(user) {
  const token = generateSecureToken();
  await db.run('UPDATE users SET verification_token = ? WHERE id = ?', [token, user.id]);

  const verificationUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  console.log(`[Email Verification] Sent to ${user.email}`);
  console.log(`[Email Verification] Verify here: ${verificationUrl}`);

  await mailer.sendMail({
    to: user.email,
    subject: 'Verify your Game Time Tracker account',
    text: `Hi ${user.first_name},\n\nPlease verify your email address by visiting the link below:\n${verificationUrl}\n\nIf you did not create this account, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.first_name)},</p><p>Please verify your email address by clicking the link below:</p><p><a href="${verificationUrl}">${verificationUrl}</a></p><p>If you did not create this account, you can ignore this email.</p>`
  });

  return verificationUrl;
}

async function sendPasswordResetEmail(user) {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.run(
    'UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?',
    [token, expiresAt, user.id]
  );

  const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  console.log(`[Password Reset] Sent to ${user.email}`);
  console.log(`[Password Reset] Reset here: ${resetUrl}`);

  await mailer.sendMail({
    to: user.email,
    subject: 'Reset your Game Time Tracker password',
    text: `Hi ${user.first_name},\n\nWe received a request to reset your password. This link expires in 1 hour:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.first_name)},</p><p>We received a request to reset your password. This link expires in 1 hour:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, you can safely ignore this email.</p>`
  });

  return resetUrl;
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail
};
