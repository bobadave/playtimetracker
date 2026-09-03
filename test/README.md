# Test Plan

This document is the test plan for Game Time Tracker's automated suite: what
is covered, where, and — just as important — what isn't covered and has to be
checked by hand. It should stay in sync with `test/*.test.js`; when a feature
changes, update the relevant section here alongside the test file.

## Running the suite

```bash
npm test
```

This runs `node --test`, which auto-discovers every `test/*.test.js` file.
Each file runs in its own child process (Node's default for the built-in test
runner), which is why each one is free to point the app at its own disposable
SQLite database without interfering with the others.

## How these tests work

Every test file except `db-and-utils.test.js` follows the same shape:

1. `test/helpers.js` sets `process.env.DB_PATH` to a fresh temp file (via
   `fs.mkdtempSync`) and `process.env.PORT=0` **before** requiring
   `../src/db` or `../src/server`. This is only possible because `src/db.js`
   reads `process.env.DB_PATH` at module load, falling back to the real
   `data/game_time_tracker.db` path when unset — added specifically to make
   this kind of isolation possible.
2. `startTestServer()` calls the app's own `startServer()` and lets the OS
   assign an ephemeral port (`PORT=0`), then resolves the real port from the
   returned `http.Server`.
3. Tests drive the app exactly as a browser would: real HTTP requests via
   Node's built-in `fetch` against `http://localhost:<port>`, with a small
   hand-rolled cookie jar (`authedFetch(cookie)`) standing in for the browser,
   since `fetch` doesn't persist cookies across calls on its own.
4. `test/helpers.js` exposes shared setup building blocks
   (`registerAndLogIn`, `createTeam`, `createPlayer`, `createGame`,
   `putOnField`/`takeOffField`) so every test file exercises the same
   register → verify → log in → create team → create player → create game →
   clock in/out flow a real user would, rather than seeding rows directly.
5. Nothing is manually cleaned up between tests — each file's database is
   thrown away (`fs.rmSync`) in `test.after`, and within a file, tests create
   their own uniquely-named users/teams/players/games so they don't collide.

This means the suite is deliberately **integration-style**, not mocked-unit-style:
it exercises real routes, real session cookies, and a real (if temporary)
SQLite database on every test. The trade-off is slower tests in exchange for
tests that catch the actual class of bugs this app has had historically —
missing auth checks, cross-tenant data leaks, and timestamp/timezone logic
bugs — none of which a mocked unit test would have caught.

## Test plan by area

### 1. Database layer & pure utilities — `db-and-utils.test.js`
- `resolveGameId` falls back to the default game for invalid input.
- `summarizeActivityRows` correctly sums duration across alternating
  active/inactive segments.
- `createDbApi` initializes a correct fresh schema (tables, default team,
  default game, seeded players) from nothing.
- `createDbApi` upgrades a legacy database missing `team_id` columns via
  `ensureColumn`, without losing existing data.

### 2. Authentication & account lifecycle — `auth.test.js`
- Registration: required-field validation, password minimum length,
  duplicate-email rejection (409), and email normalization (trim + lowercase)
  so `Foo@Example.com ` and `foo@example.com` collide as the same account.
- Login: wrong password (401), unknown email (401), unverified email (403).
- Email verification: invalid token (400), valid token unlocks login,
  the token is single-use (a second visit to the same link is rejected, not
  silently treated as "already verified" — that branch is for a different
  state entirely).
- Resend verification: unknown email (404), already-verified account (409).
- Logout: destroys the session so subsequent authenticated requests 401.
- `/api/session` reports `{ user: null }` with no cookie.
- Password reset: unknown email (404), invalid token (400), expired token
  (400, simulated by rewriting `reset_expires_at` into the past), full
  request → confirm flow ends with the old password rejected and the new one
  accepted, and the reset token is single-use.
- `verificationUrl` is only echoed back in the registration response outside
  production (`NODE_ENV !== 'production'`) — this is what lets the test
  suite verify accounts without a real inbox; see the Gaps section for why
  that also means the *production* codepath (`IS_PRODUCTION === true`) isn't
  exercised.

