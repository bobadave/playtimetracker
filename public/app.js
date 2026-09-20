const playerListEl = document.getElementById('player-list');
const stageEl = document.getElementById('stage');
const scoreboardEl = document.getElementById('scoreboard');
const goalPopupEl = document.getElementById('goal-popup');
let goalPopupTimeoutId = null;
const confirmPopupEl = document.getElementById('confirm-popup');
const confirmPopupMessageEl = document.getElementById('confirm-popup-message');
const confirmPopupYesBtn = document.getElementById('confirm-popup-yes');
const confirmPopupNoBtn = document.getElementById('confirm-popup-no');
let confirmPopupResolver = null;
const starsPopupEl = document.getElementById('stars-popup');
const starsPopupMessageEl = document.getElementById('stars-popup-message');
const starsPopupActionEl = document.getElementById('stars-popup-action');
const starsPopupStarsEl = document.getElementById('stars-popup-stars');
const starsPopupErrorEl = document.getElementById('stars-popup-error');
const starsPopupSubmitBtn = document.getElementById('stars-popup-submit');
const starsPopupCancelBtn = document.getElementById('stars-popup-cancel');
let starsPopupResolver = null;
const starsExplosionEl = document.getElementById('stars-explosion');
// Matches .popup-overlay's opacity/transform transition duration (0.3s) — the explosion
// is timed to start only once the stars popup has fully faded out, not on top of it.
const STARS_POPUP_FADE_MS = 300;
const gameIdDisplayEl = document.getElementById('game-id-display');
const gameNameDisplayEl = document.getElementById('game-name-display');
const teamNameDisplayEl = document.getElementById('team-name-display');
const gameMetaDisplayEl = document.getElementById('game-meta-display');
const gameToggleBtn = document.getElementById('game-toggle-btn');
const endQuarterBtn = document.getElementById('end-quarter-btn');
const gameCountdownWrapEl = document.getElementById('game-countdown-wrap');
const gameCountdownEl = document.getElementById('game-countdown');
const quarterProgressEl = document.getElementById('quarter-progress');
const gameFormEl = document.getElementById('game-form');
let isGameActive = true;
// True only once all 4 quarters have finished (the game's terminal state) — a single
// quarter timing out just advances to the next one and is not this.
let isGameFinished = false;
let currentQuarterNumber = 1;
// Whether the CURRENT quarter has an open game_quarter row (i.e. someone has been
// clocked in during it) — distinguishes "Game Resume" (already opened, just paused)
// from "Nth Quarter Start" (hasn't opened yet).
let currentQuarterHasOpened = false;
let latestPlayers = [];
let lastPlayersFetchMs = Date.now();
let pausedFieldPlayerIds = new Set();
const QUARTER_TIME_LIMIT_MS = 10 * 60 * 1000;
const QUARTER_ORDINALS = ['1st', '2nd', '3rd', '4th'];
let quarterStartTimeMs = null;
let countdownIntervalId = null;

function getQuarterOrdinal(quarterNumber) {
  return QUARTER_ORDINALS[quarterNumber - 1] || `${quarterNumber}th`;
}

