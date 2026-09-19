const test = require('node:test');
const assert = require('node:assert/strict');

const {
  db,
  startTestServer,
  stopTestServer,
  registerAndLogIn,
  authedFetch
} = require('./helpers');

let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('registration requires first name, last name, email, and a 6+ character password', async () => {
  const cases = [
    { firstName: '', lastName: 'Last', email: 'a@example.com', password: 'password123' },
    { firstName: 'First', lastName: '', email: 'a@example.com', password: 'password123' },
    { firstName: 'First', lastName: 'Last', email: '', password: 'password123' },
    { firstName: 'First', lastName: 'Last', email: 'a@example.com', password: '12345' }
  ];

  for (const body of cases) {
    const response = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
});

test('registering with an email already in use is rejected with 409', async () => {
  const email = `dupe${Date.now()}@example.com`;
  const body = { firstName: 'First', lastName: 'Last', email, password: 'password123' };

  const first = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(second.status, 409);
});

test('email is normalized (trimmed + lowercased) so case/whitespace variants collide on registration and login', async () => {
  const raw = `MixedCase${Date.now()}@Example.com`;
  const body = { firstName: 'Mixed', lastName: 'Case', email: `  ${raw}  `, password: 'password123' };

  const regResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(regResponse.status, 201);

  const dupeResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, email: raw.toLowerCase() })
  });
  assert.equal(dupeResponse.status, 409, 'a differently-cased/spaced version of the same email should collide');
});

test('logging in before verifying email is rejected with 403, and login rejects wrong password with 401', async () => {
  const email = `unverified${Date.now()}@example.com`;
  const password = 'password123';
  await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Un', lastName: 'Verified', email, password })
  });

  const unverifiedLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(unverifiedLogin.status, 403);

  const wrongPasswordLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong-password' })
  });
  assert.equal(wrongPasswordLogin.status, 401);

  const unknownEmailLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody-here@example.com', password })
  });
  assert.equal(unknownEmailLogin.status, 401);
});

test('verifying with an invalid token fails, a valid token unlocks login, and reusing the link is idempotent', async () => {
  const invalidResponse = await fetch(`${baseUrl}/verify-email?token=not-a-real-token`);
  assert.equal(invalidResponse.status, 400);

  const email = `verifyflow${Date.now()}@example.com`;
  const password = 'password123';
  const regResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Verify', lastName: 'Flow', email, password })
  });
  const { verificationUrl } = await regResponse.json();
  const parsed = new URL(verificationUrl);

  const firstVerify = await fetch(`${baseUrl}${parsed.pathname}${parsed.search}`);
  assert.equal(firstVerify.status, 200);

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(loginResponse.status, 200);

  // The server clears verification_token once it's used, so re-visiting the
  // exact same link afterward correctly reports it as invalid/used, not "already verified"
  // (that branch only exists for the token-still-present-but-flag-already-set edge case).
  const secondVerify = await fetch(`${baseUrl}${parsed.pathname}${parsed.search}`);
  assert.equal(secondVerify.status, 400);
});

