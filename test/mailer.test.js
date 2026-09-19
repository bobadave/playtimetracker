// src/mailer.js reads SMTP_* env vars once, at module-load time, to decide whether to
// build a real nodemailer transport. Every other test file runs with no SMTP env vars
// set, so `isConfigured` is always false there and `sendMail` always takes the
// no-transporter short-circuit. This file exercises the opposite branch by clearing
// the require cache and re-requiring the module after setting SMTP_* env vars, so the
// module body re-evaluates with a "configured" environment.
const test = require('node:test');
const assert = require('node:assert/strict');

const mailerPath = require.resolve('../src/mailer');

function loadMailerWithEnv(envOverrides) {
  delete require.cache[mailerPath];
  const originalEnv = { ...process.env };
  Object.assign(process.env, envOverrides);

  const restore = () => {
    delete require.cache[mailerPath];
    process.env = originalEnv;
  };

  try {
    return { mailer: require('../src/mailer'), restore };
  } catch (error) {
    restore();
    throw error;
  }
}

test('mailer.isConfigured is false and sendMail no-ops when no SMTP env vars are set', async () => {
  const { mailer, restore } = loadMailerWithEnv({
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: ''
  });

  try {
    assert.equal(mailer.isConfigured, false);
    const result = await mailer.sendMail({ to: 'nobody@example.com', subject: 'Test', text: 'Hi', html: '<p>Hi</p>' });
    assert.deepEqual(result, { delivered: false });
  } finally {
    restore();
  }
});

test('mailer.isConfigured is true and sendMail surfaces a delivery error when SMTP is configured but unreachable', async () => {
  const { mailer, restore } = loadMailerWithEnv({
    SMTP_HOST: '127.0.0.1',
    // Nothing listens on port 1 (a reserved, privileged port) on loopback, so the
    // connection is refused immediately — fast and deterministic, no real network
    // dependency or hanging timeout.
    SMTP_PORT: '1',
    SMTP_USER: 'test-user',
    SMTP_PASS: 'test-pass',
    SMTP_SECURE: 'false'
  });

  try {
    assert.equal(mailer.isConfigured, true, 'a transporter should be built once host/user/pass are all present');

    const result = await mailer.sendMail({ to: 'someone@example.com', subject: 'Test', text: 'Hi', html: '<p>Hi</p>' });
    assert.equal(result.delivered, false);
    assert.ok(result.error, 'a connection failure should surface an error message rather than throwing');
  } finally {
    restore();
  }
});
