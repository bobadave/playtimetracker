const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { getSessionUserId } = require('../lib/session');
const { parseUserTeamIds } = require('../lib/teams');

const router = express.Router();

router.put('/api/profile', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const trimmedFirst = String(req.body?.firstName ?? '').trim();
  const trimmedLast = String(req.body?.lastName ?? '').trim();

  if (!trimmedFirst || !trimmedLast) {
    return res.status(400).json({ message: 'First name and last name are required.' });
  }

  await db.run('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?', [trimmedFirst, trimmedLast, userId]);

  const user = await db.get('SELECT id, first_name, last_name, email, team_ids, email_verified, created_at FROM users WHERE id = ?', [userId]);

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

router.put('/api/profile/password', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const trimmedPassword = String(req.body?.password ?? '');
  if (!trimmedPassword) {
    return res.status(400).json({ message: 'Password is required.' });
  }

  if (trimmedPassword.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  const passwordHash = await bcrypt.hash(trimmedPassword, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);

  return res.json({ message: 'Password updated successfully.' });
});

module.exports = router;