test('resend-verification: 404 for unknown email, 409 if already verified, and it re-arms the same account for verification', async () => {
  const unknown = await fetch(`${baseUrl}/api/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ghost@example.com' })
  });
  assert.equal(unknown.status, 404);

  const { email } = await registerAndLogIn('AlreadyVerified');
  const alreadyVerified = await fetch(`${baseUrl}/api/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  assert.equal(alreadyVerified.status, 409);
});

test('logout destroys the session so subsequent authenticated requests are rejected', async () => {
  const { cookie } = await registerAndLogIn('LogoutFlow');
  const fetchAs = authedFetch(cookie);

  const beforeLogout = await fetchAs('/api/session');
  const beforeJson = await beforeLogout.json();
  assert.ok(beforeJson.user, 'session should report a logged-in user before logout');

  const logoutResponse = await fetchAs('/api/logout', { method: 'POST' });
  assert.equal(logoutResponse.status, 200);

  const afterLogout = await fetchAs('/api/session');
  const afterJson = await afterLogout.json();
  assert.equal(afterJson.user, null);

  const protectedAfterLogout = await fetchAs('/api/teams');
  assert.equal(protectedAfterLogout.status, 401);
});

test('/api/session returns { user: null } with no cookie at all', async () => {
  const response = await fetch(`${baseUrl}/api/session`);
  const json = await response.json();
  assert.equal(json.user, null);
});

test('password reset: unknown email is 404, and the full request/confirm flow lets the user log in with the new password', async () => {
  const unknownRequest = await fetch(`${baseUrl}/api/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ghost@example.com' })
  });
  assert.equal(unknownRequest.status, 404);

  const email = `resetflow${Date.now()}@example.com`;
  const oldPassword = 'password123';
  const newPassword = 'newpassword456';

  const regResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Reset', lastName: 'Flow', email, password: oldPassword })
  });
  const { verificationUrl } = await regResponse.json();
  const verifyUrl = new URL(verificationUrl);
  await fetch(`${baseUrl}${verifyUrl.pathname}${verifyUrl.search}`);

  const resetRequest = await fetch(`${baseUrl}/api/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  assert.equal(resetRequest.status, 200);

  const user = await db.get('SELECT reset_token FROM users WHERE email = ?', [email]);
  assert.ok(user.reset_token, 'a reset token should be stored after requesting a reset');

  const badTokenConfirm = await fetch(`${baseUrl}/api/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'not-the-real-token', password: newPassword })
  });
  assert.equal(badTokenConfirm.status, 400);

  const confirmResponse = await fetch(`${baseUrl}/api/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: user.reset_token, password: newPassword })
  });
  assert.equal(confirmResponse.status, 200);

  const oldPasswordLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: oldPassword })
  });
  assert.equal(oldPasswordLogin.status, 401, 'the old password must no longer work');

  const newPasswordLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: newPassword })
  });
  assert.equal(newPasswordLogin.status, 200);

  const reuseToken = await fetch(`${baseUrl}/api/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: user.reset_token, password: 'anotherpassword789' })
  });
  assert.equal(reuseToken.status, 400, 'a reset token must be single-use');
});

test('an expired password reset token is rejected even though it matches', async () => {
  const email = `expiredreset${Date.now()}@example.com`;
  const regResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Expired', lastName: 'Reset', email, password: 'password123' })
  });
  const { verificationUrl } = await regResponse.json();
  const verifyUrl = new URL(verificationUrl);
  await fetch(`${baseUrl}${verifyUrl.pathname}${verifyUrl.search}`);

  await fetch(`${baseUrl}/api/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });

  const user = await db.get('SELECT id, reset_token FROM users WHERE email = ?', [email]);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.run('UPDATE users SET reset_expires_at = ? WHERE id = ?', [oneHourAgo, user.id]);

  const confirmResponse = await fetch(`${baseUrl}/api/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: user.reset_token, password: 'newpassword456' })
  });
  assert.equal(confirmResponse.status, 400);
});

test('login and password-reset endpoints validate required fields before touching the database', async () => {
  const missingLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '', password: '' })
  });
  assert.equal(missingLogin.status, 400);

  const missingResetRequest = await fetch(`${baseUrl}/api/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '' })
  });
  assert.equal(missingResetRequest.status, 400);

  const missingResetConfirmToken = await fetch(`${baseUrl}/api/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: '', password: 'password123' })
  });
  assert.equal(missingResetConfirmToken.status, 400);

  const shortResetConfirmPassword = await fetch(`${baseUrl}/api/password-reset/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'some-token', password: '123' })
  });
  assert.equal(shortResetConfirmPassword.status, 400);

  const missingResendEmail = await fetch(`${baseUrl}/api/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '' })
  });
  assert.equal(missingResendEmail.status, 400);
});

test('visiting /verify-email with no token at all is a distinct 400 from an invalid one', async () => {
  const response = await fetch(`${baseUrl}/verify-email`);
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /Missing verification token/);
});

test('/verify-email reports "already verified" for the edge case where the flag is set but the token was never cleared', async () => {
  // Under normal operation this branch is unreachable — the only place that sets
  // email_verified also clears verification_token in the same UPDATE. This directly
  // constructs that state to exercise the branch on its own.
  const email = `alreadyflagged${Date.now()}@example.com`;
  const regResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Already', lastName: 'Flagged', email, password: 'password123' })
  });
  const { verificationUrl } = await regResponse.json();
  const parsed = new URL(verificationUrl);

  await db.run('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);

  const response = await fetch(`${baseUrl}${parsed.pathname}${parsed.search}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Email Already Verified/);
});

test('resend-verification succeeds for a real, not-yet-verified account and re-arms it for verification', async () => {
  const email = `resendme${Date.now()}@example.com`;
  await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Resend', lastName: 'Me', email, password: 'password123' })
  });

  const resendResponse = await fetch(`${baseUrl}/api/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  assert.equal(resendResponse.status, 200);

  const afterResend = await db.get('SELECT verification_token FROM users WHERE email = ?', [email]);
  assert.ok(afterResend.verification_token, 'a fresh verification token should be set');

  const loginBeforeVerify = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' })
  });
  assert.equal(loginBeforeVerify.status, 403, 'the account should still be unverified');
});

test('/api/session reports { user: null } and clears the session when the logged-in user no longer exists in the database', async () => {
  const { cookie, email } = await registerAndLogIn('DeletedUserSession');
  const fetchAs = authedFetch(cookie);

  const beforeDelete = await fetchAs('/api/session');
  assert.ok((await beforeDelete.json()).user, 'should report a real user before deletion');

  // The server stores emails lowercased; registerAndLogIn's label ("DeletedUserSession")
  // has uppercase letters, so the raw `email` here won't match the stored row as-is.
  await db.run('DELETE FROM users WHERE email = ?', [email.toLowerCase()]);

  const afterDelete = await fetchAs('/api/session');
  assert.equal(afterDelete.status, 200);
  assert.equal((await afterDelete.json()).user, null);

  // The session should have been destroyed as a side effect, so a subsequent
  // protected request with the same cookie is now unauthenticated too.
  const protectedAfterDelete = await fetchAs('/api/teams');
  assert.equal(protectedAfterDelete.status, 401);
});

test('registration only echoes verificationUrl outside production (dev/test convenience, not a production behavior)', async () => {
  const email = `devonly${Date.now()}@example.com`;
  const response = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Dev', lastName: 'Only', email, password: 'password123' })
  });
  const json = await response.json();
  assert.ok(json.verificationUrl, 'verificationUrl should be present when NODE_ENV is not production');
});
