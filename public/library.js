import { encodeFiles } from './client.js';

const $ = id => document.getElementById(id);
const LIBRARY_VIEWS = ['all', 'mine', 'shared', 'starred'];
const ADMIN_VIEWS = ['admin', 'people', 'activity'];
const VIEWS = {
  all: ['Your artifacts', 'A place for your work, and the work shared with you.'],
  mine: ['Created by me', 'The pages, tools, and ideas you have published.'],
  shared: ['Shared with me', 'Work that other people have shared directly with you.'],
  starred: ['Starred artifacts', 'A personal shelf for the work you want to come back to.'],
  admin: ['Every artifact', 'The complete inventory, across every account.'],
  people: ['People & invitations', 'Invite people to create their own library.'],
  activity: ['Activity', 'Recent administrative changes in this instance.'],
  credentials: ['API credentials', 'Publish from the CLI using a credential tied to your account.'],
};
let user = null;
let people = [];
let loadSequence = 0;
let dialogSequence = 0;
let dialogFocus = null;
let nextCursor = null;
let previousCursors = [];
let page = 1;
let toastTimer;
let searchTimer;
let loginToken = '';
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('artifact-library-preferences') || '{}') || {}; } catch { /* Optional per-browser preferences. */ }
let layout = preferences.layout === 'list' ? 'list' : 'grid';
const params = new URLSearchParams(location.search);
let state = {
  view: Object.hasOwn(VIEWS, params.get('view')) ? params.get('view') : 'all',
  q: params.get('q') || '', ownerId: params.get('ownerId') || '',
  status: ['all', 'active', 'archived'].includes(params.get('status')) ? params.get('status') : 'all',
  cursor: params.get('cursor') || '',
};

// A mail scanner must never consume a link. Keep its token only in this page's
// memory and remove the fragment before making any network request.
function captureLoginLink() {
  if (location.pathname !== '/login' || !location.hash) return false;
  loginToken = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
captureLoginLink();
// Opening a fresh mail link in a tab already at /login changes only the hash;
// it does not reload this module. Still remove it immediately and require consent.
window.addEventListener('hashchange', () => {
  if (captureLoginLink()) { message('login-feedback'); showLogin(); }
});

function node(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children.filter(c => c != null));
  return n;
}
function button(text, action, className = '') {
  const b = node('button', { type: 'button', textContent: text, className });
  b.addEventListener('click', action);
  return b;
}
function message(id, text = '') {
  $(id).textContent = text;
  $(id).hidden = !text;
}
function notify(text) {
  message('toast', text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function dateText(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function relativeDate(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return 'Unknown date';
  if (ms < 60000) return 'Just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return dateText(value);
}
function applyTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}
function savePreferences() {
  try { localStorage.setItem('artifact-library-preferences', JSON.stringify(preferences)); } catch { /* Storage can be disabled. */ }
}
applyTheme(preferences.theme);
$('theme').value = ['light', 'dark'].includes(preferences.theme) ? preferences.theme : 'system';
$('theme').addEventListener('change', () => {
  preferences.theme = $('theme').value;
  applyTheme(preferences.theme);
  savePreferences();
});

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && user) {
      user = null;
      $('dialog').close();
      showLogin();
      message('login-feedback', 'Your session has ended. Sign in again to continue.');
    }
    throw new Error(data?.error || `Request failed (HTTP ${response.status}). Try again.`);
  }
  return data;
}
function showLogin() {
  $('boot').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-form').hidden = !!loginToken;
  $('verify-panel').hidden = !loginToken;
  $('login-title').textContent = loginToken ? 'Your library is one click away' : 'Welcome back';
  $('login-description').textContent = loginToken ? 'Confirm your sign-in to continue.' : 'Sign in to your artifact library.';
}
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  message('login-feedback');
  try {
    await api('/api/auth/request', { method: 'POST', body: { email: $('login-email').value.trim() } });
    message('login-feedback', 'If this email belongs to an invited account, a sign-in link is on its way. Check your inbox. The link expires in 15 minutes.');
  } catch (err) { message('login-feedback', err.message); }
  finally { b.disabled = false; }
});
$('verify-button').addEventListener('click', async () => {
  $('verify-button').disabled = true;
  message('login-feedback');
  try {
    const data = await api('/api/auth/verify', { method: 'POST', body: { token: loginToken } });
    loginToken = '';
    user = data.user;
    history.replaceState(null, '', '/');
    await showApp();
  } catch (err) { message('login-feedback', `${err.message} You can request a fresh sign-in link using your email.`); }
  finally { $('verify-button').disabled = false; }
});
$('different-email').addEventListener('click', () => {
  loginToken = '';
  message('login-feedback');
  showLogin();
  $('login-email').focus();
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    user = null;
    people = [];
    ++loadSequence;
    $('content').replaceChildren();
    $('dialog').close();
    history.replaceState(null, '', '/login');
    showLogin();
  } catch (err) { notify(err.message); }
  finally { $('logout').disabled = false; }
});

