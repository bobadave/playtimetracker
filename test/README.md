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

To see a line/branch/function coverage report for `src/`:

```bash
node --test --experimental-test-coverage --test-coverage-include='src/**'
```

This only measures server-side code (`src/`). It says nothing about
`public/` — see "Client-side-only logic" under Gaps below.

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
   `putOnField`/`takeOffField`, `logGoal`/`removeLastGoal`) so every test
   file exercises the same register → verify → log in → create team →
   create player → create game → clock in/out → log/remove goal flow a real
   user would, rather than seeding rows directly.
   It also exposes `rewindQuarterStartTime(gameId, quarterNumber, msAgo)`,
   which shifts a quarter's `game_quarter.start_time` and all of that game's
   `player_activity` rows back by the same delta — used wherever a test
   needs to simulate a quarter having timed out without actually waiting 10
   minutes. The quarter must already be open (someone clocked in during it)
   before this is called.
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
- `run`/`get`/`all` all reject their returned promise when the underlying SQL
  errors, instead of hanging or throwing synchronously.
- `initialize()` is idempotent: calling it a second time (what happens on
  every server restart against an existing database) preserves the default
  team's `team_name`/`user_admin_id` via `COALESCE` rather than clobbering
  them, and doesn't insert duplicate `schema_migrations`/default-game rows.

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
- Missing-field validation on login, password-reset request/confirm, and
  resend-verification (each 400), and visiting `/verify-email` with no
  token at all (400, distinct from an invalid-but-present one).
- `/verify-email`'s "Already Verified" branch — unreachable in normal
  operation since the only code path that sets `email_verified` also clears
  `verification_token` in the same update — is exercised directly by
  setting the flag while leaving the token in place.
- Resend-verification's success path for a real, not-yet-verified account
  (200, and a fresh `verification_token` is stored).
- `/api/session` reports `{ user: null }` and destroys the session (so a
  follow-up protected request also 401s) when the logged-in user's row has
  been deleted out from under an otherwise-valid session.

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
- A user with zero team memberships gets `{ teams: [] }` from `GET
  /api/teams` rather than an error.
- Joining with a missing/non-numeric/non-positive `teamId` is 400.
- Renaming to an empty/whitespace-only name is 400.
- Leaving a team the caller isn't a member of is 404.
- Reading a team whose row no longer exists but is still listed in the
  caller's own membership is 404 — not reachable through this app's normal
  flows (nothing lets a team row vanish while membership references
  survive), so it's constructed directly by deleting the row and reading
  it back, to exercise that defensive branch on its own.

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
- Updating a player with a non-numeric or non-positive id (`"abc"`, `-1`,
  `0`) is 400, before any database lookup.
- The roster endpoint (`GET /api/players`) excludes a player's recorded play
  time from an archived game: two games are given clean, non-overlapping
  100-second segments (deterministic, not dependent on real request timing —
  and non-overlapping specifically because `getCumulativeSummaryMap` merges
  activity rows across *all* of a player's games by timestamp, so overlapping
  windows would produce ambiguous results); archiving one drops
  `cumulativeSeconds` from 200 to exactly 100.

### 5. Games — `games.test.js`
- Every game-management endpoint requires authentication.
- Creating a game validates location/date and requires team access; defaults
  the name to "Soccer Match"; new games start paused (`is_active = 0`,
  `current_quarter = 1`, `finished_at = null`) — see the "Game Start"
  feature and the quarters section below.
- **Game Start**: a freshly created (paused) game rejects clock-ins with 409
  until `PUT /api/game/:gameId/status {isActive: true}` activates it —
  dragging players onto the field before that point must never start
  tracking their play time. Once activated, the first real clock-in opens
  quarter 1's `game_quarter` row.
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
- **Game Pause/Resume**: pausing (`PUT /api/game/:gameId/status` with
  `isActive: false`) closes out whoever is on the field exactly like ending
  the game does, and — critically — the server refuses any new clock-in
  while paused (409), so tracking genuinely cannot resume until the game is
  explicitly un-paused. This is what makes it safe for the client to let a
  coach freely add/remove players from the field while paused (see
  `pausedFieldPlayerIds` in `public/app.js`) without any of it becoming real
  play time early. After resuming (`isActive: true`), both a player who was
  on the field before pausing and one added to the field during the pause
  can be clocked in for real.