function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateCountdownDisplay() {
  if (!Number.isFinite(quarterStartTimeMs)) {
    return;
  }

  const remainingMs = quarterStartTimeMs + QUARTER_TIME_LIMIT_MS - Date.now();
  gameCountdownEl.textContent = formatCountdown(remainingMs);

  if (remainingMs <= 0 && countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

function getCurrentGameId() {
  const match = window.location.pathname.match(/\/t\d+\/games\/(\d+)/) || window.location.pathname.match(/\/games\/(\d+)/);
  return match ? Number(match[1]) : 1;
}

async function fetchCurrentGame() {
  const gameId = getCurrentGameId();
  const response = await fetch(`/api/game/${gameId}`);
  if (!response.ok) {
    throw new Error('Unable to load current game.');
  }

  return response.json();
}

async function fetchPlayers() {
  const gameId = getCurrentGameId();
  const gameResponse = await fetch(`/api/game/${gameId}`);
  if (!gameResponse.ok) {
    throw new Error('Unable to load game details.');
  }

  const { game } = await gameResponse.json();
  const teamId = game && game.team_id ? game.team_id : 1;
  const response = await fetch(`/api/players/${gameId}?teamId=${teamId}`);
  if (!response.ok) {
    throw new Error('Unable to load players.');
  }

  return response.json();
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMinutes(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getSharePercentage(playerSeconds, totalSeconds) {
  if (!Number.isFinite(Number(playerSeconds)) || !Number.isFinite(Number(totalSeconds)) || Number(totalSeconds) <= 0) {
    return 0;
  }

  return (Number(playerSeconds) / Number(totalSeconds)) * 100;
}

function getRelativePlayLevel(playerSeconds, players) {
  const values = players.map((player) => Number(player.totalSeconds) || 0);
  if (!values.length) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return 0;
  }

  return (Number(playerSeconds) - mean) / stdDev;
}

function getPlayHighlightClass(playerSeconds, players) {
  const zScore = getRelativePlayLevel(playerSeconds, players);

  if (zScore <= -1.25) {
    return 'play-low';
  }

  if (zScore <= -0.5) {
    return 'play-medium';
  }

  return '';
}

function formatPercent(playerSeconds, totalSeconds) {
  return `${getSharePercentage(playerSeconds, totalSeconds).toFixed(1)}%`;
}

// The server only recomputes totalSeconds when we poll it (every 10s). Between polls we
// extrapolate on-field players' elapsed time locally so the displayed clock ticks every
// second instead of jumping once per poll — mirrors how the game countdown timer works.
function getLivePlayerSeconds(player, nowMs) {
  const baseSeconds = Number(player.totalSeconds) || 0;
  if (!player.inStage) {
    return baseSeconds;
  }

  return baseSeconds + Math.max(0, nowMs - lastPlayersFetchMs) / 1000;
}

function tickPlayerTimes() {
  if (!latestPlayers.some((player) => player.inStage)) {
    return;
  }

  const nowMs = Date.now();
  const liveSecondsById = new Map(latestPlayers.map((player) => [player.id, getLivePlayerSeconds(player, nowMs)]));
  const totalGameSeconds = Array.from(liveSecondsById.values()).reduce((sum, seconds) => sum + seconds, 0);

  document.querySelectorAll('[data-player-id]').forEach((cardEl) => {
    const playerId = Number(cardEl.dataset.playerId);
    if (!liveSecondsById.has(playerId)) {
      return;
    }

    const liveSeconds = liveSecondsById.get(playerId);
    const shareEl = cardEl.querySelector('[data-field="share"]');
    const timeEl = cardEl.querySelector('[data-field="time"]');
    if (shareEl) {
      shareEl.textContent = formatPercent(liveSeconds, totalGameSeconds);
    }
    if (timeEl) {
      timeEl.textContent = formatMinutes(liveSeconds);
    }
  });
}

const supportsTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

const dragHandleHtml = `
  <div class="drag-handle" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="5 9 2 12 5 15"></polyline>
      <polyline points="9 5 12 2 15 5"></polyline>
      <polyline points="15 19 12 22 9 19"></polyline>
      <polyline points="19 9 22 12 19 15"></polyline>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <line x1="12" y1="2" x2="12" y2="22"></line>
    </svg>
  </div>
`;

function attachDragHandlers(card, playerId) {
  card.dataset.playerId = String(playerId);

  if (supportsTouch) {
    return;
  }

  const handle = card.querySelector('.drag-handle');
  if (!handle) {
    return;
  }

  handle.draggable = true;
  handle.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', String(playerId));
    event.dataTransfer.effectAllowed = 'move';

    const handleRect = handle.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const offsetX = handleRect.left - cardRect.left + event.offsetX;
    const offsetY = handleRect.top - cardRect.top + event.offsetY;
    event.dataTransfer.setDragImage(card, offsetX, offsetY);
  });
}

function getQuarterState(quarterNumber, game, quarterRow) {
  if (quarterRow && quarterRow.end_time) {
    return 'completed';
  }

  if (quarterNumber === currentQuarterNumber && !isGameFinished) {
    if (isGameActive) {
      return 'active';
    }

    return quarterRow ? 'paused' : 'upcoming';
  }

  return 'upcoming';
}

function renderQuarterProgress(game) {
  const quarters = (game && game.quarters) || [];

  quarterProgressEl.innerHTML = [1, 2, 3, 4].map((quarterNumber) => {
    const quarterRow = quarters.find((q) => q.quarter_number === quarterNumber);
    const state = getQuarterState(quarterNumber, game, quarterRow);

    return `
      <div class="quarter-segment quarter-segment--${state}">
        <span class="quarter-segment-label">Q${quarterNumber}</span>
      </div>
    `;
  }).join('');
}

function renderGameHeader(game) {
  const gameId = game && game.id ? game.id : '--';
  const gameName = game && game.name ? game.name : 'Untitled Game';
  const location = game && game.location ? game.location : 'TBD';
  const date = game && game.date ? game.date : 'TBD';
  const teamName = game && (game.team_name || game.teamName) ? (game.team_name || game.teamName) : 'Default Team';

  gameNameDisplayEl.textContent = `Game: ${gameName}`;
  teamNameDisplayEl.textContent = `Team: ${teamName}`;
  gameIdDisplayEl.textContent = `Game ID: ${gameId}`;
  gameMetaDisplayEl.textContent = `Location: ${location} • ${date}`;
  isGameActive = !!(game && Number(game.is_active) !== 0);
  isGameFinished = !!(game && game.finished_at);
  currentQuarterNumber = (game && Number(game.current_quarter)) || 1;

  const quarters = (game && game.quarters) || [];
  const openQuarter = quarters.find((q) => q.quarter_number === currentQuarterNumber && !q.end_time);
  currentQuarterHasOpened = !!openQuarter;
  const openQuarterStartMs = openQuarter ? new Date(openQuarter.start_time).getTime() : null;

  if (isGameFinished) {
    gameToggleBtn.textContent = 'Game Ended';
    gameToggleBtn.disabled = true;
    gameToggleBtn.classList.remove('resume');
    gameToggleBtn.classList.add('ended');
    gameToggleBtn.setAttribute('aria-pressed', 'true');
  } else {
    gameToggleBtn.disabled = false;
    gameToggleBtn.classList.remove('ended');
    gameToggleBtn.textContent = isGameActive
      ? 'Game Pause'
      : (currentQuarterHasOpened ? 'Game Resume' : `${getQuarterOrdinal(currentQuarterNumber)} Quarter Start`);
    gameToggleBtn.classList.toggle('resume', !isGameActive);
    gameToggleBtn.setAttribute('aria-pressed', String(!isGameActive));
  }

  endQuarterBtn.hidden = false;
  endQuarterBtn.disabled = !isGameActive;

  stageEl.classList.toggle('disabled', isGameFinished);
  stageEl.setAttribute('aria-disabled', String(isGameFinished));

  const shouldShowCountdown = isGameActive && !isGameFinished && Number.isFinite(openQuarterStartMs);
  quarterStartTimeMs = shouldShowCountdown ? openQuarterStartMs : null;
  gameCountdownWrapEl.hidden = !shouldShowCountdown;

  if (shouldShowCountdown) {
    updateCountdownDisplay();
    if (!countdownIntervalId) {
      countdownIntervalId = setInterval(updateCountdownDisplay, 1000);
    }
  } else if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }

  renderQuarterProgress(game);
}

