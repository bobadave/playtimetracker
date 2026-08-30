function getStoredTeamId() {
  try {
    const stored = window.sessionStorage.getItem('currentTeamId');
    return stored ? Number(stored) : 1;
  } catch (error) {
    return 1;
  }
}

function setStoredTeamId(teamId) {
  try {
    window.sessionStorage.setItem('currentTeamId', String(teamId));
  } catch (error) {
    // Ignore storage failures in private browsing or restricted environments.
  }
}

function getCurrentTeamIdFromPath() {
  const match = window.location.pathname.match(/^\/t(\d+)(?:\/|$)/);
  if (match) {
    const teamId = Number(match[1]);
    setStoredTeamId(teamId);
    return teamId;
  }

  return getStoredTeamId();
}

function updateCurrentGameLink() {
  const link = document.getElementById('current-game-link');
  if (!link) {
    return;
  }

  const teamId = getCurrentTeamIdFromPath();
  fetch('/api/games')
    .then((response) => {
      if (!response.ok) {
        throw new Error('Unable to find current game.');
      }
      return response.json();
    })
    .then(({ games = [] }) => {
      const activeGames = games.filter((game) => Number(game.is_active) === 1);
      const activeLatest = activeGames.sort((a, b) => Number(b.id) - Number(a.id))[0];
      const fallbackLatest = [...games].sort((a, b) => Number(b.id) - Number(a.id))[0];
      const target = activeLatest || fallbackLatest;
      const targetTeamId = target && target.team_id ? Number(target.team_id) : teamId;
      link.href = target ? `/t${targetTeamId}/games/${target.id}` : `/t${teamId}/games`;
    })
    .catch(() => {
      link.href = `/t${teamId}/games`;
    });
}

function updateTeamScopedMenuLinks() {
  const teamId = getCurrentTeamIdFromPath();
  setStoredTeamId(teamId);

  const rosterLink = document.getElementById('roster-link');
  const gamesLink = document.getElementById('games-link');

  if (rosterLink) {
    rosterLink.href = `/t${teamId}/roster`;
  }

  if (gamesLink) {
    gamesLink.href = `/t${teamId}/games`;
  }
}

function initMenu() {
  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('menu-panel');

  if (!toggle || !menu) {
    return;
  }

  if (toggle.dataset.menuBound === 'true') {
    return;
  }

  toggle.dataset.menuBound = 'true';

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  menu.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  document.addEventListener('click', (event) => {
    const clickInside = toggle.contains(event.target) || menu.contains(event.target);
    if (!clickInside) {
      menu.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

initMenu();
updateTeamScopedMenuLinks();
document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  updateTeamScopedMenuLinks();
});