function writeUrl(replace = false) {
  const p = new URLSearchParams();
  if (state.view !== 'all') p.set('view', state.view);
  if (state.q) p.set('q', state.q);
  if (state.view === 'admin') {
    if (state.ownerId) p.set('ownerId', state.ownerId);
    if (state.status !== 'all') p.set('status', state.status);
  }
  if (state.cursor) p.set('cursor', state.cursor);
  history[replace ? 'replaceState' : 'pushState']({ previousCursors, page }, '', '/' + (p.size ? '?' + p : ''));
}
function closeNavigation() {
  document.querySelector('.sidebar').classList.remove('expanded');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
}
$('nav-toggle').addEventListener('click', () => {
  const expanded = document.querySelector('.sidebar').classList.toggle('expanded');
  $('nav-toggle').setAttribute('aria-expanded', String(expanded));
});
function resetPagination() { state.cursor = ''; previousCursors = []; page = 1; }
function navigate(view) {
  clearTimeout(searchTimer);
  state = { view, q: '', ownerId: '', status: 'all', cursor: '' };
  resetPagination();
  writeUrl();
  closeNavigation();
  loadPage();
  $('main').focus();
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
window.addEventListener('popstate', e => {
  const p = new URLSearchParams(location.search);
  state = {
    view: Object.hasOwn(VIEWS, p.get('view')) ? p.get('view') : 'all',
    q: p.get('q') || '', ownerId: p.get('ownerId') || '',
    status: ['all', 'active', 'archived'].includes(p.get('status')) ? p.get('status') : 'all', cursor: p.get('cursor') || '',
  };
  previousCursors = e.state?.previousCursors || [];
  page = e.state?.page || 1;
  if (user) loadPage();
});
function search() {
  state.q = $('search').value;
  resetPagination();
  writeUrl(true);
  loadPage();
}
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 250); });
$('filters').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); search(); });
for (const id of ['owner-filter', 'status-filter']) $(id).addEventListener('change', () => {
  state.ownerId = $('owner-filter').value;
  state.status = $('status-filter').value;
  resetPagination(); writeUrl(); loadPage();
});
document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
  layout = b.dataset.layout;
  preferences.layout = layout;
  savePreferences();
  loadPage();
}));
$('next').addEventListener('click', () => {
  if (!nextCursor) return;
  previousCursors.push(state.cursor); state.cursor = nextCursor; ++page; writeUrl(); loadPage();
  $('main').focus();
});
$('previous').addEventListener('click', () => {
  state.cursor = previousCursors.pop() || ''; page = Math.max(1, page - 1); writeUrl(); loadPage();
  $('main').focus();
});