### 3. Teams — `teams.test.js`
- Every team endpoint requires authentication.
- Creating a team requires a name, rejects duplicates (409), and immediately
  grants the creator membership.
- A non-member cannot read or rename a team (403), and a rejected rename
  doesn't leak through.
- Renaming to a name already used by another team is rejected (409).
- The team directory only lists teams the caller hasn't joined; joining moves
  a team out of the directory and grants read access; joining twice is 409;
  joining an unknown team is 404; leaving (`DELETE .../membership`) revokes
  access, puts the team back in the directory, and does **not** delete the
  team itself for other members.

### 4. Players — `players.test.js`
- Every player endpoint requires authentication.
- Creating a player requires both names and requires team membership — this
  specifically guards a real bug found in this codebase: `POST /api/players`
  originally had **no auth check at all**, letting any request create
  players on any team.
- The roster list is scoped to the caller's team and excludes archived
  players unless `includeArchived=true` is passed; an outsider is refused.
- Editing a player: rename, the empty-name validation, archiving/unarchiving
  a single player, a no-op update body (400), a 404 for an unknown player id,
  and a 403 for editing another team's player.
- Bulk unarchive (`PUT /api/players/unarchive`) only restores archived
  players on the caller's own team, never a different team's, even though
  both are "archived" in the same table.

### 5. Games — `games.test.js`
- Every game-management endpoint requires authentication.
- Creating a game validates location/date and requires team access; defaults
  the name to "Soccer Match"; new games start with `is_active = 1` and
  `start_time = null`.
- The games list is scoped to the caller's teams (with and without an
  explicit `teamId`) and the `archived` filter works.
- Editing a game (`PUT /api/games/:gameId`) validates its fields, requires
  team access, and — critically — ending a game through the edit form
  (`isActive: false`) closes out any players still on the field exactly like
  the dedicated status endpoint does, rather than just flipping the
  `is_active` flag and leaving stale "in play" rows behind. (This endpoint
  used to have its own separate, un-capped close-out logic, duplicated from
  before the play-time cap fix — it's now refactored to share the same
  `closeOutActivePlayers` helper as everything else.)
- Archiving/unarchiving a single game, and bulk-unarchiving a team's archived
  games without touching another team's archived games.

### 6. Player clock-in/clock-out segments — `segments.test.js`
- `POST /api/segments` requires authentication and validates `playerId` /
  `inPlay`.
- Clocking in an unknown or archived player is 404.
- Clocking in on an unknown game is 404; on a game the caller lacks access to
  is 403.
- State machine correctness: can't clock in twice in a row (409), can't clock
  out unless currently active (409), and re-entering after a clock-out works.
