const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestServer,
  stopTestServer,
  getBaseUrl,
  registerAndLogIn,
  authedFetch
} = require('./helpers');

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
});

test('profile endpoints require authentication', async () => {
  const fetchAs = authedFetch(null);

  assert.equal((await fetchAs('/api/profile', { method: 'PUT', body: JSON.stringify({ firstName: 'A', lastName: 'B' }) })).status, 401);
  assert.equal((await fetchAs('/api/profile/password', { method: 'PUT', body: JSON.stringify({ password: 'password123' }) })).status, 401);
});

test('updating profile name requires both first and last name, and persists the change', async () => {
  const { cookie } = await registerAndLogIn('ProfileName');
  const fetchAs = authedFetch(cookie);

  const missingLastName = await fetchAs('/api/profile', {
    method: 'PUT',
    body: JSON.stringify({ firstName: 'OnlyFirst', lastName: '' })
  });
  assert.equal(missingLastName.status, 400);

  const updateResponse = await fetchAs('/api/profile', {
    method: 'PUT',
    body: JSON.stringify({ firstName: 'Updated', lastName: 'Name' })
  });
  assert.equal(updateResponse.status, 200);
  const { user } = await updateResponse.json();
  assert.equal(user.firstName, 'Updated');
  assert.equal(user.lastName, 'Name');

  const sessionResponse = await (await fetchAs('/api/session')).json();
  assert.equal(sessionResponse.user.firstName, 'Updated');
});

test('changing password enforces the 6 character minimum and the new password works on next login', async () => {
  const { cookie, email } = await registerAndLogIn('ProfilePassword');
  const fetchAs = authedFetch(cookie);

  const tooShort = await fetchAs('/api/profile/password', {
    method: 'PUT',
    body: JSON.stringify({ password: '12345' })
  });
  assert.equal(tooShort.status, 400);

  const blank = await fetchAs('/api/profile/password', {
    method: 'PUT',
    body: JSON.stringify({ password: '' })
  });
  assert.equal(blank.status, 400);

  const updateResponse = await fetchAs('/api/profile/password', {
    method: 'PUT',
    body: JSON.stringify({ password: 'newpassword456' })
  });
  assert.equal(updateResponse.status, 200);

  await fetchAs('/api/logout', { method: 'POST' });

  const baseUrl = getBaseUrl();
  const oldPasswordLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' })
  });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'newpassword456' })
  });
  assert.equal(newPasswordLogin.status, 200);
});
