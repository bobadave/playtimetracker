const PORT = process.env.PORT || 3000;
const DEFAULT_GAME_ID = 1;
const DEFAULT_TEAM_ID = 1;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

module.exports = {
  PORT,
  DEFAULT_GAME_ID,
  DEFAULT_TEAM_ID,
  IS_PRODUCTION,
  APP_BASE_URL
};