- `/api/stage/:gameId` reflects only players whose *latest* activity row is
  "in play," correctly scoped per game (a player on Game A's field doesn't
  show up on Game B's stage).
- A full clock-in → clock-out cycle is reflected in `totalSeconds` and the
  `inStage` flag on both the segment response and the roster endpoint.

### 7. Game timeout (1-hour auto-end) — `game-timeout.test.js`
- `isGameTimedOut` as a pure boundary function.
- `start_time` lifecycle: `null` on creation, stamped by the first player to
  take the field, unchanged by subsequent players.
- A game past the 1-hour limit auto-closes every active player and flips
  `is_active` to 0 the next time anyone fetches it; new players are then
  rejected (409) and the game cannot be resumed (409).
- **Play-time cap regression test**: recorded play time can never exceed the
  game's 1-hour limit even when enforcement runs long after the boundary
  (simulated by pushing `start_time` back by the limit *plus 20 hours* and
  confirming credited time still caps at ~1 hour, not ~21). This reproduces
  the exact bug reported in production, where a game that timed out
  overnight credited a player 1200+ minutes because the close-out row was
  timestamped whenever someone next loaded the page rather than at the
  actual 1-hour mark.
- **Isolation**: timing out one game never touches a sibling game on the
  same team, nor a different team's game or players — verified at the
  `is_active` level, the `inStage` level, and the raw `player_activity` row
  count (no stray close-out row leaks into an unrelated game).

### 8. Profile — `profile.test.js`
- Profile endpoints require authentication.
- Updating name requires both first and last name and persists (visible via
  `/api/session` immediately after).
- Changing password enforces the 6-character minimum, and the new password
  (not the old one) works on the next login.

### 9. Cross-cutting access control — `access-control.test.js`
This file exists specifically so authorization regressions can't hide inside
a single feature file. It doesn't test business logic — every other file
does that — it tests the authorization *gate* in front of it, as one matrix:
- Every data-bearing API endpoint (the full list, ~23 routes) rejects a
  request carrying no session cookie at all with 401.
- A logged-in user with **zero** team memberships is refused (403) on every
  team-scoped read and write for a team they don't belong to.
- A logged-in user who *does* belong to a team (just not the one being
  accessed) is still refused — membership is checked per-team, not just
  "is this user logged in."

## Gaps: what this suite cannot verify

Some things are out of reach for an automated HTTP-level suite, or would cost
far more to automate than they're worth for this app's size. These need
manual verification — when touching the related code, check them by hand
before shipping.

- **Real email delivery.** The suite never talks to SMTP; `sendMail` no-ops
  when SMTP env vars are unset (the default in tests), and verification/reset
  links are consumed directly from the JSON response instead of an inbox.
  Untested: actual Gmail/SMTP auth working, email formatting/rendering in a
  real mail client, spam filtering, and the production codepath where
  `verificationUrl` is *not* echoed back in the API response (since
  `IS_PRODUCTION` is never true in the test process) — that path can only be
  exercised by registering against a real deployment with `NODE_ENV=production`
  and checking the inbox.
- **Touch drag-and-drop gestures.** The custom touch drag-and-drop system in
  `public/app.js` (drag handle, edge-of-screen auto-scroll) responds to real
  `touchstart`/`touchmove`/`touchend` events and viewport geometry. This
  needs a real device or Playwright's CDP-level synthetic touch dispatch,
  not `node:test`. Manually verify on an actual phone after any change to
  `setupTouchDragAndDrop`, `startEdgeScrollLoop`, or the drag-handle markup.
- **Visual/responsive rendering.** Layout on small screens (iOS Safari, small
  Android viewports), the countdown timer's color/size in both light and dark
  system themes, and general CSS regressions are not covered — there's no
  visual regression tooling in this project. Manually check in a real mobile
  browser after CSS/layout changes.
- **Cross-browser behavior.** The suite talks to the Express API directly; it
  never loads a page in an actual browser engine, so client-side JS bugs
  (rendering, event wiring, `fetch` polyfill gaps) in Safari/Firefox/older
  Chrome are not caught. Spot-check manually, especially on Safari given this
  app's iPhone-heavy user base.
- **True elapsed-time behavior.** The 1-hour timeout is tested by rewriting
  `start_time` in the database, not by actually waiting an hour. This proves
  the enforcement *logic* is correct but never proves the real-time interval
  itself is exactly 3600 seconds end-to-end in a live deployment (clock
  drift, server timezone misconfiguration, etc.).
- **True concurrency / race conditions.** Tests issue requests sequentially
  per scenario. Two real users clocking the same player in at the exact same
  instant, or two browser tabs both submitting a game edit, could race in
  ways sequential `await` calls in a test never trigger. SQLite's single
  writer semantics make some of this moot, but request-level races (e.g. two
  concurrent `POST /api/segments` for the same player) are not exercised.
- **Deployment / infrastructure.** PM2 process management, Nginx reverse
  proxy config, certbot/Let's Encrypt renewal, and `.env`/`DB_PATH` behavior
  on the actual VPS are entirely outside this suite's reach. These were
  manually verified during deployment and should be manually re-checked
  after infra changes.
- **Load and performance.** No load testing exists for concurrent users,
  large rosters, or a large `player_activity` history. `summarizeActivityRows`
  is O(n) per player per request with no pagination or caching — fine at
  today's scale, unverified beyond it.
- **Accessibility beyond basic attributes.** The suite doesn't drive a
  screen reader or verify keyboard-only navigation; only the presence of a
  handful of `aria-*` attributes is implied by the frontend code, not tested.
- **Bug-report widget and external links.** The floating bug-report icon
  links out to a real GitHub issues page; that link and the modal's exact
  copy are not covered by any automated check.
