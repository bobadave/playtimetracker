require('dotenv').config();

const express = require('express');
const session = require('express-session');
const db = require('./db');
const { PORT, IS_PRODUCTION } = require('./config');

const { resolveGameId, isGameTimedOut, GAME_TIME_LIMIT_MS } = require('./lib/gameTime');
const { resolveTeamId } = require('./lib/teams');
const {
  summarizeActivityRows,
  getPlayerSummary,
  getCumulativePlayerSeconds,
  getActivitySummaryMap,
  getCumulativeSummaryMap
} = require('./lib/activity');
const { getGoalCountMap } = require('./lib/goals');

const gamesRouter = require('./routes/games');
const playersRouter = require('./routes/players');
const teamsRouter = require('./routes/teams');
const segmentsRouter = require('./routes/segments');
const playerActionsRouter = require('./routes/playerActions');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const pagesRouter = require('./routes/pages');

const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'soccer-tracker-demo-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION
  }
}));

app.use(gamesRouter);
app.use(playersRouter);
app.use(teamsRouter);
app.use(segmentsRouter);
app.use(playerActionsRouter);
app.use(authRouter);
app.use(profileRouter);
// Serves page routes plus static assets and the catch-all — must stay mounted last
// so none of it shadows a more specific API route above.
app.use(pagesRouter);

async function startServer() {
  await db.initialize();

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`Soccer game tracker running at http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  resolveGameId,
  resolveTeamId,
  summarizeActivityRows,
  getPlayerSummary,
  getCumulativePlayerSeconds,
  getActivitySummaryMap,
  getCumulativeSummaryMap,
  getGoalCountMap,
  startServer,
  isGameTimedOut,
  GAME_TIME_LIMIT_MS
};