- **Timeout-status regression test**: the games list (`GET /api/games`)
  reflects a timed-out quarter as paused even when nobody has ever loaded
  that game's own page. `GET /api/game/:gameId` and `GET /api/players/:gameId`
  both apply quarter timeout enforcement before responding, but the list
  endpoint originally just returned whatever `is_active` was already
  stored — so a game's quarter could time out and it would still show
  "Active" in Game History until someone happened to open it directly. The
  test creates a game, times out quarter 1 via `rewindQuarterStartTime`,
  and asserts against the list endpoint only, never touching the individual
  game's endpoints, to make sure this can't regress.
- `GET /api/game/:gameId` for an unknown game is 404 (the legacy `GET
  /api/game` default-game endpoint is also smoke-tested).
- Creating a game via `month`/`day`/`year` fields assembles the same
  zero-padded `YYYY-MM-DD` date as passing `date` directly, and an
  incomplete month/day/year (e.g. a missing day) is 400 — this is a second,
  separate date-construction path from the one every other test exercises
  by passing `date` straight through.
- `PUT /api/game/:gameId/status` (the route the client's Game
  Start/Pause/Resume button actually calls): missing `isActive` is 400,
  an unknown game is 404, and no team access is 403 — the pause/resume
  regression test above only exercises this route's success paths.
- `PUT /api/games/unarchive` is rejected (403) for a team the caller
  doesn't belong to.
- `PUT /api/games/:gameId` (edit form): an unknown game is 404, and an
  invalid date string is 400.
- `PUT /api/games/:gameId/archive` for an unknown game is 404.

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
- `GET /api/stage` (the legacy default-game variant, no `:gameId`) reflects
  a player being clocked in and out of the seeded default game (id 1) — the
  `:gameId` variant above was already covered, but the default-game one
  wasn't. The test joins the seeded default team to get access.

### 7. Goal tracking (player actions) — `player-actions.test.js`
Covers the `player_action` table and the "log a goal" / "undo last goal"
feature built on top of it.
- `POST /api/player-actions` requires authentication, a valid `playerId`, and
  a recognized `action` — today the only enumerated value is `'goal'`,
  guarding the table's `CHECK (action IN ('goal'))` constraint.
- Logging a goal for an unknown or archived player is 404; on an unknown game
  is 404; on a game the caller lacks access to is 403.
- **On-field requirement**: a goal can only be logged while the player is
  currently on the field (409 otherwise) — mirrors the same rule the goal
  button's confirmation popup relies on client-side.
- Goals accumulate per player *per game*, reflected in the `goals` field of
  `GET /api/players/:gameId` (2 goals → `goals: 2`, etc.).
- **Cross-game isolation regression test**: a goal scored in one game must
  never show up when viewing a different game (a player can appear in
  multiple games over a season) — verified by scoring in Game A, then
  checking Game B's player list shows `goals: 0` for that same player.
- `DELETE /api/player-actions` (undo the last goal) requires the same
  authentication/validation/team-access checks as logging one, including an
  unknown game (404) — logging's version of this check was already covered,
  removing's wasn't.
- Removing a goal with none recorded is 404; repeated removals decrement the
  count one at a time and 404 once it reaches zero (there's nothing left to
  undo).
- Removing a goal only affects the targeted game — scoring in both Game A
  and Game B, then removing one from Game B, leaves Game A's count
  untouched.
- **Roster all-time totals**: `GET /api/players` reports `cumulativeGoals`
  summed across *every* game a player has played, not just the current
  game — this backs the roster page's all-time goals bar chart. A separate
  test confirms goals scored in an archived game are excluded from that
  total, mirroring how `cumulativeSeconds` already excludes archived-game
  playtime.

