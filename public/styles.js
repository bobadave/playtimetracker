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

async function getCurrentUserTeamIds() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) {
      return [];
    }

    const { user } = await response.json();
    return Array.isArray(user?.teamIds) ? user.teamIds.map((teamId) => Number(teamId)).filter((teamId) => Number.isFinite(teamId) && teamId > 0) : [];
  } catch (error) {
    return [];
  }
}

async function resolvePreferredTeamId() {
  const pathTeamId = getCurrentTeamIdFromPath();
  if (window.location.pathname.match(/^\/t\d+(?:\/|$)/)) {
    return pathTeamId;
  }

  const teamIds = await getCurrentUserTeamIds();
  if (teamIds.length === 0) {
    try {
      window.sessionStorage.removeItem('currentTeamId');
    } catch (error) {
      // Ignore storage failures in private browsing or restricted environments.
    }
    return null;
  }

  const preferredTeamId = teamIds[0] || 1;
  setStoredTeamId(preferredTeamId);
  return preferredTeamId;
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

function bindDisabledMenuLink(link) {
  if (!link || link.dataset.menuDisabledBound === 'true') {
    return;
  }

  link.dataset.menuDisabledBound = 'true';
  link.addEventListener('click', (event) => {
    if (link.dataset.disabled === 'true') {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function setMenuLinkDisabled(link, disabled, fallbackHref = '#') {
  if (!link) {
    return;
  }

  const originalHref = link.dataset.originalHref || link.getAttribute('href') || fallbackHref;
  if (!link.dataset.originalHref) {
    link.dataset.originalHref = originalHref;
  }

  bindDisabledMenuLink(link);

  link.classList.toggle('disabled-link', disabled);
  link.setAttribute('aria-disabled', String(disabled));
  link.dataset.disabled = disabled ? 'true' : 'false';

  if (disabled) {
    link.href = fallbackHref;
    link.style.pointerEvents = 'none';
    link.tabIndex = -1;
    return;
  }

  link.href = link.dataset.originalHref || fallbackHref;
  link.style.pointerEvents = '';
  link.removeAttribute('tabindex');
}

async function updateTeamScopedMenuLinks() {
  const rosterLink = document.getElementById('roster-link');
  const gamesLink = document.getElementById('games-link');
  const teamIds = await getCurrentUserTeamIds();

  if (teamIds.length === 0) {
    try {
      window.sessionStorage.removeItem('currentTeamId');
    } catch (error) {
      // Ignore storage failures in private browsing or restricted environments.
    }
    setMenuLinkDisabled(rosterLink, true);
    setMenuLinkDisabled(gamesLink, true);
    return;
  }

  const teamId = await resolvePreferredTeamId();
  setStoredTeamId(teamId);

  if (rosterLink) {
    rosterLink.href = `/t${teamId}/roster`;
    setMenuLinkDisabled(rosterLink, false, `/t${teamId}/roster`);
  }

  if (gamesLink) {
    gamesLink.href = `/t${teamId}/games`;
    setMenuLinkDisabled(gamesLink, false, `/t${teamId}/games`);
  }
}

function ensureMenuDivider(menu, beforeEl) {
  let divider = document.getElementById('menu-divider');
  if (!divider) {
    divider = document.createElement('div');
    divider.id = 'menu-divider';
    divider.className = 'menu-divider';
  }

  if (beforeEl) {
    menu.insertBefore(divider, beforeEl);
  } else if (!divider.parentElement) {
    menu.appendChild(divider);
  }

  return divider;
}

async function attachProfileLink() {
  const menu = document.getElementById('menu-panel');
  if (!menu) {
    return;
  }

  let profileLink = document.getElementById('profile-link');
  if (!profileLink) {
    profileLink = document.createElement('a');
    profileLink.id = 'profile-link';
    profileLink.href = '/profile';
    profileLink.textContent = 'Profile';
  }

  const logoutLink = document.getElementById('logout-link');
  ensureMenuDivider(menu, logoutLink || null);

  if (logoutLink) {
    menu.insertBefore(profileLink, logoutLink);
  } else if (!profileLink.parentElement) {
    menu.appendChild(profileLink);
  }

  try {
    const response = await fetch('/api/session');
    if (response.ok) {
      const { user } = await response.json();
      const displayName = user ? (user.firstName || user.email || '') : '';
      profileLink.textContent = displayName ? `Profile (${displayName})` : 'Profile';
    }
  } catch (error) {
    // Keep the fallback "Profile" label if the session lookup fails.
  }
}

function attachBugReportWidget() {
  if (document.getElementById('bug-report-btn')) {
    return;
  }

  const button = document.createElement('button');
  button.id = 'bug-report-btn';
  button.type = 'button';
  button.className = 'bug-report-btn';
  button.setAttribute('aria-label', 'Report a bug or feature request');
  button.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="22" height="22" aria-hidden="true">
      <rect x="8" y="8" width="8" height="10" rx="4"></rect>
      <line x1="12" y1="2" x2="12" y2="5"></line>
      <line x1="9" y1="3" x2="10.5" y2="5.5"></line>
      <line x1="15" y1="3" x2="13.5" y2="5.5"></line>
      <line x1="5" y1="10" x2="8" y2="11"></line>
      <line x1="19" y1="10" x2="16" y2="11"></line>
      <line x1="5" y1="15" x2="8" y2="14.5"></line>
      <line x1="19" y1="15" x2="16" y2="14.5"></line>
      <line x1="6" y1="19" x2="9" y2="17"></line>
      <line x1="18" y1="19" x2="15" y2="17"></line>
      <line x1="12" y1="8" x2="12" y2="18"></line>
    </svg>
  `;

  const modal = document.createElement('div');
  modal.id = 'bug-report-modal';
  modal.className = 'modal hidden';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="modal-backdrop" data-close-modal="true"></div>
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="bug-report-modal-title">
      <div class="modal-header">
        <h2 id="bug-report-modal-title">Bug or Feature Request</h2>
        <button id="bug-report-close" class="icon-btn" type="button" aria-label="Close">×</button>
      </div>
      <p>Would you like to report a bug or feature request?</p>
      <div class="modal-actions">
        <button type="button" id="bug-report-cancel" class="secondary-btn">Cancel</button>
        <button type="button" id="bug-report-confirm" class="primary-btn">Report</button>
      </div>
    </div>
  `;

  document.body.appendChild(button);
  document.body.appendChild(modal);

  const openModal = () => {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  };

  const closeModal = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  };

  button.addEventListener('click', openModal);
  document.getElementById('bug-report-close').addEventListener('click', closeModal);
  document.getElementById('bug-report-cancel').addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target.dataset.closeModal === 'true') {
      closeModal();
    }
  });
  document.getElementById('bug-report-confirm').addEventListener('click', () => {
    window.open('https://github.com/bobadave/playtimetracker/issues/new', '_blank', 'noopener');
    closeModal();
  });
}

function attachLogoutHandler() {
  const menu = document.getElementById('menu-panel');
  if (!menu) {
    return;
  }

  let logoutLink = document.getElementById('logout-link');
  if (!logoutLink) {
    logoutLink = document.createElement('a');
    logoutLink.id = 'logout-link';
    logoutLink.href = '#';
    logoutLink.textContent = 'Log Out';
    menu.appendChild(logoutLink);
  }

  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (error) {
      // Ignore logout API errors and continue to the login screen.
    }

    window.sessionStorage.removeItem('currentTeamId');
    window.location.href = '/login';
  });
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
attachLogoutHandler();
attachProfileLink().catch(() => undefined);
updateTeamScopedMenuLinks().catch(() => undefined);
attachBugReportWidget();
document.addEventListener('DOMContentLoaded', () => {
  initMenu();
  attachLogoutHandler();
  attachProfileLink().catch(() => undefined);
  updateTeamScopedMenuLinks().catch(() => undefined);
  attachBugReportWidget();
});