function showGoalPopup() {
  if (goalPopupTimeoutId) {
    clearTimeout(goalPopupTimeoutId);
  }

  goalPopupEl.classList.add('visible');
  goalPopupTimeoutId = setTimeout(() => {
    goalPopupEl.classList.remove('visible');
    goalPopupTimeoutId = null;
  }, 3000);
}

function showConfirmPopup(message) {
  return new Promise((resolve) => {
    confirmPopupResolver = resolve;
    confirmPopupMessageEl.textContent = message;
    confirmPopupEl.classList.add('visible');
  });
}

function resolveConfirmPopup(result) {
  confirmPopupEl.classList.remove('visible');
  const resolve = confirmPopupResolver;
  confirmPopupResolver = null;
  if (resolve) {
    resolve(result);
  }
}

function showStarsPopup(playerName) {
  return new Promise((resolve) => {
    starsPopupResolver = resolve;
    starsPopupMessageEl.textContent = `Log stars for ${playerName}`;
    starsPopupActionEl.value = '';
    starsPopupStarsEl.value = '1';
    starsPopupErrorEl.classList.add('hidden');
    starsPopupEl.classList.add('visible');
  });
}

function resolveStarsPopup(result) {
  starsPopupEl.classList.remove('visible');
  const resolve = starsPopupResolver;
  starsPopupResolver = null;
  if (resolve) {
    resolve(result);
  }
}