### 8. Quarters (10-minute auto-end, "End Quarter", full-game lifecycle) — `quarters.test.js`
A soccer game here is 4 quarters of 10 minutes each, tracked in the
`game_quarter` table (one row per quarter a game has actually started,
created on that quarter's first clock-in, closed out — by timeout or the
"End Quarter" button — with an `end_time`). `games.current_quarter` tracks
which quarter a game is on; `games.finished_at` is set once quarter 4 ends,
and is the one true "this game is over" signal — a single quarter timing
out is *not* that, it just advances to the next quarter.
- `isQuarterTimedOut` as a pure boundary function of a quarter's
  `start_time` and the 10-minute limit.
- Quarter lifecycle: no `game_quarter` row exists until someone is clocked
  in; the first clock-in opens quarter 1's row; a second clock-in in the
  same quarter does not open a second row.
- A quarter past its 10-minute limit auto-closes every active player and
  advances `current_quarter` to the next one the next time anyone fetches
  the game — **unlike** the old single-timeout design, this is not a
  terminal state: `PUT .../status {isActive: true}` immediately succeeds
  again to start the next quarter, and a subsequent clock-in opens that
  quarter's own row.
- **Play-time cap regression test**: recorded play time can never exceed a
  quarter's 10-minute limit even when enforcement runs long after the
  boundary (simulated by pushing the quarter's `start_time` back by the
  limit *plus 20 hours* and confirming credited time still caps at ~10
  minutes, not ~20 hours). This is the same class of bug this suite once
  caught for the old 1-hour design, now guarded at the quarter level.
- **Isolation**: timing out one game's quarter never touches a sibling game
  on the same team, nor a different team's game or players — verified at
  the `is_active` level, the `inStage` level, and the raw `player_activity`
  row count (no stray close-out row leaks into an unrelated game).
- **`POST /api/game/:gameId/end-quarter`** ("End Quarter" button): requires
  authentication, team access, and an unfinished game; requires a quarter
  actually be in progress (`is_active = 1`) — 409 otherwise, both for a
  paused/not-yet-started game and for a game that has already finished. A
  started-but-empty quarter (nobody clocked in yet) can still be ended —
  there's just nothing to close out. Ending immediately after a clock-in
  records only a few seconds of play time, not the full 10 minutes —
  confirming the same `min(now, boundary)` capping logic that protects
  against *late* enforcement doesn't cap an *early*, manual end down to
  zero either.
- **Full-game regression test**: drives a game through all 4 quarters via
  `PUT .../status` + `POST .../end-quarter`, asserting `current_quarter`
  advances 1→2→3→4 (and does not advance past 4) and `finished_at` stays
  `null` until quarter 4 ends. Once finished, resuming, clocking a player
  in, and ending a(nother) quarter are all rejected with 409, and every
  quarter row has an `end_time`.

### 9. Profile — `profile.test.js`
- Profile endpoints require authentication.
- Updating name requires both first and last name and persists (visible via
  `/api/session` immediately after).
- Changing password enforces the 6-character minimum, and the new password
  (not the old one) works on the next login.

### 10. Cross-cutting access control — `access-control.test.js`
This file exists specifically so authorization regressions can't hide inside
a single feature file. It doesn't test business logic — every other file
does that — it tests the authorization *gate* in front of it, as one matrix:
- Every data-bearing API endpoint (the full list, ~24 routes) rejects a
  request carrying no session cookie at all with 401.
- A logged-in user with **zero** team memberships is refused (403) on every
  team-scoped read and write for a team they don't belong to.
- A logged-in user who *does* belong to a team (just not the one being
  accessed) is still refused — membership is checked per-team, not just
  "is this user logged in."

### 11. Page routes — `pages.test.js`
`src/routes/pages.js` serves the app's HTML shell pages (as opposed to the
JSON API every other file talks to) — login/register/forgot-password/
reset-password, the logged-in-only teams/profile pages, the team-scoped
roster/games/new-game pages and their un-scoped `/roster`, `/games`,
`/new-game` shortcuts, the game-detail page, static asset serving, and the
catch-all. Nothing else in the suite ever requests these routes.
- `/` redirects to `/login` logged out, `/teams` logged in.
- The logged-out-only pages (login, register, forgot/reset-password) serve
  HTML when logged out and redirect to `/teams` when already logged in.
- The logged-in-only pages (`/teams`, `/profile`) redirect to `/login` when
  logged out and serve HTML when logged in.
