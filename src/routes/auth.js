const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { IS_PRODUCTION } = require('../config');
const { getSessionUserId } = require('../lib/session');
const { parseUserTeamIds } = require('../lib/teams');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../lib/email');

const router = express.Router();

router.get('/api/session', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.json({ user: null });
  }

  const user = await db.get('SELECT id, first_name, last_name, email, team_ids, email_verified, created_at FROM users WHERE id = ?', [userId]);
  if (!user) {
    req.session.destroy(() => undefined);
    return res.json({ user: null });
  }

  return res.json({
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      emailVerified: Number(user.email_verified) === 1,
      teamIds: parseUserTeamIds(user.team_ids),
      createdAt: user.created_at
    }
  });
});

router.get('/verify-email', async (req, res) => {
  const token = String(req.query.token ?? '').trim();
  if (!token) {
    return res.status(400).send('<html><body><h1>Verification Error</h1><p>Missing verification token.</p><p><a href="/login">Return to login</a></p></body></html>');
  }

  const user = await db.get('SELECT * FROM users WHERE verification_token = ?', [token]);
  if (!user) {
    return res.status(400).send('<html><body><h1>Verification Failed</h1><p>This verification link is invalid or has already been used.</p><p><a href="/login">Return to login</a></p></body></html>');
  }

  if (Number(user.email_verified) === 1) {
    return res.send('<html><body><h1>Email Already Verified</h1><p>Your email has already been verified.</p><p><a href="/login">Go to login</a></p></body></html>');
  }

  await db.run(
    'UPDATE users SET email_verified = 1, verification_token = NULL, verified_at = ? WHERE id = ?',
    [new Date().toISOString(), user.id]
  );

  return res.send('<html><body><h1>Email Verified</h1><p>Your account has been verified. You can now log in.</p><p><a href="/login">Go to login</a></p></body></html>');
});

router.post('/api/password-reset/request', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    return res.status(404).json({ message: 'No account was found with that email address.' });
  }

  await sendPasswordResetEmail(user);

  return res.json({
    message: 'If an account exists for that email, a password reset link has been sent.'
  });
});

router.post('/api/password-reset/confirm', async (req, res) => {
  const { token, password } = req.body || {};
  const resetToken = String(token ?? '').trim();
  const trimmedPassword = String(password ?? '');

  if (!resetToken || trimmedPassword.length < 6) {
    return res.status(400).json({ message: 'A valid reset token and a password with at least 6 characters are required.' });
  }

  const user = await db.get(
    'SELECT * FROM users WHERE reset_token = ? AND reset_expires_at IS NOT NULL',
    [resetToken]
  );

  if (!user) {
    return res.status(400).json({ message: 'This password reset link is invalid or has expired.' });
  }

  const expiresAt = new Date(user.reset_expires_at).getTime();
  if (Number.isNaN(expiresAt) || expiresAt < Date.now()) {
    await db.run('UPDATE users SET reset_token = NULL, reset_expires_at = NULL WHERE id = ?', [user.id]);
    return res.status(400).json({ message: 'This password reset link has expired. Please request a new one.' });
  }

  const passwordHash = await bcrypt.hash(trimmedPassword, 10);
  await db.run(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?',
    [passwordHash, user.id]
  );

  return res.json({ message: 'Your password has been updated successfully.' });
});

router.post('/api/register', async (req, res) => {
  const { firstName, lastName, email, password } = req.body || {};
  const trimmedFirst = String(firstName ?? '').trim();
  const trimmedLast = String(lastName ?? '').trim();
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const trimmedPassword = String(password ?? '');

  if (!trimmedFirst || !trimmedLast || !normalizedEmail || trimmedPassword.length < 6) {
    return res.status(400).json({ message: 'First name, last name, email, and a password with at least 6 characters are required.' });
  }

  const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existingUser) {
    return res.status(409).json({ message: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(trimmedPassword, 10);
  const result = await db.run(
    'INSERT INTO users (first_name, last_name, email, password_hash, team_ids, email_verified, verification_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [trimmedFirst, trimmedLast, normalizedEmail, passwordHash, JSON.stringify([]), 0, null, new Date().toISOString()]
  );

  const user = await db.get('SELECT id, first_name, last_name, email, team_ids, email_verified FROM users WHERE id = ?', [result.id]);
  const verificationUrl = await sendVerificationEmail(user);

  return res.status(201).json({
    message: 'Registration successful. Check your email to verify your account before logging in.',
    // Only echoed back outside production, where there's no real inbox to check — in
    // production this would let anyone verify an email address they don't own.
    ...(IS_PRODUCTION ? {} : { verificationUrl }),
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      emailVerified: Number(user.email_verified) === 1,
      teamIds: parseUserTeamIds(user.team_ids)
    }
  });
});

router.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const trimmedPassword = String(password ?? '');

  if (!normalizedEmail || !trimmedPassword) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const passwordMatches = await bcrypt.compare(trimmedPassword, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  if (Number(user.email_verified) !== 1) {
    return res.status(403).json({ message: 'Please verify your email before logging in. Check your inbox for a verification link.' });
  }

  req.session.userId = user.id;

  return res.json({
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      emailVerified: true,
      teamIds: parseUserTeamIds(user.team_ids)
    }
  });
});

router.post('/api/resend-verification', async (req, res) => {
  const normalizedEmail = String(req.body?.email ?? '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    return res.status(404).json({ message: 'No account was found with that email address.' });
  }

  if (Number(user.email_verified) === 1) {
    return res.status(409).json({ message: 'This account is already verified. You can log in.' });
  }

  await sendVerificationEmail(user);

  return res.json({ message: 'Verification email resent. Please check your inbox.' });
});

router.post('/api/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ message: 'Unable to log out.' });
    }

    return res.json({ success: true });
  });
});

module.exports = router;