function showStarExplosion() {
  starsExplosionEl.innerHTML = '';

  const PARTICLE_COUNT = 12;
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const particle = document.createElement('span');
    particle.className = 'stars-explosion-particle';

    const angle = (360 / PARTICLE_COUNT) * i + (Math.random() * 16 - 8);
    const distance = 90 + Math.random() * 60;
    const radians = (angle * Math.PI) / 180;
    particle.style.setProperty('--dx', `${Math.cos(radians) * distance}px`);
    particle.style.setProperty('--dy', `${Math.sin(radians) * distance}px`);
    particle.style.setProperty('--rot', `${Math.random() * 360 - 180}deg`);
    particle.style.animationDelay = `${Math.random() * 80}ms`;
    particle.textContent = '★';

    starsExplosionEl.appendChild(particle);
  }

  setTimeout(() => {
    starsExplosionEl.innerHTML = '';
  }, 1000);
}

const SCOREBOARD_CATEGORIES = [
  { key: 'goals', label: 'Goals', action: 'goal', removeMode: 'last' },
  { key: 'effort', label: 'Effort', action: 'effort', removeMode: 'all' },
  { key: 'spirit', label: 'Spirit', action: 'spirit', removeMode: 'all' },
  { key: 'improvement', label: 'Improvement', action: 'improvement', removeMode: 'all' }
];

function renderScoreboard(players) {
  const rowsHtml = SCOREBOARD_CATEGORIES.map(({ key, label, action, removeMode }) => {
    const tallied = players.filter((player) => Number(player[key]) > 0);
    if (tallied.length === 0) {
      return '';
    }

    const pills = tallied.map((player) => {
      const value = player[key];
      const isGoals = removeMode === 'last';
      const pillClass = isGoals ? 'scorer-pill' : 'stars-tally-pill';
      const countClass = isGoals ? 'scorer-count' : 'stars-tally-count';
      const starHtml = isGoals ? '' : ` <span class="stars-tally-star" aria-hidden="true">★</span>`;
      return `<button type="button" class="${pillClass}" data-player-id="${player.id}" data-player-name="${escapeHtml(player.fullName)}" data-action="${action}" data-remove-mode="${removeMode}">${escapeHtml(player.fullName)}${starHtml} <span class="${countClass}">${value}</span></button>`;
    }).join('');

    return `<div class="scoreboard-row"><span class="scoreboard-label">${label}</span>${pills}</div>`;
  }).join('');

  if (!rowsHtml) {
    scoreboardEl.classList.add('hidden');
    scoreboardEl.innerHTML = '';
    return;
  }

  scoreboardEl.classList.remove('hidden');
  scoreboardEl.innerHTML = rowsHtml;
}