- The un-scoped shortcuts (`/roster`, `/games`, `/new-game`) redirect to
  `/login` when logged out, and to `/t<defaultTeamId>/...` when logged in.
- The team-scoped pages (`/t:teamId/roster`, `/games`, `/new-game`) serve
  HTML for a member, redirect a non-member to `/teams`, and redirect a
  logged-out request to `/login`.
- `/games/:gameId` redirects to that game's own team path when the game
  exists, and falls back to the default team when it doesn't.
- `/t:teamId/games/:gameId` follows the same member/non-member/logged-out
  pattern as the other team-scoped pages.
- A static asset (`/styles.css`) is served, and an unrecognized path falls
  through to the catch-all `index.html`.

### 12. Mailer — `mailer.test.js`
`src/mailer.js` decides once, at module load, whether to build a real SMTP
transporter, based on `SMTP_*` env vars — every other test file runs with
none of those set, so `isConfigured` is always false there. This file
clears the require cache and re-requires the module after setting `SMTP_*`
env vars, so its top-level code re-evaluates against a "configured"
environment, to reach the branch nothing else does.
- With no SMTP env vars set, `isConfigured` is `false` and `sendMail`
  no-ops, returning `{ delivered: false }` without attempting a connection.
- With `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` all set, `isConfigured` is `true`
  and a real transporter is built; pointing it at `127.0.0.1:1` (a
  privileged port nothing listens on — an immediate, deterministic
  `ECONNREFUSED`, not a real network dependency or a hanging timeout) makes
  `sendMail` surface `{ delivered: false, error }` rather than throwing.
  See Gaps for why the actual successful-send branch isn't covered.

### 13. Server entrypoint — `server-entrypoint.test.js`
Every other file requires `src/server.js` as a module, so `if
(require.main === module) { startServer().catch(...) }` at the bottom of
that file never runs (`require.main` is the test runner, not `server.js`).
This file spawns `node src/server.js` as a real child process — the actual
way this app is started in production — to cover both branches.
- A normal start: spawned with a fresh `DB_PATH`/`PORT`, polled until it
  responds, `GET /login` returns 200, nothing is logged to stderr.