async function showApp() {
  if (!user) return showLogin();
  $('boot').hidden = true;
  $('login').hidden = true;
  $('app').hidden = false;
  $('account-name').textContent = user.name || user.email;
  $('account-email').textContent = user.email;
  $('account-role').textContent = user.role === 'owner' ? 'Instance owner' : 'Member';
  document.querySelectorAll('[data-owner-only]').forEach(n => { n.hidden = user.role !== 'owner'; });
  await loadPage();
}
function empty(title, text) {
  return node('div', { className: 'empty' }, node('h2', { textContent: title }), node('p', { textContent: text }));
}
async function loadPeople() {
  const data = await api('/api/people');
  people = data.users;
  return people;
}
function setOptions(select, entries, first) {
  const selected = select.value;
  select.replaceChildren(...(first ? [node('option', { value: '', textContent: first })] : []),
    ...entries.map(p => node('option', { value: p.id, textContent: p.name ? `${p.name} (${p.email})` : p.email })));
  select.value = [...select.options].some(o => o.value === selected) ? selected : (select.options[0]?.value || '');
}
async function loadPage() {
  if (!user) return;
  if (ADMIN_VIEWS.includes(state.view) && user.role !== 'owner') { state.view = 'all'; resetPagination(); writeUrl(true); }
  const seq = ++loadSequence;
  const view = state.view;
  const library = LIBRARY_VIEWS.includes(view);
  const inventory = view === 'admin';
  $('page-title').textContent = VIEWS[view][0];
  $('page-description').textContent = VIEWS[view][1];
  document.title = `${VIEWS[view][0]} · Artifacts`;
  document.querySelectorAll('[data-view]').forEach(b => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('filters').hidden = !library && !inventory;
  $('layout-switch').hidden = !library;
  $('owner-filter').hidden = !inventory;
  $('status-filter').hidden = !inventory;
  $('admin-notice').hidden = !inventory;
  $('search').value = state.q;
  $('status-filter').value = state.status;
  document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
  const action = library ? ['Publish artifact', openUpload] : view === 'people' ? ['Invite someone', openInvite] : view === 'credentials' ? ['Create credential', openCreateCredential] : null;
  $('page-action').hidden = !action;
  $('page-action').onclick = action ? action[1] : null;
  $('page-action').textContent = action?.[0] || '';
  $('pagination').hidden = true;
  $('result-status').textContent = 'Loading…';
  message('page-error');
  $('content').setAttribute('aria-busy', 'true');
  $('content').replaceChildren(node('div', { className: 'loading', textContent: 'Loading your work…' }));
  try {
    if (library || inventory) {
      if (inventory) {
        const users = await loadPeople();
        if (seq !== loadSequence) return;
        setOptions($('owner-filter'), users, 'Every owner');
        $('owner-filter').value = state.ownerId;
      }
      const p = new URLSearchParams({ q: state.q, limit: '25' });
      if (state.cursor) p.set('cursor', state.cursor);
      if (inventory) {
        p.set('status', state.status);
        if (state.ownerId) p.set('ownerId', state.ownerId);
      } else p.set('view', view);
      const data = await api(`${inventory ? '/api/admin/artifacts' : '/api/library'}?${p}`);
      if (seq !== loadSequence) return;
      renderArtifacts(data.artifacts, inventory);
      nextCursor = data.nextCursor;
      $('previous').disabled = !state.cursor;
      $('next').disabled = !nextCursor;
      $('pagination').hidden = !state.cursor && !nextCursor;
      $('page-number').textContent = `Page ${page}${state.cursor && !previousCursors.length ? ' (linked page)' : ''}`;
      $('result-status').textContent = `${data.artifacts.length} artifact${data.artifacts.length === 1 ? '' : 's'} on this page · Recently updated first`;
    } else if (view === 'people') {
      const users = await loadPeople();
      if (seq !== loadSequence) return;
      renderPeople(users);
      $('result-status').textContent = `${users.length} account${users.length === 1 ? '' : 's'}`;
    } else if (view === 'activity') {
      const data = await api('/api/admin/activity?limit=25');
      if (seq !== loadSequence) return;
      renderActivity(data.events);
      $('result-status').textContent = 'Most recent 25 events';
    } else {
      const data = await api('/api/credentials');
      if (seq !== loadSequence) return;
      renderCredentials(data.credentials);
      $('result-status').textContent = `${data.credentials.length} credential${data.credentials.length === 1 ? '' : 's'}`;
    }
  } catch (err) {
    if (seq !== loadSequence) return;
    $('content').replaceChildren(button('Try again', loadPage));
    $('result-status').textContent = 'Could not load this page.';
    message('page-error', err.message);
  } finally { if (seq === loadSequence) $('content').setAttribute('aria-busy', 'false'); }
}
// Session URLs never carry tokens. Ignore untrusted URL schemes/origins from metadata.
function viewerUrl(item) { return `/v/${encodeURIComponent(item.id)}`; }
function meta(item) {
  return `${item.ownerName || 'Instance owner'} · ${item.visibility || 'private'}${item.archived ? ' · archived' : ''} · ${relativeDate(item.updatedAt)}`;
}
function renderArtifacts(items, inventory) {
  if (!items.length) {
    $('content').replaceChildren(empty(state.q || state.ownerId || state.status !== 'all' ? 'No matching artifacts' : state.view === 'starred' ? 'Keep your favorites close' : 'Your shelf is ready',
      state.q || state.ownerId || state.status !== 'all' ? 'Try a different search or clear your filters.' : state.view === 'starred' ? 'Open an artifact’s menu and choose Star artifact.' : 'Publish a self-contained HTML file, or find work shared with you here.'));
    return;
  }
  const grid = !inventory && layout === 'grid';
  const list = node('div', { className: grid ? 'artifact-grid' : 'artifact-list', role: 'list' });
  for (const item of items) {
    const title = node('a', { className: 'artifact-title', href: viewerUrl(item), title: item.title, textContent: item.title || 'Untitled artifact' });
    if (item.starred) title.prepend(node('span', { className: 'star-mark', textContent: '★', ariaLabel: 'Starred' }));
    const summary = node('div', {}, title, node('div', { className: 'artifact-meta', title: meta(item) }, node('span', { textContent: meta(item) })));
    const menu = button('⋯', () => openManage(item), 'icon-button artifact-menu');
    menu.setAttribute('aria-label', `${item.canManage ? 'Manage' : 'Details for'} ${item.title || 'artifact'}`);
    const entry = node('article', { className: grid ? 'artifact-card' : 'artifact-row', role: 'listitem' });
    if (grid) {
      const glyph = node('div', { className: 'document-glyph', ariaHidden: 'true' }, node('span'), node('span'), node('span'), node('span'));
      const preview = node('a', { className: 'artifact-preview', href: viewerUrl(item), tabIndex: -1, ariaHidden: 'true' }, glyph);
      entry.append(preview, node('div', { className: 'artifact-summary' }, summary, menu));
    } else {
      entry.append(summary, node('span', { className: 'cell', textContent: item.ownerName || 'Instance owner' }),
        node('span', { className: 'cell', textContent: `${item.visibility || 'private'}${item.archived ? ' / archived' : ''}` }),
        node('span', { className: 'cell time-cell', textContent: relativeDate(item.updatedAt) }), menu);
    }
    list.append(entry);
  }
  $('content').replaceChildren(list);
}
function renderPeople(users) {
  const list = node('div', { className: 'record-list' });
  for (const p of users) {
    const row = node('div', { className: 'record' }, node('div', { className: 'identity' },
      node('strong', { textContent: p.name || p.email }), node('small', { textContent: p.email })),
    node('span', { className: 'badge', textContent: p.role === 'owner' ? 'Instance owner' : p.status === 'invited' ? 'Invitation pending' : p.status === 'disabled' ? 'Suspended' : 'Active member' }));
    if (p.role !== 'owner') {
      const actions = node('div', { className: 'record-actions' });
      if (p.status === 'invited') actions.append(button('Resend invitation', () => confirmAction('Resend invitation?', `Send a fresh invitation to ${p.email}?`, 'Send invitation', async () => {
        await api('/api/invitations', { method: 'POST', body: { email: p.email, name: p.name } });
        notify('Invitation sent.');
      })));
      actions.append(button(p.status === 'disabled' ? 'Reactivate' : 'Suspend', () => openSuspend(p)));
      row.append(actions);
    }
    list.append(row);
  }
  $('content').replaceChildren(node('div', { className: 'notice', textContent: 'Membership allows sign-in, not access to everyone’s artifacts. Suspension ends all sessions and revokes personal API credentials.' }), list);
}
function renderActivity(events) {
  if (!events.length) return $('content').replaceChildren(empty('No activity yet', 'Administrative changes will appear here.'));
  const list = node('div', { className: 'record-list' });
  for (const event of events) {
    const detail = node('div', { className: 'identity' }, node('strong', { textContent: event.action.replaceAll('_', ' ') }),
      node('small', { textContent: `${event.actorName || 'Account'}${event.artifactTitle ? ` · ${event.artifactTitle}` : ''}` }));
    list.append(node('div', { className: 'record activity-record' }, detail, node('time', { dateTime: event.createdAt, textContent: dateText(event.createdAt) })));
  }
  $('content').replaceChildren(list);
}
function renderCredentials(credentials) {
  if (!credentials.length) return $('content').replaceChildren(empty('Publish as yourself', 'Create a named API credential for your CLI. The secret is displayed only once.'));
  const list = node('div', { className: 'record-list' });
  for (const c of credentials) list.append(node('div', { className: 'record' },
    node('div', { className: 'identity' }, node('strong', { textContent: c.name }), node('small', { textContent: `Created ${dateText(c.createdAt)}` })),
    button('Revoke', () => confirmAction('Revoke credential?', `Any CLI using “${c.name}” will lose access immediately. This cannot be undone.`, 'Revoke credential', async () => {
      await api(`/api/credentials/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      notify('Credential revoked.');
    }, true))));
  $('content').replaceChildren(list);
}

function openDialog(title, ...children) {
  const alreadyOpen = $('dialog').open;
  if (!alreadyOpen) dialogFocus = document.activeElement;
  ++dialogSequence;
  $('dialog-title').textContent = title;
  $('dialog-body').replaceChildren(...children);
  message('dialog-error');
  if (!alreadyOpen) $('dialog').showModal();
  else $('dialog-close').focus();
  return dialogSequence;
}
$('dialog-close').addEventListener('click', () => $('dialog').close());
$('dialog').addEventListener('close', () => {
  ++dialogSequence;
  $('dialog-body').replaceChildren(); // Includes any one-time credential.
  message('dialog-error');
  if (dialogFocus?.isConnected) dialogFocus.focus();
  else $('main').focus();
});
async function dialogTask(action, { close = true, reload = true } = {}) {
  const seq = dialogSequence;
  const controls = [...$('dialog-body').querySelectorAll('button,input,select')];
  const states = controls.map(c => c.disabled);
  controls.forEach(c => { c.disabled = true; });
  $('dialog-close').disabled = true;
  message('dialog-error');
  try {
    await action();
    if (seq === dialogSequence && close) $('dialog').close();
    if (reload && user) await loadPage();
  } catch (err) { if (seq === dialogSequence && $('dialog').open) message('dialog-error', err.message); }
  finally {
    $('dialog-close').disabled = false;
    controls.forEach((c, i) => { c.disabled = states[i]; });
  }
}
function formField(form, label, control) {
  form.append(node('label', { htmlFor: control.id, textContent: label }), control);
  return control;
}
function submit(form, text, action, danger = false) {
  const b = node('button', { type: 'submit', className: `${danger ? 'danger' : 'primary'} full`, textContent: text });
  form.append(b);
  form.addEventListener('submit', e => { e.preventDefault(); dialogTask(action); });
  return b;
}
function confirmAction(title, text, actionName, action, danger = false) {
  const form = node('form');
  form.append(node('p', { textContent: text }));
  const cancel = button('Cancel', () => $('dialog').close());
  const actions = node('div', { className: 'actions' }, cancel);
  const confirm = node('button', { type: 'submit', className: danger ? 'danger' : 'primary', textContent: actionName });
  actions.append(confirm); form.append(actions);
  form.addEventListener('submit', e => { e.preventDefault(); dialogTask(action); });
  openDialog(title, form);
  cancel.focus();
}
function openManage(item) {
  const details = node('dl', { className: 'details-grid' });
  for (const [label, value] of [
    ['Owner', item.ownerName || 'Instance owner'], ['Visibility', item.visibility || 'private'],
    ['Access', item.permission === 'write' ? 'Can edit' : 'Can view'], ['Status', item.archived ? 'Archived' : 'Active'],
    ['Updated', dateText(item.updatedAt)], ['Created', dateText(item.createdAt)],
    ['Expires', item.expiresAt ? dateText(item.expiresAt) : 'Does not expire'],
  ]) details.append(node('dt', { textContent: label }), node('dd', { textContent: value }));
  const actions = node('div', { className: 'manage-actions' },
    node('a', { className: 'button-link', href: viewerUrl(item), textContent: 'Open artifact and history' }),
    button(item.starred ? 'Unstar artifact' : 'Star artifact', () => dialogTask(async () => {
      await api(`/api/artifacts/${encodeURIComponent(item.id)}/star`, { method: 'PUT', body: { starred: !item.starred } });
      notify(item.starred ? 'Artifact unstarred.' : 'Artifact starred.');
    })));
  if (item.canManage) {
    actions.append(button('Manage access', () => openSharing(item)), button('Rename', () => openRename(item)),
      button(item.archived ? 'Restore to library' : 'Archive artifact', () => confirmAction(item.archived ? 'Restore artifact?' : 'Archive artifact?',
        item.archived ? 'This artifact will return to the library. Its existing sharing stays the same.' : 'This hides the artifact from the default library. Existing links and named access will still work. The instance owner can restore it from Every artifact.',
        item.archived ? 'Restore artifact' : 'Archive artifact', async () => {
          await api(`/api/artifacts/${encodeURIComponent(item.id)}/manage`, { method: 'PATCH', body: { archived: !item.archived } });
          notify(item.archived ? 'Artifact restored.' : 'Artifact archived.');
        })));
    if (user.role === 'owner') actions.append(button('Transfer ownership', () => openTransfer(item)));
    actions.append(button('Delete artifact…', () => openDelete(item), 'danger'));
  }
  openDialog(item.title || 'Untitled artifact', details, actions, node('p', { className: 'explain', textContent: 'Private means hidden from other members, not from the instance owner. Capability links grant separate access; changing named sharing does not revoke those links.' }));
}
function openRename(item) {
  const form = node('form');
  const title = formField(form, 'Artifact title', node('input', { id: 'rename-title', value: item.title || '', required: true, maxLength: 200 }));
  submit(form, 'Save title', async () => {
    const value = title.value.trim();
    if (!value) throw new Error('Enter an artifact title.');
    await api(`/api/artifacts/${encodeURIComponent(item.id)}/manage`, { method: 'PATCH', body: { title: value } });
    notify('Title updated.');
  });
  openDialog('Rename artifact', form);
  title.focus(); title.select();
}
async function openSharing(item) {
  const seq = openDialog('Manage access', node('p', { className: 'muted', textContent: 'Loading people and permissions…' }));
  try {
    const data = await api(`/api/artifacts/${encodeURIComponent(item.id)}/sharing`);
    if (seq !== dialogSequence || !$('dialog').open) return;
    const body = $('dialog-body');
    const eligible = (data.users || []).filter(p => p.id !== data.ownerId);
    body.replaceChildren(node('p', { textContent: item.title || 'Untitled artifact' }),
      node('p', { className: 'notice', textContent: 'The creator and instance owner can manage this artifact. Named people below have separate view or edit access. Existing capability links keep working; removing someone here does not revoke a link they already have.' }));
    const grants = node('div');
    for (const grant of data.grants) {
      const permission = node('select', { ariaLabel: `Access for ${grant.email}` },
        node('option', { value: 'read', textContent: 'Can view' }), node('option', { value: 'write', textContent: 'Can edit' }));
      permission.value = grant.permission;
      permission.addEventListener('change', () => dialogTask(async () => {
        await api(`/api/artifacts/${encodeURIComponent(item.id)}/sharing`, { method: 'PUT', body: { userId: grant.userId, permission: permission.value } });
        notify('Access updated.');
        await openSharing(item);
      }, { close: false, reload: false }));
      const remove = button('×', () => confirmAction('Remove named access?', `${grant.email} will lose named access to “${item.title}”. Existing capability links will still work.`, 'Remove access', async () => {
        await api(`/api/artifacts/${encodeURIComponent(item.id)}/sharing`, { method: 'PUT', body: { userId: grant.userId, permission: null } });
        notify('Named access removed.');
      }), 'icon-button');
      remove.setAttribute('aria-label', `Remove access for ${grant.email}`);
      grants.append(node('div', { className: 'grant' }, node('div', { className: 'identity' }, node('strong', { textContent: grant.name || grant.email }), node('small', { textContent: grant.email })), permission, remove));
    }
    body.append(grants);
    const available = eligible.filter(p => !data.grants.some(g => g.userId === p.id));
    if (available.length) {
      const form = node('form');
      const person = formField(form, 'Add a person', node('select', { id: 'share-person', required: true }));
      setOptions(person, available);
      const permission = formField(form, 'Permission', node('select', { id: 'share-permission' },
        node('option', { value: 'read', textContent: 'Can view' }), node('option', { value: 'write', textContent: 'Can edit' })));
      submit(form, 'Grant access', async () => {
        await api(`/api/artifacts/${encodeURIComponent(item.id)}/sharing`, { method: 'PUT', body: { userId: person.value, permission: permission.value } });
        notify('Access granted.');
      });
      body.append(form);
    } else body.append(node('p', { className: 'explain', textContent: 'No other active members are available to add. The instance owner can invite more people.' }));
  } catch (err) { if (seq === dialogSequence) message('dialog-error', err.message); }
}
async function openTransfer(item) {
  const seq = openDialog('Transfer ownership', node('p', { textContent: 'Loading accounts…' }));
  try {
    const users = await loadPeople();
    if (seq !== dialogSequence || !$('dialog').open) return;
    const eligible = users.filter(p => p.status === 'active' && p.id !== item.ownerId);
    if (!eligible.length) { $('dialog-body').replaceChildren(node('p', { textContent: 'No other active account is available. Invite or reactivate a member first.' })); return; }
    const form = node('form');
    form.append(node('p', { textContent: `Choose a new owner for “${item.title}”. Transfer clears all named grants. Existing capability links remain valid.` }));
    const target = formField(form, 'New owner', node('select', { id: 'transfer-owner', required: true }));
    setOptions(target, eligible);
    const check = node('input', { type: 'checkbox', id: 'transfer-confirm', required: true });
    form.append(node('label', { className: 'check-label', htmlFor: check.id }, check, 'I understand named sharing will be cleared.'));
    submit(form, 'Transfer ownership', async () => {
      await api(`/api/artifacts/${encodeURIComponent(item.id)}/manage`, { method: 'PATCH', body: { ownerId: target.value } });
      notify('Ownership transferred. Named sharing cleared.');
    });
    $('dialog-body').replaceChildren(form);
  } catch (err) { if (seq === dialogSequence) message('dialog-error', err.message); }
}
function openDelete(item) {
  const form = node('form');
  form.append(node('p', { textContent: `Permanently delete “${item.title}” and its entire history? All links will stop working. This cannot be undone.` }));
  const input = formField(form, 'Type DELETE to confirm', node('input', { id: 'delete-confirm', required: true, autocomplete: 'off', pattern: 'DELETE' }));
  const cancel = button('Keep artifact', () => $('dialog').close());
  form.append(cancel);
  submit(form, 'Permanently delete artifact', async () => {
    if (input.value !== 'DELETE') throw new Error('Type DELETE to confirm.');
    await api(`/api/artifacts/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    notify('Artifact deleted.');
  }, true);
  openDialog('Delete artifact', form);
  cancel.focus();
}
function openSuspend(person) {
  const suspended = person.status === 'disabled';
  confirmAction(suspended ? 'Reactivate account?' : 'Suspend account?', suspended
    ? `${person.email} can sign in again. Previously revoked API credentials remain revoked.`
    : `${person.email} will be signed out everywhere and all their API credentials revoked. Their artifacts will remain in the instance.`,
  suspended ? 'Reactivate account' : 'Suspend account', async () => {
    await api(`/api/people/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { status: suspended ? 'active' : 'disabled' } });
    notify(suspended ? 'Account reactivated.' : 'Account suspended.');
  }, !suspended);
}
function openInvite() {
  const form = node('form');
  form.append(node('p', { className: 'muted', textContent: 'They’ll receive a one-time link to their own library. Artifacts are shared separately.' }));
  const email = formField(form, 'Email address', node('input', { id: 'invite-email', type: 'email', required: true, maxLength: 254, autocomplete: 'email' }));
  const name = formField(form, 'Name (optional)', node('input', { id: 'invite-name', maxLength: 100, autocomplete: 'name' }));
  submit(form, 'Send invitation', async () => {
    await api('/api/invitations', { method: 'POST', body: { email: email.value.trim(), name: name.value.trim() } });
    notify('Invitation sent.');
  });
  openDialog('Invite someone', form);
  email.focus();
}
function openUpload() {
  const form = node('form');
  form.append(node('p', { className: 'muted', textContent: 'Upload one self-contained HTML file. Include its styles, scripts, and images inside the file. It will be private to you and the instance owner, with no expiration.' }));
  const file = formField(form, 'HTML file (up to 7 MB)', node('input', { id: 'upload-file', type: 'file', accept: '.html,.htm,text/html', required: true }));
  const title = formField(form, 'Artifact title', node('input', { id: 'upload-title', required: true, maxLength: 200 }));
  file.addEventListener('change', () => { if (!title.value && file.files[0]) title.value = file.files[0].name.replace(/\.html?$/i, '').slice(0, 200); });
  submit(form, 'Publish artifact', async () => {
    const selected = file.files[0];
    if (!selected || !/\.html?$/i.test(selected.name)) throw new Error('Choose an HTML file (.html or .htm).');
    // Base64 and the JSON envelope must also fit the server's 10 MB body cap.
    if (selected.size > 7 * 1024 * 1024) throw new Error('The HTML file must be no larger than 7 MB.');
    if (!selected.size) throw new Error('The HTML file is empty.');
    const trimmed = title.value.trim();
    if (!trimmed) throw new Error('Enter an artifact title.');
    await api('/api/artifacts', { method: 'POST', body: { title: trimmed, ttlSeconds: null, files: encodeFiles({ 'index.html': new Uint8Array(await selected.arrayBuffer()) }) } });
    state.view = 'mine'; state.q = ''; resetPagination(); writeUrl();
    notify('Artifact published. Find it in Created by me.');
  });
  openDialog('Publish artifact', form);
  file.focus();
}
function openCreateCredential() {
  const form = node('form');
  form.append(node('p', { className: 'muted', textContent: 'A credential acts as your account. Give each device or integration its own name. Keep it private.' }));
  const name = formField(form, 'Credential name', node('input', { id: 'credential-name', required: true, maxLength: 100, placeholder: 'Laptop CLI', autocomplete: 'off' }));
  const create = node('button', { type: 'submit', className: 'primary full', textContent: 'Create credential' });
  form.append(create);
  form.addEventListener('submit', e => {
    e.preventDefault();
    dialogTask(async () => {
      if (!name.value.trim()) throw new Error('Enter a credential name.');
      const data = await api('/api/credentials', { method: 'POST', body: { name: name.value.trim() } });
      // Never persist the secret, put it in a URL, or send it into an artifact.
      const secret = node('div', { className: 'secret', textContent: data.token, tabIndex: 0, ariaLabel: 'New API credential' });
      const copy = button('Copy credential', async () => {
        try { await navigator.clipboard.writeText(data.token); copy.textContent = 'Copied'; }
        catch { message('dialog-error', 'Clipboard unavailable. Select and copy the credential above.'); }
      });
      openDialog('Save your credential now', node('p', { className: 'notice', textContent: 'This is the only time this credential will be shown. Save it in your secret manager before closing.' }),
        secret, node('div', { className: 'actions' }, copy, button('I’ve saved it', () => $('dialog').close())),
        node('p', { className: 'explain', textContent: 'Use this as your CLI bearer credential. Never include it in HTML, URLs, screenshots, or shared files.' }));
    }, { close: false, reload: true });
  });
  openDialog('Create API credential', form);
  name.focus();
}

async function main() {
  try {
    // A new invitation link may be for a different user than the current cookie.
    // Always require its explicit Continue action rather than bypassing it.
    if (loginToken) return showLogin();
    const session = await api('/api/session');
    user = session.user;
    if (!user) return showLogin();
    if (location.pathname === '/login') history.replaceState(null, '', '/');
    await showApp();
  } catch (err) {
    $('boot').hidden = true;
    showLogin();
    message('login-feedback', `Could not check your session. ${err.message}`);
  }
}
main();