function renderPlayers(players) {
  latestPlayers = players;
  lastPlayersFetchMs = Date.now();

  const activePlayers = players.filter((player) => player.inStage);
  const pausedStagePlayers = players.filter((player) => !player.inStage && pausedFieldPlayerIds.has(player.id));
  const stagePlayers = [...activePlayers, ...pausedStagePlayers];
  const orderedPlayers = [...players].sort((a, b) => {
    if (Number(a.inStage) !== Number(b.inStage)) {
      return Number(a.inStage) - Number(b.inStage);
    }

    if (!a.inStage && !b.inStage) {
      return (Number(a.totalSeconds) || 0) - (Number(b.totalSeconds) || 0);
    }

    return 0;
  });
  const totalGameSeconds = players.reduce((sum, player) => sum + (Number(player.totalSeconds) || 0), 0);

  renderScoreboard(players);

  stageEl.innerHTML = '';

  if (stagePlayers.length === 0) {
    stageEl.classList.add('is-empty');
    const isPaused = !isGameFinished && !isGameActive;
    const resumeLabel = currentQuarterHasOpened ? 'Game Resume' : `${getQuarterOrdinal(currentQuarterNumber)} Quarter Start`;
    const emptyMessage = isGameFinished
      ? 'This game has ended.'
      : isGameActive
        ? 'Drop players on to field to track play time.'
        : `Drop players on to field. Tracking ${currentQuarterHasOpened ? 'resumes' : 'starts'} when you hit ${resumeLabel}.`;
    stageEl.innerHTML = `<div class="empty-state${isPaused ? ' empty-state-paused' : ''}">${emptyMessage}</div>`;
  } else {
    stageEl.classList.remove('is-empty');

    stagePlayers.forEach((player) => {
      const isPaused = !player.inStage && pausedFieldPlayerIds.has(player.id);
      const stagePlayer = document.createElement('div');
      const uiClass = getPlayHighlightClass(player.totalSeconds, players);
      stagePlayer.className = `stage-player${isPaused ? ' paused' : ''}`;
      if (uiClass) {
        stagePlayer.classList.add(uiClass);
      }
      stagePlayer.innerHTML = `
        ${dragHandleHtml}
        <div class="player-meta">
          <span class="player-name">${escapeHtml(player.fullName)}</span>
          <span class="status-pill active">On field</span>
        </div>
        <button type="button" class="goal-btn" ${isGameActive ? '' : 'disabled'}>Goal</button>
        <button type="button" class="stars-btn" ${isGameActive ? '' : 'disabled'}>Stars</button>
        <div class="time-box">
          <div class="metric-group">
            <span class="time-label">Time</span>
            <span class="time-value" data-field="time">${formatMinutes(player.totalSeconds)}</span>
          </div>
        </div>
      `;
      attachDragHandlers(stagePlayer, player.id);
      stageEl.appendChild(stagePlayer);
    });
  }

  playerListEl.innerHTML = '';

  orderedPlayers.forEach((player) => {
    const playerCard = document.createElement('div');
    const uiClass = getPlayHighlightClass(player.totalSeconds, players);
    playerCard.className = `player-card ${player.inStage ? 'active' : ''}`;
    if (uiClass) {
      playerCard.classList.add(uiClass);
    }
    playerCard.innerHTML = `
      ${dragHandleHtml}
      <div class="player-meta">
        <span class="player-name">${escapeHtml(player.fullName)}</span>
        <span class="status-pill ${player.inStage ? 'active' : 'inactive'}">${player.inStage ? 'On field' : 'Bench'}</span>
      </div>
      <button type="button" class="stars-btn" ${isGameFinished ? 'disabled' : ''}>Stars</button>
      <div class="time-box">
        ${player.inStage ? '' : `
        <div class="metric-group">
          <span class="time-label">Share</span>
          <span class="time-value" data-field="share">${formatPercent(player.totalSeconds, totalGameSeconds)}</span>
        </div>
        `}
        <div class="metric-group">
          <span class="time-label">Time</span>
          <span class="time-value" data-field="time">${formatMinutes(player.totalSeconds)}</span>
        </div>
      </div>
    `;
    attachDragHandlers(playerCard, player.id);
    playerListEl.appendChild(playerCard);
  });
}

async function logPlayerActivity(playerId, inPlay) {
  if (isGameFinished) {
    return;
  }

  if (!isGameActive) {
    // Paused: field membership can still change, but it's only a pending change until
    // the game is resumed — don't touch the server or start/stop the play-time clock yet.
    if (inPlay) {
      pausedFieldPlayerIds.add(playerId);
    } else {
      pausedFieldPlayerIds.delete(playerId);
    }
    renderPlayers(latestPlayers);
    return;
  }

  const gameId = getCurrentGameId();
  const response = await fetch('/api/segments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ playerId, inPlay, gameId })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to update player activity.');
    return;
  }

  const updatedPlayers = await fetchPlayers();
  renderPlayers(updatedPlayers);
}

async function logGoal(playerId) {
  const gameId = getCurrentGameId();
  const response = await fetch('/api/player-actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ playerId, gameId, action: 'goal' })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to record the goal.');
    return;
  }

  showGoalPopup();

  const updatedPlayers = await fetchPlayers();
  renderPlayers(updatedPlayers);
}