- A failed start: spawned with `DB_PATH` pointing at a file that exists but
  isn't a valid SQLite database (`SQLITE_NOTADB`), which makes
  `db.initialize()`'s very first statement reject cleanly. The process is
  asserted to exit with code 1 and log `Failed to start server:` to stderr.
  (A path that can't be *opened* at all — e.g. pointing at a directory —
  was deliberately avoided: `sqlite3` surfaces that as an unhandled
  `'error'` event on the `Database` instance, which crashes the process
  before `startServer()`'s promise chain ever gets a chance to reject, so
  it wouldn't actually exercise the `.catch()` branch this test targets.)

### 14. Internal library unit tests — `lib-units.test.js`
Direct, no-HTTP-route unit tests for `src/lib/*` functions whose guard
clauses or entire bodies aren't naturally exercised through the app's own
call sites (which normally only ever call them with legitimate, truthy
input from a real session).
- `parseUserTeamIds` (`src/lib/teams.js`): empty/null/malformed-JSON input
  all safely return `[]`; malformed JSON is caught, not thrown; non-numeric
  and non-positive entries are filtered out of otherwise-valid arrays.
- `userHasTeamAccess` and `getCurrentUserTeamIds`: both short-circuit to
  `false`/`[]` for a missing `userId` (or, for the former, an invalid
  `teamId`) without a database round-trip.
- `syncUserTeamMembership`: a no-op that resolves without throwing when
  given a missing `userId` or `teamId`.
- `requireAuth` (`src/lib/session.js`, Express middleware): defined but
  never actually wired into any route in this codebase, so it's invoked
  directly here with hand-built mock `req`/`res`/`next` — 401s an
  unauthenticated request without calling `next()`, calls `next()` for an
  authenticated one without writing a response.
- `getCumulativePlayerSeconds` (`src/lib/activity.js`): exported but never
  called by any route (the roster endpoint uses the batch
  `getCumulativeSummaryMap` instead) — called directly to confirm it sums a
  player's time across their non-archived games and excludes archived ones,
  the same guarantee `players.test.js` verifies for the route-facing
  version.

## Gaps: what this suite cannot verify

Some things are out of reach for an automated HTTP-level suite, or would cost
far more to automate than they're worth for this app's size. These need
manual verification — when touching the related code, check them by hand
before shipping.

- **Real email delivery.** Registration/password-reset tests never talk to
  SMTP; `sendMail` no-ops when SMTP env vars are unset (the default there),
  and verification/reset links are consumed directly from the JSON response
  instead of an inbox. `mailer.test.js` separately covers the "SMTP
  configured but the connection fails" branch against an unreachable fake
  host, but a genuinely *successful* send — the `return { delivered: true }`
  branch after `await transporter.sendMail(...)` resolves — is still
  untested: it would need either a real SMTP server or a hand-rolled fake
  one that correctly speaks enough of the SMTP protocol for `nodemailer` to
  complete a session against it, and this project doesn't currently depend
  on a library for either. Also untested: actual Gmail/SMTP auth working,
  email formatting/rendering in a real mail client, spam filtering, and the
  production codepath where `verificationUrl` is *not* echoed back in the
  API response (since `IS_PRODUCTION` is never true in the test process) —
  that path can only be exercised by registering against a real deployment
  with `NODE_ENV=production` and checking the inbox.
- **A broken session store on logout.** `POST /api/logout`'s `if (error) {
  return res.status(500)... }` branch only runs if `req.session.destroy()`
  itself fails — with the default in-memory `express-session` store used
  everywhere in this suite, destroy essentially never fails, and there's no
  way to inject a broken store from outside an HTTP request. Untested.
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
- **Client-side-only logic.** This suite talks to the API, not a browser, so
  any behavior implemented purely in `public/*.html`/`public/*.js` with no
  server round-trip is untested. On the Game History page specifically:
  sorting games by date descending, the collapsed/expanded row toggle
  (mirroring the My Teams page's pattern), and the Active/Ended status badge
  shown on the collapsed row are all client-side rendering with no
  corresponding `node:test` coverage. On the game page: the "Confirm goal
  for `<player>`" and "Remove last goal for `<player>`?" Yes/No popups
  (`showConfirmPopup`/`resolveConfirmPopup` in `public/app.js`) only decide
  *whether* to call the already-tested `POST`/`DELETE /api/player-actions`
  endpoints — the confirmation gating itself has no server round-trip to
  assert against; the live-ticking Share/Time clock (`tickPlayerTimes`)
  that extrapolates a player's elapsed time between the 10-second polls is
  pure client-side math; and the Game Pause/Resume feature's pending-edit
  state (`pausedFieldPlayerIds`) — letting a coach drag players on/off the
  field while paused without it becoming real play time until Resume — is
  entirely a `public/app.js` variable with no corresponding server state,
  so only the server-side contract it depends on (covered in the Games
  section above) is tested, not the client's bookkeeping itself. The same
  applies to the quarter progress bar under the field (`renderQuarterProgress`
  /`getQuarterState`, which turns `game.quarters` + `current_quarter` +
  `isGameActive` into upcoming/active/paused/completed segments) and the
  "End Quarter" button's confirmation popup — both are pure client rendering
  and gating on top of already-tested endpoints. All of
  these were verified manually during development but are not part of
  `npm test` — a regression here would only be caught by manual testing or
  by adding a browser-driven suite (e.g. Playwright) alongside this one.
- **Cross-browser behavior.** The suite talks to the Express API directly; it
  never loads a page in an actual browser engine, so client-side JS bugs
  (rendering, event wiring, `fetch` polyfill gaps) in Safari/Firefox/older
  Chrome are not caught. Spot-check manually, especially on Safari given this
  app's iPhone-heavy user base.
- **True elapsed-time behavior.** The 10-minute quarter timeout is tested by
  rewriting a `game_quarter` row's `start_time` in the database, not by
  actually waiting 10 minutes. This proves the enforcement *logic* is
  correct but never proves the real-time interval itself is exactly 600
  seconds end-to-end in a live deployment (clock drift, server timezone
  misconfiguration, etc.).
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