async function handleGoalButtonClick(playerId, playerName) {
  const confirmed = await showConfirmPopup(`Confirm goal for ${playerName}`);
  if (!confirmed) {
    return;
  }

  await logGoal(playerId);
}

async function removeLastGoal(playerId) {
  const gameId = getCurrentGameId();
  const response = await fetch(`/api/player-actions?playerId=${playerId}&gameId=${gameId}&action=goal`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to remove the goal.');
    return;
  }

  const updatedPlayers = await fetchPlayers();
  renderPlayers(updatedPlayers);
}

async function handleRemoveGoalClick(playerId, playerName) {
  const confirmed = await showConfirmPopup(`Remove last goal for ${playerName}?`);
  if (!confirmed) {
    return;
  }

  await removeLastGoal(playerId);
}

async function removeAllStars(playerId, action) {
  const gameId = getCurrentGameId();
  const response = await fetch(`/api/player-actions?playerId=${playerId}&gameId=${gameId}&action=${action}&all=true`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to remove the stars.');
    return;
  }

  const updatedPlayers = await fetchPlayers();
  renderPlayers(updatedPlayers);
}

async function handleRemoveAllStarsClick(playerId, playerName, action) {
  const label = action.charAt(0).toUpperCase() + action.slice(1);
  const confirmed = await showConfirmPopup(`Delete all ${label} entries for ${playerName} in this game?`);
  if (!confirmed) {
    return;
  }

  await removeAllStars(playerId, action);
}

async function logStars(playerId, action, value) {
  const gameId = getCurrentGameId();
  const response = await fetch('/api/player-actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ playerId, gameId, action, value })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to record the stars.');
    return false;
  }

  const updatedPlayers = await fetchPlayers();
  renderPlayers(updatedPlayers);
  return true;
}

async function handleStarsButtonClick(playerId, playerName) {
  const result = await showStarsPopup(playerName);
  if (!result) {
    return;
  }

  const succeeded = await logStars(playerId, result.action, result.value);
  if (succeeded) {
    setTimeout(showStarExplosion, STARS_POPUP_FADE_MS);
  }
}

function handleStarsButtonEvent(event, cardSelector) {
  const starsBtn = event.target.closest('.stars-btn');
  if (!starsBtn || starsBtn.disabled) {
    return;
  }

  const card = starsBtn.closest(cardSelector);
  const playerId = Number(card?.dataset.playerId);
  const playerName = card?.querySelector('.player-name')?.textContent || 'this player';
  if (Number.isFinite(playerId)) {
    handleStarsButtonClick(playerId, playerName);
  }
}

async function toggleGameStatus() {
  const nextState = !isGameActive;
  const gameId = getCurrentGameId();

  if (!nextState) {
    // Pausing: remember who's on the field right now so their cards can stay visible
    // (dimmed) while paused, and so Resume knows who to put back into active play.
    pausedFieldPlayerIds = new Set(latestPlayers.filter((player) => player.inStage).map((player) => player.id));
  }

  const response = await fetch(`/api/game/${gameId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ isActive: nextState, gameId })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to update the game status.');
    if (!nextState) {
      pausedFieldPlayerIds = new Set();
    }
    return;
  }

  const gameData = await response.json();
  renderGameHeader(gameData.game);

  if (nextState) {
    for (const playerId of pausedFieldPlayerIds) {
      await logPlayerActivity(playerId, true);
    }
    pausedFieldPlayerIds = new Set();

    // The clock-ins above may have just opened this quarter's game_quarter row —
    // refresh once more so the countdown and quarter progress bar aren't stale.
    const refreshedGame = await fetchCurrentGame();
    renderGameHeader(refreshedGame.game);
  }

  const players = await fetchPlayers();
  renderPlayers(players);
}

async function endCurrentQuarterAction() {
  const gameId = getCurrentGameId();
  const response = await fetch(`/api/game/${gameId}/end-quarter`, {
    method: 'POST'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to end the quarter.');
    return;
  }

  const gameData = await response.json();
  renderGameHeader(gameData.game);

  const players = await fetchPlayers();
  renderPlayers(players);
}

async function handleEndQuarterClick() {
  const confirmed = await showConfirmPopup(`End the ${getQuarterOrdinal(currentQuarterNumber)} quarter now?`);
  if (!confirmed) {
    return;
  }

  await endCurrentQuarterAction();
}

async function createGame(event) {
  event.preventDefault();

  const formData = new FormData(gameFormEl);
  const payload = {
    location: formData.get('location')?.trim(),
    month: formData.get('month'),
    day: formData.get('day'),
    year: formData.get('year')
  };

  if (!payload.location || !payload.month || !payload.day || !payload.year) {
    alert('Please enter a location and select a month, day, and year for the game.');
    return;
  }

  const response = await fetch('/api/games', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    alert(errorData.message || 'Unable to create the game.');
    return;
  }

  const gameData = await response.json();
  renderGameHeader(gameData.game);
  gameFormEl.reset();
}

function setupDropZones() {
  // Field membership can be edited whenever the game hasn't permanently timed out —
  // including while paused, where changes are held as pending until Game Resume.
  const dragOver = (event) => {
    if (isGameFinished) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  stageEl.addEventListener('dragover', dragOver);
  playerListEl.addEventListener('dragover', (event) => {
    if (isGameFinished) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  stageEl.addEventListener('drop', (event) => {
    event.preventDefault();
    if (isGameFinished) {
      return;
    }
    const playerId = Number(event.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(playerId)) {
      logPlayerActivity(playerId, true);
    }
  });

  playerListEl.addEventListener('drop', (event) => {
    event.preventDefault();
    const playerId = Number(event.dataTransfer.getData('text/plain'));
    if (!Number.isNaN(playerId)) {
      logPlayerActivity(playerId, false);
    }
  });

  stageEl.addEventListener('click', (event) => {
    const goalBtn = event.target.closest('.goal-btn');
    if (goalBtn && !goalBtn.disabled) {
      const card = goalBtn.closest('.stage-player');
      const playerId = Number(card?.dataset.playerId);
      const playerName = card?.querySelector('.player-name')?.textContent || 'this player';
      if (Number.isFinite(playerId)) {
        handleGoalButtonClick(playerId, playerName);
      }
      return;
    }

    handleStarsButtonEvent(event, '.stage-player');
  });

  playerListEl.addEventListener('click', (event) => {
    handleStarsButtonEvent(event, '.player-card');
  });

  scoreboardEl.addEventListener('click', (event) => {
    const pill = event.target.closest('button[data-remove-mode]');
    if (!pill) {
      return;
    }

    const playerId = Number(pill.dataset.playerId);
    const playerName = pill.dataset.playerName || 'this player';
    if (!Number.isFinite(playerId)) {
      return;
    }

    if (pill.dataset.removeMode === 'last') {
      handleRemoveGoalClick(playerId, playerName);
    } else {
      handleRemoveAllStarsClick(playerId, playerName, pill.dataset.action);
    }
  });

  confirmPopupYesBtn.addEventListener('click', () => resolveConfirmPopup(true));
  confirmPopupNoBtn.addEventListener('click', () => resolveConfirmPopup(false));

  starsPopupSubmitBtn.addEventListener('click', () => {
    if (!starsPopupActionEl.value) {
      starsPopupErrorEl.classList.remove('hidden');
      return;
    }

    resolveStarsPopup({ action: starsPopupActionEl.value, value: Number(starsPopupStarsEl.value) });
  });
  starsPopupActionEl.addEventListener('change', () => {
    if (starsPopupActionEl.value) {
      starsPopupErrorEl.classList.add('hidden');
    }
  });
  starsPopupCancelBtn.addEventListener('click', () => resolveStarsPopup(null));

  gameToggleBtn.addEventListener('click', toggleGameStatus);
  endQuarterBtn.addEventListener('click', handleEndQuarterClick);
  if (gameFormEl) {
    gameFormEl.addEventListener('submit', createGame);
  }
}

function setupTouchDragAndDrop() {
  if (!supportsTouch) {
    return;
  }

  const DRAG_THRESHOLD_PX = 8;
  const EDGE_SCROLL_ZONE_PX = 70;
  const EDGE_SCROLL_SPEED_PX = 14;
  let dragState = null;
  let edgeScrollInterval = null;
  let lastTouchY = null;

  function startEdgeScrollLoop() {
    if (edgeScrollInterval) {
      return;
    }

    edgeScrollInterval = setInterval(() => {
      if (lastTouchY === null) {
        return;
      }

      if (lastTouchY < EDGE_SCROLL_ZONE_PX) {
        window.scrollBy(0, -EDGE_SCROLL_SPEED_PX);
      } else if (lastTouchY > window.innerHeight - EDGE_SCROLL_ZONE_PX) {
        window.scrollBy(0, EDGE_SCROLL_SPEED_PX);
      }
    }, 16);
  }

  function stopEdgeScrollLoop() {
    if (edgeScrollInterval) {
      clearInterval(edgeScrollInterval);
      edgeScrollInterval = null;
    }
    lastTouchY = null;
  }

  function clearDragState() {
    if (dragState?.ghostEl) {
      dragState.ghostEl.remove();
    }
    dragState?.sourceEl?.classList.remove('drag-source-active');
    stageEl.classList.remove('drag-target-active');
    playerListEl.classList.remove('drag-target-active');
    stopEdgeScrollLoop();
    dragState = null;
  }

  function createGhost(sourceEl, x, y) {
    const ghost = sourceEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${sourceEl.offsetWidth}px`;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    document.body.appendChild(ghost);
    return ghost;
  }

  document.addEventListener('touchstart', (event) => {
    const handle = event.target.closest('.drag-handle');
    if (!handle) {
      return;
    }

    const card = handle.closest('.player-card, .stage-player');
    if (!card || !card.dataset.playerId) {
      return;
    }

    const touch = event.touches[0];
    dragState = {
      playerId: Number(card.dataset.playerId),
      sourceEl: card,
      startX: touch.clientX,
      startY: touch.clientY,
      ghostEl: null,
      dragging: false
    };
  }, { passive: true });

  document.addEventListener('touchmove', (event) => {
    if (!dragState) {
      return;
    }

    const touch = event.touches[0];

    if (!dragState.dragging) {
      const dx = touch.clientX - dragState.startX;
      const dy = touch.clientY - dragState.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      dragState.dragging = true;
      dragState.sourceEl.classList.add('drag-source-active');
      dragState.ghostEl = createGhost(dragState.sourceEl, touch.clientX, touch.clientY);
      startEdgeScrollLoop();
    }

    event.preventDefault();
    lastTouchY = touch.clientY;
    dragState.ghostEl.style.left = `${touch.clientX}px`;
    dragState.ghostEl.style.top = `${touch.clientY}px`;

    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    stageEl.classList.toggle('drag-target-active', Boolean(target && target.closest('#stage') && !isGameFinished));
    playerListEl.classList.toggle('drag-target-active', Boolean(target && target.closest('#player-list')));
  }, { passive: false });

  document.addEventListener('touchend', (event) => {
    if (!dragState) {
      return;
    }

    if (dragState.dragging) {
      const touch = event.changedTouches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const { playerId } = dragState;

      clearDragState();

      if (target && target.closest('#stage')) {
        logPlayerActivity(playerId, true);
      } else if (target && target.closest('#player-list')) {
        logPlayerActivity(playerId, false);
      }
      return;
    }

    clearDragState();
  });

  document.addEventListener('touchcancel', clearDragState);
}

async function initializeApp() {
  setupDropZones();
  setupTouchDragAndDrop();
  setInterval(tickPlayerTimes, 1000);

  try {
    const gameData = await fetchCurrentGame();
    renderGameHeader(gameData.game);

    const players = await fetchPlayers();
    renderPlayers(players);
  } catch (error) {
    gameIdDisplayEl.textContent = 'Game ID: --';
    playerListEl.innerHTML = '<p>Unable to load player data.</p>';
    console.error(error);
  }

  setInterval(async () => {
    try {
      const [gameData, players] = await Promise.all([
        fetchCurrentGame(),
        fetchPlayers()
      ]);

      renderGameHeader(gameData.game);
      renderPlayers(players);
    } catch (error) {
      console.error('Error refreshing player data:', error);
    }
  }, 10000);
}

initializeApp();
