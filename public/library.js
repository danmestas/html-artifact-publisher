import { encodeFiles, readFileList, withBlobs } from './client.js';
import { isBlob } from './blobs.js';
import { iconSvg, resolveIcon } from './icons.js';

const $ = id => document.getElementById(id);
const BATCH = 12;          // artifacts and publications load this many at a time: divides evenly at 4, 3 and 2 columns
const EVENT_BATCH = 25;
const LOGIN_MINUTES = 60;  // how long a sign-in link works; the server's LOGIN_TTL says the same
const LIBRARY_VIEWS = ['all', 'mine', 'shared', 'starred', 'archived'];
const SCOPE_VIEWS = ['all', 'mine', 'shared'];
const LIBRARY_NAV_VIEWS = [...SCOPE_VIEWS, 'starred', 'archived'];
const ADMIN_VIEWS = ['admin', 'people', 'activity'];
const VIEWS = {
  all: ['Your artifacts', 'A place for your work, and the work shared with you.'],
  mine: ['Created by me', 'The pages, tools, and ideas you have published.'],
  shared: ['Shared with me', 'Work that other people have shared directly with you.'],
  starred: ['Starred artifacts', 'A personal shelf for the work you want to come back to.'],
  archived: ['Archived artifacts', 'Find archived work. Creators and the instance owner can restore it from the artifact menu.'],
  admin: ['Every artifact', 'The complete inventory across every account, including private and archived work.'],
  people: ['People & invitations', 'Invite people to create their own library. Membership allows sign-in, not access to anyone’s artifacts.'],
  activity: ['Activity', 'Who changed artifacts, access and accounts, including automatic expiration.'],
  credentials: ['API credentials', 'Publish from the CLI using a credential tied to your account.'],
  publications: ['Published links', 'Manage public copies of exact artifact versions, separately from your private library.'],
};
const KIND_LABELS = { all: 'Everything', artifacts: 'Artifacts', people: 'People', credentials: 'Credentials', 'sign-ins': 'Sign-ins' };
let user = null;
let people = [];
let loadSequence = 0;
let dialogSequence = 0;
let dialogFocus = null;
let nextCursor = null;   // where the next batch of the current list starts, or null at the end
let shownCount = 0;
let toastTimer;
let searchTimer;
let loginToken = '';
let loginState = 'form'; // 'form' | 'sent' | 'expired'; a captured link shows the verify step instead
let sentEmail = '';
let resendTimer;
let activityEvents = [];
let publicationCleanupResult = '';
let recentItems = [];   // Real artifacts from the authorized recent query, memory only.
let recentRequest = 0;
let accountId = null;   // The signed-in account these in-memory caches belong to.
let accountRole = null;
let accountEpoch = 0;   // Invalidates completions from an earlier identity, even A → out → A.
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('artifact-library-preferences') || '{}') || {}; } catch { /* Optional per-browser preferences. */ }
let layout = preferences.layout === 'grid' ? 'grid' : 'list';
// The URL is the whole list state: view, search, filters, sort, and how many rows are shown (n).
function readState() {
  const p = new URLSearchParams(location.search);
  const n = Number.parseInt(p.get('n') || '', 10);
  const view = Object.hasOwn(VIEWS, p.get('view')) ? p.get('view') : 'all';
  const batch = view === 'activity' ? EVENT_BATCH : BATCH;
  return {
    view, q: (p.get('q') || '').slice(0, 300), ownerId: view === 'admin' ? p.get('ownerId') || '' : '',
    status: view === 'admin' && ['all', 'active', 'archived'].includes(p.get('status')) ? p.get('status') : 'all',
    expiry: view === 'admin' && p.get('expiry') === 'soon' ? 'soon' : 'all',
    kind: view === 'activity' && Object.hasOwn(KIND_LABELS, p.get('kind')) ? p.get('kind') : 'all',
    n: Number.isSafeInteger(n) && n > batch ? Math.min(n, 480) : batch,
    sort: p.get('sort') === 'name' ? 'name' : view === 'admin' && p.get('sort') === 'expiry' ? 'expiry' : 'recent',
  };
}
let state = readState();

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
function message(id, text = '', tone = 'info') {
  $(id).textContent = text;
  $(id).hidden = !text;
  $(id).classList.toggle('is-error', !!text && tone === 'error');
}
const initials = s => String(s || '').split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
function notify(text) {
  message('toast', text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function dateText(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
// Expiration is stored as UTC and shown in the browser's zone, with the zone named.
function dateTimeText(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const timeZoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
function localDateTimeValue(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  // Seconds are kept so saving an untouched prefilled value cannot round them
  // away; the input carries step="1" to accept them.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function relativeDate(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return 'Unknown date';
  if (ms < 60000) return 'Just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return dateText(value);
}
function savePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem('artifact-library-preferences') || '{}') || {};
    localStorage.setItem('artifact-library-preferences', JSON.stringify({ ...saved, layout }));
  } catch { /* Storage can be disabled. */ }
}

function staleAccountRequest() { return new DOMException('Account changed while the request was in flight.', 'AbortError'); }
async function api(path, { method = 'GET', body } = {}) {
  const epoch = accountEpoch;
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (epoch !== accountEpoch) throw staleAccountRequest();
    throw err;
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  // Drain the response, but never let an old success or 401 affect a newer
  // account. Callers that cache data also check again after their await.
  if (epoch !== accountEpoch) throw staleAccountRequest();
  if (!response.ok) {
    if (response.status === 401 && user) {
      user = null;
      adoptAccount(null);
      closeDialog();
      loginState = 'form';
      rememberLoginReturn();
      showLogin();
      message('login-feedback', 'Your session has ended. Sign in again to continue.');
    }
    const err = new Error(data?.error || `Request failed (HTTP ${response.status}). Try again.`);
    err.status = response.status; err.body = data;
    throw err;
  }
  return data;
}
// Where to go after signing in: the library page sign-in interrupted, if any.
function rememberLoginReturn() {
  try { if (location.search) sessionStorage.setItem('artifact-login-return', location.search); } catch { /* optional */ }
}
function takeLoginReturn() {
  try {
    const back = sessionStorage.getItem('artifact-login-return') || '';
    sessionStorage.removeItem('artifact-login-return');
    return /^\?[^#]*$/.test(back) && back.length <= 2048 ? back : '';
  } catch { return ''; }
}
// In-memory lists belong to one signed-in account. A new identity, a sign-out
// or an expired session must not inherit the previous person's titles, people
// list or activity. Recent artifacts are never written to storage.
function resetAccountCaches() {
  ++accountEpoch;
  closeDialog();
  clearPreviews();
  people = [];
  activityEvents = [];
  publicationCleanupResult = '';
  recentItems = [];
  recentLoaded = false;
  nextCursor = null;
  shownCount = 0;
  renderedView = null;
  ++loadSequence;
  $('content').replaceChildren();
  $('filter-chips').replaceChildren();
  $('clear-filters').hidden = true;
  $('filter-count').textContent = '';
  $('filter-count').hidden = true;
  renderRecent();
}
function adoptAccount(nextUser) {
  const id = nextUser ? nextUser.id : null;
  const role = nextUser ? nextUser.role : null;
  if (id === accountId && role === accountRole) return;
  resetAccountCaches();
  accountId = id;
  accountRole = role;
}
function showLogin() {
  document.documentElement.setAttribute('data-system-appearance', '');
  clearPreviews();
  closeAccountMenu();
  $('boot').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  const step = loginToken ? 'verify' : loginState;
  const form = step === 'form' || step === 'expired';
  $('login-form').hidden = !form;
  $('sent-panel').hidden = step !== 'sent';
  $('verify-panel').hidden = step !== 'verify';
  $('login-explain').hidden = !form;
  $('login-title').textContent = step === 'verify' ? 'Finish signing in' : step === 'sent' ? 'Check your inbox' : step === 'expired' ? 'This link has expired' : 'Sign in to Artifacts';
  $('login-description').textContent = step === 'verify' ? `You opened a one-time sign-in link for ${location.host}.`
    : step === 'expired' ? `Sign-in links work once and for ${LOGIN_MINUTES} minutes. Ask for a new one below.` : 'We’ll email you a one-time link. No password.';
  $('login-description').hidden = step === 'sent';
  $('login-submit').textContent = step === 'expired' ? 'Email me a new link' : 'Email me a sign-in link';
  if (step === 'expired' && !$('login-email').value) { try { $('login-email').value = sessionStorage.getItem('artifact-login-email') || ''; } catch { /* optional */ } }
  if (form) $('login-email').focus();
  else if (step === 'verify') $('verify-button').focus();
}
// The wording never says whether the address belongs to an account.
async function requestLink(email) {
  await api('/api/auth/request', { method: 'POST', body: { email } });
  sentEmail = email;
  loginState = 'sent';
  try { sessionStorage.setItem('artifact-login-email', email); } catch { /* optional */ }
  $('sent-text').replaceChildren('If ', node('strong', { textContent: email }), ` belongs to an invited account, a sign-in link is on its way. It works once, for ${LOGIN_MINUTES} minutes.`);
  startResendCountdown();
  showLogin();
}
function startResendCountdown(seconds = 30) {
  const b = $('resend-link');
  let left = seconds;
  clearTimeout(resendTimer);
  const tick = () => {
    b.disabled = left > 0;
    b.textContent = left > 0 ? `Resend in 0:${String(left).padStart(2, '0')}` : 'Resend link';
    if (left-- > 0) resendTimer = setTimeout(tick, 1000);
  };
  tick();
}
function backToForm() {
  loginToken = '';
  loginState = 'form';
  clearTimeout(resendTimer);
  message('login-feedback');
  showLogin();
  $('login-email').focus();
}
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  message('login-feedback');
  try { await requestLink($('login-email').value.trim()); }
  catch { message('login-feedback', 'The link could not be sent. Try again in a moment, or contact the person who invited you.', 'error'); }
  finally { b.disabled = false; }
});
$('resend-link').addEventListener('click', async () => {
  $('resend-link').disabled = true;
  message('login-feedback');
  try { await requestLink(sentEmail); }
  catch { message('login-feedback', 'The link could not be sent. Try again in a moment, or contact the person who invited you.', 'error'); $('resend-link').disabled = false; }
});
$('sent-different-email').addEventListener('click', backToForm);
$('verify-button').addEventListener('click', async () => {
  $('verify-button').disabled = true;
  message('login-feedback');
  try {
    const data = await api('/api/auth/verify', { method: 'POST', body: { token: loginToken } });
    loginToken = '';
    user = data.user;
    adoptAccount(user);
    history.replaceState(null, '', '/' + takeLoginReturn());
    state = readState();
    await showApp();
  } catch (err) {
    // The link was used, expired, or never valid: offer a new one rather than a dead end.
    if (err.status === 401) { loginToken = ''; loginState = 'expired'; showLogin(); }
    else message('login-feedback', err.message, 'error');
  }
  finally { $('verify-button').disabled = false; }
});
$('different-email').addEventListener('click', backToForm);
// The account menu: appearance, API credentials and sign out, behind one row.
function closeAccountMenu() {
  $('account-menu').hidden = true;
  $('account-menu-button').setAttribute('aria-expanded', 'false');
}
$('account-menu-button').addEventListener('click', () => {
  const open = $('account-menu').hidden;
  $('account-menu').hidden = !open;
  $('account-menu-button').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!$('account-menu').hidden && !e.target.closest('.account')) closeAccountMenu(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('account-menu').hidden) { e.preventDefault(); closeAccountMenu(); $('account-menu-button').focus(); }
  // Consume the handled key: its browser default can stop loading requests.
  else if (e.key === 'Escape' && filtersOpen()) { e.preventDefault(); closeFilters(); filterFocus().focus(); }
  // Cmd/Ctrl+K focuses the actual search field; it is not a command palette.
  // Never interrupt an open dialog: it may hold a one-time credential or
  // unsaved management edits, and moving focus would risk losing them.
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !$('app').hidden && !$('dialog').open) {
    e.preventDefault();
    $('search').focus();
    $('search').select();
  }
});
// A viewer "Find" link arrives as /?view=all#search. Focus the real search
// input once the app is ready, then drop the fragment so it is not resent.
function focusSearchFragment() {
  if (location.hash !== '#search' || !user) return false;
  history.replaceState(null, '', location.pathname + location.search);
  $('search').focus();
  $('search').select();
  return true;
}
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    user = null;
    adoptAccount(null);
    closeDialog();
    history.replaceState(null, '', '/login');
    loginState = 'form';
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
    if (state.expiry === 'soon') p.set('expiry', state.expiry);
  }
  if (state.view === 'activity' && state.kind !== 'all') p.set('kind', state.kind);
  if (state.n > (state.view === 'activity' ? EVENT_BATCH : BATCH)) p.set('n', String(state.n));
  if (state.sort === 'name' || (state.view === 'admin' && state.sort === 'expiry')) p.set('sort', state.sort);
  history[replace ? 'replaceState' : 'pushState'](null, '', '/' + (p.size ? '?' + p : ''));
  refreshViewerLinks();
}
function closeNavigation() {
  document.querySelector('.sidebar').classList.remove('expanded');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
  closeAccountMenu();
  closeFilters();
}
$('nav-toggle').addEventListener('click', () => {
  const expanded = document.querySelector('.sidebar').classList.toggle('expanded');
  $('nav-toggle').setAttribute('aria-expanded', String(expanded));
});
function resetPagination() { state.n = state.view === 'activity' ? EVENT_BATCH : BATCH; nextCursor = null; shownCount = 0; }
function navigate(view) {
  clearTimeout(searchTimer);
  state = { view, q: '', ownerId: '', status: 'all', expiry: 'all', kind: 'all', n: BATCH, sort: view !== 'admin' && state.sort === 'expiry' ? 'recent' : state.sort };
  resetPagination();
  writeUrl();
  closeNavigation();
  loadPage();
  $('main').focus();
}
// All/Mine/Shared and Archived switch which library slice is shown. They are
// filters on the current list: keep the search query and sort, reset pagination.
function setScope(view) {
  clearTimeout(searchTimer);
  state.view = view;
  state.ownerId = ''; state.status = 'all'; state.expiry = 'all'; state.kind = 'all';
  if (view !== 'admin' && state.sort === 'expiry') state.sort = 'recent';
  resetPagination();
  writeUrl();
  closeNavigation();
  loadPage();
  $('main').focus();
}
document.querySelectorAll('[data-view]').forEach(b => {
  if (b.hasAttribute('data-scope')) b.addEventListener('click', () => setScope(b.dataset.view));
  else b.addEventListener('click', () => navigate(b.dataset.view));
});
window.addEventListener('popstate', () => {
  state = readState();
  if (user) loadPage();
});
// The Filters control is progressive disclosure: owner/status/expiry/sort live
// in one labeled popover instead of a permanent row of competing controls.
const filterFocus = () => $('filter-toggle');
function filtersOpen() { return !$('filter-popover').hidden; }
function positionFilters() {
  const popover=$('filter-popover'),anchor=$('filter-toggle').getBoundingClientRect();
  const bounds=popover.getBoundingClientRect();
  const left=Math.max(16,Math.min(anchor.right-bounds.width,innerWidth-bounds.width-16));
  const below=anchor.bottom+6,above=anchor.top-bounds.height-6;
  const preferred=below+bounds.height<=innerHeight-16?below:above>=16?above:Math.max(16,innerHeight-bounds.height-16);
  popover.style.left=`${left}px`;popover.style.top=`${preferred}px`;
}
function openFilters() {
  if ($('filter-toggle').hidden) return;
  $('filter-popover').hidden = false;
  $('filter-popover').scrollTop=0;
  positionFilters();
  $('filter-toggle').setAttribute('aria-expanded', 'true');
  const first = $('owner-filter').hidden ? $('status-filter').querySelector('button') : $('owner-filter');
  first?.focus();
}
function closeFilters() {
  if ($('filter-popover').hidden) return;
  $('filter-popover').hidden = true;
  $('filter-toggle').setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', e => {
  if (filtersOpen() && !e.target.closest('#filter-popover') && !e.target.closest('#filter-toggle')) closeFilters();
});
window.addEventListener('resize',()=>{if(filtersOpen())positionFilters()});
document.addEventListener('scroll',e=>{if(filtersOpen()&&!$('filter-popover').contains(e.target))closeFilters()},true);
if ($('filter-toggle')) $('filter-toggle').addEventListener('click', () => { if (filtersOpen()) closeFilters(); else openFilters(); });
if ($('popover-close')) $('popover-close').addEventListener('click', () => { closeFilters(); filterFocus().focus(); });
if ($('popover-done')) $('popover-done').addEventListener('click', () => { closeFilters(); filterFocus().focus(); });
function search() {
  state.q = $('search').value;
  resetPagination();
  writeUrl(true);
  loadPage();
}
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 250); });
$('filters').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); search(); });
$('sort').addEventListener('change', () => {
  state.sort = $('sort').value;
  resetPagination(); writeUrl(); loadPage();
});
$('owner-filter').addEventListener('change', () => {
  state.ownerId = $('owner-filter').value;
  resetPagination(); writeUrl(); loadPage();
});
$('expiry-filter').addEventListener('change', () => {
  state.expiry = $('expiry-filter').value;
  resetPagination(); writeUrl(); loadPage();
});
function clearFilters() {
  clearTimeout(searchTimer);
  state.q = ''; state.ownerId = ''; state.status = 'all'; state.expiry = 'all'; state.kind = 'all';
  // Expiry ordering is presented as a removable filter; clearing must remove it.
  if (state.sort === 'expiry') state.sort = 'recent';
  resetPagination(); writeUrl(); loadPage();
}
$('clear-filters').addEventListener('click', clearFilters);
if ($('popover-clear')) $('popover-clear').addEventListener('click', () => { clearFilters(); closeFilters(); filterFocus().focus(); });
document.querySelectorAll('#status-filter [data-status]').forEach(b => b.addEventListener('click', () => {
  if (state.status === b.dataset.status) return;
  state.status = b.dataset.status;
  resetPagination(); writeUrl(); loadPage();
}));
function renderStatusCounts(counts) {
  document.querySelectorAll('#status-filter [data-status]').forEach(b => {
    const n = counts?.[b.dataset.status];
    b.querySelector('small').textContent = Number.isFinite(n) ? String(n) : '';
  });
}
document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
  layout = b.dataset.layout;
  preferences.layout = layout;
  savePreferences();
  loadPage();
}));
// "Show more" appends the next batch to the list already on the page.
$('more').addEventListener('click', async () => {
  if (!nextCursor || !user) return;
  const seq = loadSequence;
  const view = state.view;
  const first = $('content').querySelectorAll('[role="listitem"]').length;
  $('more').disabled = true;
  try {
    if (view === 'activity') {
      const data = await api(`/api/admin/activity?${new URLSearchParams({ limit: String(EVENT_BATCH), cursor: nextCursor, q: state.q, ...(state.kind === 'all' ? {} : { kind: state.kind }) })}`);
      if (seq !== loadSequence) return;
      activityEvents.push(...data.events); nextCursor = data.nextCursor;
      state.n = activityEvents.length; writeUrl(true);
      renderActivity();
    } else if (view === 'publications') {
      const data = await api('/api/publications?' + new URLSearchParams({ cursor: nextCursor }));
      if (seq !== loadSequence) return;
      renderPublications(data.publications, true);
      shownCount += data.publications.length; nextCursor = data.nextCursor;
      moreStatus(shownCount, null, 'published link');
    } else {
      const inventory = view === 'admin';
      const p = new URLSearchParams({ q: state.q, limit: String(BATCH), sort: state.sort, cursor: nextCursor });
      if (inventory) { p.set('status', state.status); if (state.ownerId) p.set('ownerId', state.ownerId); if (state.expiry === 'soon') p.set('expiry', 'soon'); } else p.set('view', view);
      const data = await api(`${inventory ? '/api/admin/artifacts' : '/api/library'}?${p}`);
      if (seq !== loadSequence) return;
      renderArtifacts(data.artifacts, inventory, true);
      shownCount += data.artifacts.length; nextCursor = data.nextCursor;
      state.n = shownCount; writeUrl(true);
      moreStatus(shownCount, data.total, 'artifact');
    }
    $('content').querySelectorAll('[role="listitem"]')[first]?.querySelector('a, button')?.focus({ preventScroll: true });
  } catch (err) { notify(err.message); }
  finally { $('more').disabled = false; }
});
/** The line under the list: what is shown of what, and whether more can be loaded. */
function moreStatus(shown, total, noun) {
  const more = !!nextCursor;
  $('pagination').hidden = !more && !(total !== null && shown >= total && shown > BATCH);
  $('more').hidden = !more;
  $('more').textContent = `Show ${BATCH} more`;
  $('shown').textContent = total === null ? `${shown} ${noun}${shown === 1 ? '' : 's'} shown` : `${shown} of ${total} shown`;
}

/** Active inventory filters as removable chips, plus the count on the Filters button. */
function renderActiveFilters() {
  const chips = $('filter-chips');
  const inventory = state.view === 'admin';
  const activity = state.view === 'activity';
  const plan = [];
  if (state.q) plan.push(['q', `Search: ${state.q}`]);
  if (activity && state.kind !== 'all') plan.push(['kind', KIND_LABELS[state.kind]]);
  if (inventory) {
    if (state.ownerId) {
      const option = [...$('owner-filter').options].find(o => o.value === state.ownerId);
      plan.push(['ownerId', `Owner: ${option?.textContent || state.ownerId}`]);
    }
    if (state.status !== 'all') plan.push(['status', state.status === 'archived' ? 'Archived' : 'Active']);
    if (state.expiry === 'soon') plan.push(['expiry', 'Expiring in 7 days']);
    if (state.sort === 'expiry') plan.push(['sort', 'Expires soonest']);
  }
  chips.replaceChildren(...plan.map(([key, text]) => {
    const chip = button(text, () => removeFilter(key), 'filter-chip');
    chip.setAttribute('aria-label', `Remove filter: ${text}`);
    return chip;
  }));
  const count = plan.length;
  $('filter-count').textContent = count ? String(count) : '';
  $('filter-count').hidden = !count;
  $('filter-toggle').setAttribute('aria-label', count ? `Filters, ${count} active` : 'Filters');
  $('clear-filters').hidden = !count;
}
function removeFilter(key) {
  clearTimeout(searchTimer);
  if (key === 'q') { state.q = ''; $('search').value = ''; }
  if (key === 'ownerId') { state.ownerId = ''; $('owner-filter').value = ''; }
  if (key === 'status') { state.status = 'all'; }
  if (key === 'expiry') { state.expiry = 'all'; $('expiry-filter').value = 'all'; }
  if (key === 'sort') { state.sort = 'recent'; $('sort').value = 'recent'; }
  if (key === 'kind') state.kind = 'all';
  resetPagination(); writeUrl(); loadPage();
}

let recentLoaded = false;
// Recent links come from the same authorized library query the list uses.
// They live in memory only, and never claim an artifact the account cannot open.
function renderRecent() {
  const group = $('recent-group'), list = $('recent-list');
  group.hidden = !recentItems.length;
  list.replaceChildren(...recentItems.map(item => {
    const link = node('a', { className: 'nav-button', href: viewerUrl(item), title: item.title || 'Untitled artifact' },
      node('span', { className: 'nav-icon', ariaHidden: 'true' }), node('span', { textContent: item.title || 'Untitled artifact' }));
    link.firstChild.innerHTML = iconSvg(resolveIcon(item.icon, item.title));
    link.addEventListener('click', rememberLibraryNavigation);
    return link;
  }));
}
async function loadRecent(force = false) {
  if (!user || (recentLoaded && !force)) return;
  const epoch = accountEpoch, request = ++recentRequest;
  recentLoaded = true;
  try {
    const data = await api('/api/library?' + new URLSearchParams({ view: 'all', sort: 'recent', limit: '3' }));
    if (epoch !== accountEpoch || request !== recentRequest) return;
    recentItems = (data.artifacts || []).filter(item => !item.archived).slice(0, 3);
    renderRecent();
  } catch {
    // An obsolete failure must not invalidate the new account's completed list.
    if (epoch === accountEpoch && request === recentRequest) recentLoaded = false;
  }
}

async function showApp() {
  if (!user) return showLogin();
  document.documentElement.removeAttribute('data-system-appearance');
  restoreLibraryNavigation();
  $('boot').hidden = true;
  $('login').hidden = true;
  $('app').hidden = false;
  $('account-name').textContent = user.name || user.email;
  $('account-email').textContent = user.email;
  $('account-avatar').textContent = initials(user.name || user.email);
  $('account-role').textContent = user.role === 'owner' ? 'Instance owner' : 'Member';
  document.querySelectorAll('[data-owner-only]').forEach(n => { n.hidden = user.role !== 'owner'; });
  await loadPage();
  loadRecent();
  focusSearchFragment();
}
function empty(title, text) {
  return node('div', { className: 'empty' }, node('h2', { textContent: title }), node('p', { textContent: text }));
}
async function loadPeople() {
  const epoch = accountEpoch;
  const data = await api('/api/people');
  if (epoch !== accountEpoch) throw staleAccountRequest();
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
  if (ADMIN_VIEWS.includes(state.view) && user.role !== 'owner') {
    state = { ...state, view: 'all', ownerId: '', status: 'all', expiry: 'all', kind: 'all', sort: state.sort === 'expiry' ? 'recent' : state.sort };
    resetPagination(); writeUrl(true);
  }
  const seq = ++loadSequence;
  const view = state.view;
  const library = LIBRARY_VIEWS.includes(view);
  const inventory = view === 'admin';
  $('page-title').textContent = VIEWS[view][0];
  $('page-description').textContent = VIEWS[view][1];
  document.title = `${VIEWS[view][0]} · Artifacts`;
  // Scope is a filter on the library, so All/Mine/Shared all mark "Library".
  const currentView = LIBRARY_NAV_VIEWS.includes(view) && view !== 'starred' && view !== 'archived' ? 'all' : view;
  document.querySelectorAll('.sidebar [data-view]').forEach(b => {
    if (b.dataset.view === currentView) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('filters').hidden = !library && !inventory && view !== 'people' && view !== 'activity';
  // The library keeps a visible sort; inventory sort belongs with its other
  // filters inside the labeled Filters popover.
  $('sort-field').hidden = !library && !inventory;
  (inventory ? $('filter-sort-slot') : $('sort-slot')).append($('sort-field'));
  $('sort-label').className = inventory ? 'field-label' : 'sr-only';
  $('filter-sort-slot').hidden = !inventory;
  const searchLabel = view === 'people' ? 'Search people' : view === 'activity' ? 'Search activity' : 'Search artifacts';
  $('search-label').textContent = searchLabel;
  const searchFilled = !!state.q;
  // The library's search stays a plain, labeled field; people/activity keep a
  // visible label once a search is in play.
  $('search-label').className = library && !searchFilled ? 'sr-only' : 'search-label';
  $('search').placeholder = view === 'people' ? 'Name or email…' : view === 'activity' ? 'Person, artifact or ID…' : 'Search artifacts…';
  $('scopes').hidden = !library;
  // Archived stays one click away from the library without becoming a sixth peer.
  $('archived-link').hidden = !LIBRARY_NAV_VIEWS.includes(view);
  $('archived-link').setAttribute('aria-pressed', String(view === 'archived'));
  document.querySelectorAll('#scopes [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  $('layout-switch').hidden = !library;
  $('filter-toggle').hidden = !inventory;
  $('owner-field').hidden = !inventory;
  $('expiry-field').hidden = !inventory;
  $('status-field').hidden = !inventory;
  $('owner-filter').hidden = !inventory;
  $('status-filter').hidden = !inventory;
  $('expiry-filter').hidden = !inventory;
  $('sort').querySelector('[value="expiry"]').hidden = !inventory;
  $('sort').querySelector('[value="expiry"]').disabled = !inventory;
  if (!inventory) closeFilters();
  $('expiry-filter').value = state.expiry;
  renderActiveFilters();
  $('inventory-note').hidden = !inventory;
  $('inventory-note').textContent = `Expiration permanently deletes private content and history. Public copies remain until unpublished. Times shown in ${timeZoneName()}.`;
  $('privacy-note').hidden = !library && !inventory;
  clearPreviews();
  $('sort').value = state.sort;
  $('search').value = state.q;
  document.querySelectorAll('#status-filter [data-status]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.status === state.status)));
  document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
  const action = library && view !== 'archived' ? ['Publish artifact', openUpload] : view === 'people' ? ['Invite someone', openInvite] : view === 'credentials' ? ['Create credential', openCreateCredential] : view === 'publications' && user.role === 'owner' ? ['Clean up unpublished files', openPublicationCleanup] : null;
  $('page-action').hidden = !action;
  $('page-action').onclick = action ? action[1] : null;
  $('page-action').textContent = action?.[0] || '';
  $('pagination').hidden = true;
  $('result-status').textContent = 'Loading…';
  message('page-error');
  $('content').setAttribute('aria-busy', 'true');
  // A refresh of the same view keeps the useful list on screen; only a view
  // with nothing rendered yet gets the loading placeholder.
  const hadContent = renderedView === view && $('content').childElementCount > 0;
  if (!hadContent) $('content').replaceChildren(node('div', { className: 'loading', textContent: `Loading ${inventory ? 'the instance inventory' : view === 'people' ? 'people and invitations' : view === 'activity' ? 'activity' : view === 'credentials' ? 'credentials' : view === 'publications' ? 'published links' : 'your work'}…` }));
  else $('content').classList.add('is-refreshing');
  try {
    if (library || inventory) {
      if (inventory) {
        const users = await loadPeople();
        if (seq !== loadSequence) return;
        // Invited accounts own nothing yet; suspended ones may, so they stay, marked.
        setOptions($('owner-filter'), users.filter(u => u.status !== 'invited').map(u => (u.status === 'disabled' ? { ...u, name: `${u.name || u.email} (suspended)` } : u)), 'Every owner');
        $('owner-filter').value = state.ownerId;
      }
      // A linked or returned-to URL says how many rows were shown: load that many, in requests of up to 100.
      const items = []; let total = 0; let counts = null; let cursor = '';
      do {
        const p = new URLSearchParams({ q: state.q, limit: String(Math.min(100, state.n - items.length)), sort: state.sort });
        if (cursor) p.set('cursor', cursor);
        if (inventory) { p.set('status', state.status); if (state.ownerId) p.set('ownerId', state.ownerId); if (state.expiry === 'soon') p.set('expiry', 'soon'); } else p.set('view', view);
        const data = await api(`${inventory ? '/api/admin/artifacts' : '/api/library'}?${p}`);
        if (seq !== loadSequence) return;
        items.push(...data.artifacts); total = data.total; counts = data.counts ?? counts; cursor = data.nextCursor;
      } while (cursor && items.length < state.n);
      renderArtifacts(items, inventory);
      renderActiveFilters();
      if (inventory) renderStatusCounts(counts);
      else {
        // Recent is its own chronological collection, not the first results of
        // a search/scope/name sort. Keep its links on the current return URI.
        renderRecent();
        loadRecent();
      }
      nextCursor = cursor; shownCount = items.length; state.n = Math.max(BATCH, items.length);
      moreStatus(shownCount, total, 'artifact');
      $('result-status').textContent = `${total} artifact${total === 1 ? '' : 's'} · ${state.sort === 'expiry' ? 'Expires soonest · never last' : state.sort === 'name' ? 'Name A–Z' : 'Recently updated first'}`;
    } else if (view === 'publications') {
      const data = await api('/api/publications');
      if (seq !== loadSequence) return;
      renderPublications(data.publications);
      nextCursor = data.nextCursor; shownCount = data.publications.length;
      moreStatus(shownCount, null, 'published link');
      $('result-status').textContent = `Published links · ${user.role === 'owner' ? 'Every account' : 'Created by you'}`;
    } else if (view === 'people') {
      const users = await loadPeople();
      if (seq !== loadSequence) return;
      const q = state.q.trim().toLocaleLowerCase();
      const matching = q ? users.filter(p => `${p.name || ''} ${p.email}`.toLocaleLowerCase().includes(q)) : users;
      renderPeople(matching);
      $('result-status').textContent = `${matching.length}${q ? ` of ${users.length}` : ''} account${matching.length === 1 && !q ? '' : 's'}`;
    } else if (view === 'activity') {
      const events = []; let cursor = '';
      do {
        const data = await api(`/api/admin/activity?${new URLSearchParams({ limit: String(Math.min(EVENT_BATCH, state.n - events.length)), q: state.q, ...(cursor ? { cursor } : {}), ...(state.kind === 'all' ? {} : { kind: state.kind }) })}`);
        if (seq !== loadSequence) return;
        events.push(...data.events); cursor = data.nextCursor;
      } while (cursor && events.length < state.n);
      activityEvents = events; nextCursor = cursor;
      state.n = Math.max(EVENT_BATCH, events.length);
      renderActivity();
    } else {
      const data = await api('/api/credentials');
      if (seq !== loadSequence) return;
      renderCredentials(data.credentials);
      $('result-status').textContent = `${data.credentials.length} credential${data.credentials.length === 1 ? '' : 's'}`;
    }
  } catch (err) {
    if (seq !== loadSequence) return;
    $('content').classList.remove('is-refreshing');
    $('content').replaceChildren(button('Try again', loadPage));
    $('result-status').textContent = 'Could not load this page.';
    message('page-error', err.message);
  } finally {
    if (seq === loadSequence) {
      renderedView = view;
      $('content').setAttribute('aria-busy', 'false');
      $('content').classList.remove('is-refreshing');
      if (restoreScroll !== null) {
        const top = restoreScroll;
        restoreScroll = null;
        requestAnimationFrame(() => window.scrollTo(0, top));
      }
    }
  }
}
// Session URLs never carry tokens. Ignore untrusted URL schemes/origins from metadata.
function viewerUrl(item) {
  const query = new URLSearchParams({ returnTo: location.pathname + location.search });
  return `/v/${encodeURIComponent(item.id)}?${query}`;
}
// Links are built while rendering, so "Show more" must rewrite the returnTo on
// rows already on the page; Back then restores the batches the URL records.
function refreshViewerLinks() {
  for (const anchor of document.querySelectorAll('#content a[href^="/v/"], #recent-list a[href^="/v/"]')) {
    try {
      const href = new URL(anchor.getAttribute('href'), location.origin);
      if (href.origin !== location.origin) continue;
      href.searchParams.set('returnTo', location.pathname + location.search);
      anchor.setAttribute('href', href.pathname + href.search);
    } catch { /* A malformed href is left as it is. */ }
  }
}
let restoreScroll = null;
let renderedView = null;   // which view the content currently shows, for honest refresh
function rememberLibraryNavigation() {
  if (!user) return;
  try {
    sessionStorage.setItem('artifact-library-navigation', JSON.stringify({
      userId: user.id, url: location.pathname + location.search, scrollY: window.scrollY,
    }));
  } catch { /* Browsing context is an optional per-tab convenience. */ }
}
function restoreLibraryNavigation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('artifact-library-navigation') || 'null');
    if (saved?.userId !== user.id || saved.url !== location.pathname + location.search) return;
    if (Number.isFinite(saved.scrollY) && saved.scrollY >= 0) restoreScroll = saved.scrollY;
  } catch { /* The URL still restores filters when storage is unavailable. */ }
}
document.addEventListener('click', e => {
  const anchor = e.target.closest('a');
  if (anchor?.origin === location.origin && anchor.pathname.startsWith('/v/')) rememberLibraryNavigation();
}, true);
const mine = item => (item.ownerId || 'instance-owner') === user?.id;
// Only what the access badge does not already say: when, and whose if not yours.
function meta(item) {
  return `Updated ${relativeDate(item.updatedAt)}${mine(item) ? '' : ` · ${item.ownerName || 'Instance owner'}`}`;
}
function starButton(item, className) {
  const b = node('button', { type: 'button', className });
  const paint = () => {
    b.textContent = item.starred ? '★' : '☆';
    b.setAttribute('aria-pressed', String(!!item.starred));
    b.ariaLabel = `${item.starred ? 'Unstar' : 'Star'} ${item.title || 'artifact'}`;
    b.title = item.starred ? 'Unstar' : 'Star';
  };
  paint();
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`/api/artifacts/${encodeURIComponent(item.id)}/star`, { method: 'PUT', body: { starred: !item.starred } });
      item.starred = !item.starred;
      if (state.view === 'starred') { await loadPage(); return; }
      paint();
    } catch (err) { notify(err.message); }
    finally { b.disabled = false; }
  });
  return b;
}
// Previews are sandboxed static documents, loaded as a card comes within two
// screens of the viewport and unloaded again once it is further away, so a
// long list holds only the frames near the reader, on phones too.
let previewObserver;
function clearPreviews() {
  previewObserver?.disconnect();
  previewObserver = null;
  document.querySelectorAll('.artifact-preview iframe').forEach(frame => frame.remove());
}
function loadPreviews() {
  if ($('app').hidden) return;
  if (!previewObserver) previewObserver = new IntersectionObserver((entries, observer) => {
    if (observer !== previewObserver || $('app').hidden) return;
    for (const { target, isIntersecting } of entries) {
      const frame = target.querySelector('iframe');
      if (!isIntersecting) { frame?.remove(); continue; }
      if (frame || !target.isConnected) continue;
      const next = node('iframe', { title: 'Static artifact preview', tabIndex: -1, loading: 'lazy' });
      next.setAttribute('sandbox', '');
      next.setAttribute('aria-hidden', 'true');
      next.referrerPolicy = 'no-referrer';
      next.src = `/p/${encodeURIComponent(target.dataset.id)}`;
      target.prepend(next);
    }
  }, { rootMargin: '200% 0px' });
  document.querySelectorAll('.artifact-preview').forEach(el => previewObserver.observe(el));
}
window.addEventListener('pagehide', clearPreviews);
window.addEventListener('pageshow', e => { if (e.persisted) loadPreviews(); });
function renderArtifacts(items, inventory, append = false) {
  if (append) {
    const list = $('content').querySelector('.artifact-grid, .artifact-list');
    if (list) { list.append(...artifactEntries(items, inventory, list.classList.contains('artifact-grid'))); loadPreviews(); return; }
  }
  if (!items.length && state.view === 'archived' && !state.q) {
    $('content').replaceChildren(empty('Nothing archived', 'Archived artifacts you own or can access will appear here. Creators can restore them from the artifact menu.'));
    return;
  }
  if (!items.length) {
    const filtered = !!state.q || (inventory && (!!state.ownerId || state.status !== 'all' || state.expiry === 'soon')) || (state.view === 'activity' && state.kind !== 'all');
    $('content').replaceChildren(empty(filtered ? 'No matching artifacts' : inventory ? 'No artifacts in this instance' : state.view === 'starred' ? 'Keep your favorites close' : 'Your shelf is ready',
      filtered ? 'Try a different search or clear your filters.' : inventory ? 'Artifacts published by members appear here, including private and archived work. Expired content is permanently deleted.' : state.view === 'starred' ? 'Open an artifact’s menu and choose Star artifact.' : 'Publish an HTML page and the files it uses, or find work shared with you here.'));
    return;
  }
  const grid = !inventory && layout === 'grid';
  const list = node('div', { className: grid ? 'artifact-grid' : 'artifact-list', role: 'list' }, ...artifactEntries(items, inventory, grid));
  const headings = node('div', { className: `inventory-head${inventory ? ' inventory' : ''}`, ariaHidden: 'true' },
    ...(inventory ? ['Artifact', 'Owner', 'Visibility', 'Status', 'Updated', 'Expires', ''] : ['Artifact', 'Owner', 'Updated', '', '']).map(textContent => node('span', { textContent })));
  $('content').replaceChildren(...(grid ? [list] : [headings, list]));
  loadPreviews();
}
function expirationSummary(item, prefix = true) {
  if (!item.expiresAt) return 'Never expires';
  if (new Date(item.expiresAt).getTime() <= Date.now()) return 'Expired — refresh to update';
  return `${prefix ? 'Expires ' : ''}${dateTimeText(item.expiresAt)}`;
}
function artifactEntries(items, inventory, grid) {
  const out = [];
  const cell = (label, className, ...content) => node('span', { className: `cell ${className}` }, node('span', { className: 'sr-only', textContent: label }), ...content);
  const chip = (text, kind) => node('span', { className: `chip ${kind}`, textContent: text });
  for (const item of items) {
    const title = node('a', { className: 'artifact-title', href: viewerUrl(item), title: item.title, textContent: item.title || 'Untitled artifact' });
    const icon = node('span', { className: 'artifact-icon', ariaHidden: 'true' });
    icon.innerHTML = iconSvg(resolveIcon(item.icon, item.title));
    title.prepend(icon);
    const badge = node('span', { className: 'access-badge', textContent: item.accessLabel });
    // The list's quiet rows show a subtitle: owner when it is not yours, then
    // status. The accessible cells below still carry the full columns.
    const subtitle = inventory
      ? `${mine(item) ? 'You' : item.ownerName || 'Instance owner'} · ${item.visibility === 'shared' ? 'Shared' : 'Private'} · ${item.archived ? 'Archived' : 'Active'}`
      : meta(item);
    // The inventory is about everyone's work; the reader's own access is beside the point there.
    const summary = node('div', {}, title, node('div', { className: 'shelf-meta' }, inventory ? null : badge,
      node('span', { className: 'artifact-meta', title: subtitle, textContent: subtitle })));
    if (inventory) summary.append(node('div', { className: 'inventory-mobile' },
      node('span', { textContent: `${mine(item) ? 'You' : item.ownerName || 'Instance owner'} · ${item.visibility === 'shared' ? 'Shared' : 'Private'} · ${item.archived ? 'Archived' : 'Active'}` }),
      node('span', { className: 'inventory-expiration', textContent: expirationSummary(item) })));
    const menu = button('⋯', () => openManage(item), 'icon-button artifact-menu');
    menu.setAttribute('aria-label', `${item.canManage ? 'Manage' : 'Details for'} ${item.title || 'artifact'}`);
    const entry = node('article', { className: grid ? 'artifact-card' : `artifact-row${inventory ? ' inventory-row' : ''}${item.archived ? ' is-archived' : ''}`, role: 'listitem' });
    if (grid) {
      const preview = node('a', { className: 'artifact-preview', href: viewerUrl(item), tabIndex: -1, ariaHidden: 'true' });
      preview.dataset.id = item.id;
      entry.append(preview, node('div', { className: 'artifact-summary' }, summary, node('div', { className: 'card-actions' }, starButton(item, 'icon-button star-button'), menu)));
    } else {
      entry.append(summary, cell('Owner: ', 'owner-cell', mine(item) ? 'You' : item.ownerName || 'Instance owner'));
      if (inventory) {
        entry.append(cell('Visibility: ', 'visibility-cell', chip(item.visibility === 'shared' ? 'Shared' : 'Private', item.visibility === 'shared' ? 'shared' : 'private')),
          cell('Status: ', 'status-cell', chip(item.archived ? 'Archived' : 'Active', item.archived ? 'archived' : 'active')));
      }
      entry.append(cell('Updated: ', 'time-cell', relativeDate(item.updatedAt)));
      if (inventory) entry.append(cell('Expires: ', 'expiry-cell', item.expiresAt
        ? node('time', { dateTime: item.expiresAt, title: `${dateTimeText(item.expiresAt)} (${timeZoneName()})`, textContent: expirationSummary(item, false) })
        : 'Never expires'));
      if (!inventory) entry.append(starButton(item, 'row-star'));
      entry.append(menu);
    }
    out.push(entry);
  }
  return out;
}
function publicationUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function publicationSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// What an exporter error means for the person, and what to do. The raw reason stays as detail.
const PUBLISH_HELP = 'https://github.com/danmestas/html-artifact-publisher#public-snapshots';
function publicationAdvice(error) {
  const e = String(error || '');
  if (/non-local .* resource/.test(e)) return 'The page loads something from another site: a script, style, image or font. Public pages cannot reach other sites. Bundle that file in the version and use a relative path.';
  if (/bare module import/.test(e)) return 'The page imports a module by bare name. Bundle the module and import it by a relative path.';
  if (/root-relative/.test(e)) return 'The page loads a file by a root-relative path starting with “/”. Use a document-relative path instead.';
  if (/private artifact runtime/.test(e)) return 'The page uses window.artifact, which public copies do not have. Remove that dependency, or keep the artifact private.';
  if (/frame or object/.test(e)) return 'The page embeds another page in a frame. Public pages cannot; include that content directly.';
  if (/missing (script|stylesheet|files)|Source blob is missing/.test(e)) return 'A file the page references is not in this version. Add it and publish again.';
  if (/no HTML document/.test(e)) return 'This version has no HTML page to publish.';
  if (/diagram/.test(e)) return 'A diagram on the page could not be rendered. Fix the diagram source and publish again.';
  if (/exceeds/.test(e)) return 'The prepared copy is over the 250 MiB limit. Remove or shrink large files and publish again.';
  if (/cancelled|timed out/.test(e)) return 'Publishing was interrupted before it finished. Publish again.';
  return 'Publishing failed. The reason is below.';
}
function openPublication(item) {
  const version = String(item.checkin || '');
  const actions = node('div', { className: 'manage-actions' },
    node('a', { className: 'button-link', href: `${viewerUrl({ id: item.artifactId })}#@${encodeURIComponent(version)}`, textContent: 'View source version' }));
  if (item.status !== 'deleted') actions.append(button(item.status === 'live' ? 'Unpublish…' : 'Remove publication…', () => openUnpublish(item), 'danger'));
  openDialog(item.title || 'Untitled artifact', actions);
}
function renderPublications(publications, append = false) {
  const notice = node('p', { className: 'notice', textContent: 'Public files are independent copies. Deleting or expiring a private source does not unpublish them. Use this screen to unpublish a link and delete its copied files; the original artifact and its history stay untouched.' });
  const feedback = node('p', { className: 'notice', role: 'status', textContent: publicationCleanupResult, hidden: !publicationCleanupResult });
  if (!publications.length && !append) {
    $('content').replaceChildren(notice, feedback, empty('No published links yet', 'Public copies published from an artifact’s viewer will appear here.'));
    return;
  }
  const list = append ? $('content').querySelector('.publication-list') : node('div', { className: 'record-list publication-list', role: 'list' });
  if (!list) return;
  for (const item of publications) {
    const title = item.title || 'Untitled artifact';
    const version = String(item.checkin || '');
    const status = node('span', { className: `badge publication-status ${item.status === 'failed' ? 'publication-failed' : ''}`, textContent: { building: 'Building', live: 'Live', failed: 'Failed', deleted: 'Unpublished' }[item.status] || 'Unavailable' });
    const details = node('div', { className: 'publication-details' },
      node('h2', { textContent: title }), status,
      node('div', { className: 'publication-meta' },
        node('span', {}, 'Source version ', node('code', { textContent: version ? version.slice(0, 12) : 'Unknown', title: version })),
        node('span', { textContent: `${item.files} file${item.files === 1 ? '' : 's'} · ${publicationSize(item.bytes)}` }),
        node('time', { dateTime: item.createdAt, textContent: `Published ${dateText(item.createdAt)}`, title: item.createdAt })),
      user.role === 'owner' ? node('p', { className: 'publication-owner', textContent: `Owner: ${item.ownerName || item.ownerId}` }) : null);
    const more = button('⋯', () => openPublication(item), 'icon-button artifact-menu');
    more.setAttribute('aria-label', `Actions for ${title}`);
    const actions = node('div', { className: 'record-actions' }, more);
    const url = item.status === 'live' ? publicationUrl(item.url) : null;
    if (url) {
      details.append(node('a', { className: 'publication-url', href: url, target: '_blank', rel: 'noopener noreferrer', textContent: url, ariaLabel: `Open public link for ${title}` }));
      const copy = button('Copy public link', async () => {
        copy.disabled = true;
        try { await navigator.clipboard.writeText(url); notify('Public link copied.'); }
        catch { notify('Clipboard unavailable. Select and copy the public link.'); }
        finally { copy.disabled = false; }
      });
      actions.prepend(copy);
    } else {
      details.append(node('p', { className: 'publication-hint', textContent: item.status === 'building' ? 'Preparing copied files. Refresh to check progress.' : item.status === 'failed' ? 'Publishing failed. No public link is available.' : item.status === 'deleted' ? 'This public link has been unpublished.' : 'No public link is available.' }));
    }
    if (item.status === 'failed' && item.error) {
      details.append(node('div', { className: 'error' }, node('p', { textContent: publicationAdvice(item.error) }),
        node('details', {}, node('summary', { textContent: 'What the exporter said' }), node('code', { textContent: item.error })),
        node('a', { href: PUBLISH_HELP, target: '_blank', rel: 'noopener noreferrer', textContent: 'How public copies work' })));
    }
    list.append(node('article', { className: 'record publication-record', role: 'listitem' }, details, actions));
  }
  if (append) return;
  const refresh = button('Refresh published links', loadPage);
  $('content').replaceChildren(notice, feedback, list, node('div', { className: 'actions' }, refresh));
}
function openUnpublish(item) {
  const live = item.status === 'live';
  confirmAction(live ? 'Unpublish this public link?' : 'Remove this publication?',
    live ? `Unpublish “${item.title || 'Untitled artifact'}” and delete its copied public files? The public link will stop working. The original artifact and its history stay untouched. Copies already downloaded by others cannot be recalled.`
      : `Remove the ${item.status} publication for “${item.title || 'Untitled artifact'}” and delete any copied public files? The original artifact and its history stay untouched.`,
    live ? 'Unpublish and delete copied files' : 'Remove publication', async () => {
      await api(`/api/publications/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      notify('Publication removed. The public link is unavailable; the original artifact and history are unchanged.');
    }, true);
}
function openPublicationCleanup() {
  if (user?.role !== 'owner') return;
  confirmAction('Clean up unpublished files?', 'Delete leftover copied files from failed or unpublished records, and builds older than one hour. Live public snapshots are never deleted. Original artifacts and their history stay untouched.', 'Clean up unpublished files', async () => {
    const result = await api('/api/publications/cleanup', { method: 'POST', body: {} });
    publicationCleanupResult = `Cleaned ${result.cleaned} publication${result.cleaned === 1 ? '' : 's'}.${result.remaining ? ' More publication records remain to check. Run cleanup again to continue.' : ' Cleanup complete.'}`;
    notify(publicationCleanupResult);
  });
}
function renderPeople(users) {
  if (!users.length) return $('content').replaceChildren(empty('No matching people', 'Try a different name or email, or clear your search.'));
  const members = users.filter(p => p.role === 'owner' || p.status === 'active');
  const invited = users.filter(p => p.role !== 'owner' && p.status === 'invited');
  const suspended = users.filter(p => p.role !== 'owner' && p.status === 'disabled');
  const groups = [['Members', members], ['Invitations', invited], ['Suspended', suspended]].filter(([, list]) => list.length);
  $('content').replaceChildren(...groups.map(([name, list]) => node('section', { className: 'people-group' },
    node('h2', { className: 'group-head' }, name, node('small', { textContent: String(list.length) })),
    node('div', { className: 'record-list' }, ...list.map(personRow)))));
}
function personName(p) { return p.name && p.name !== p.email ? p.name : ''; }
function minutesLeft(seconds) { return `${Math.max(1, Math.ceil(seconds / 60))} min`; }
function inviteLinkState(p) {
  if (!p.inviteExpiresAt) return 'link expired';
  const left = (new Date(p.inviteExpiresAt).getTime() - Date.now()) / 1000;
  return left > 0 ? `link expires in ${minutesLeft(left)}` : 'link expired';
}
function personArtifacts(p) {
  const count = p.artifactCount;
  return node('a', { className: 'person-artifacts',
    href: '/?' + new URLSearchParams({ view: 'admin', ownerId: p.id }),
    textContent: Number.isFinite(count) ? `View ${count} artifact${count === 1 ? '' : 's'}` : 'View artifacts',
    ariaLabel: `View artifacts owned by ${personName(p) || p.email}` });
}
function personRow(p) {
  const owner = p.role === 'owner', invited = p.status === 'invited', suspended = p.status === 'disabled';
  const name = personName(p);
  const detail = [name ? p.email : '', invited ? `${p.createdAt ? `Invitation sent ${dateText(p.createdAt)}` : 'Invitation pending'} · ${inviteLinkState(p)}` : ''].filter(Boolean).join(' · ');
  const row = node('div', { className: `record person${suspended ? ' is-suspended' : ''}` },
    node('span', { className: 'avatar', ariaHidden: 'true', textContent: initials(name || p.email) }),
    node('div', { className: 'identity' }, node('strong', { textContent: name || p.email }), detail ? node('small', { textContent: detail }) : null),
    node('span', { className: `state ${owner ? 'owner' : invited ? 'invited' : suspended ? 'disabled' : 'active'}`, textContent: owner ? 'Instance owner' : invited ? 'Invited · not yet signed in' : suspended ? 'Suspended' : 'Active' }));
  row.dataset.personId = p.id;
  if (!invited) row.querySelector('.identity').append(node('small', { className: 'person-signin', textContent: p.lastSignInAt ? `Last sign-in ${dateTimeText(p.lastSignInAt)}` : 'No recorded sign-in' }));
  const actions = node('div', { className: 'record-actions' });
  if (!invited) actions.append(personArtifacts(p));
  if (!owner) {
    if (invited) {
      const resend = button(p.resendAfter > 0 ? `Resend in ${minutesLeft(p.resendAfter)}` : 'Resend', () => resendInvitation(p), 'linkish');
      resend.disabled = p.resendAfter > 0;
      if (p.resendAfter > 0) resend.title = 'A link was sent recently. Wait before sending another.';
      actions.append(resend, button('Withdraw', () => withdrawInvitation(p), 'linkish'));
    }
    const more = button('⋯', () => openPerson(p), 'icon-button');
    more.setAttribute('aria-label', `Actions for ${name || p.email}`);
    actions.append(more);
  }
  if (actions.childElementCount) row.append(actions);
  return row;
}
function resendInvitation(p) {
  if (p.resendAfter > 0) return notify(`A link went to ${p.email} recently. Resend in ${minutesLeft(p.resendAfter)}.`);
  confirmAction('Resend invitation?', `Send a fresh invitation to ${p.email}?`, 'Send invitation', async () => {
    await api('/api/invitations', { method: 'POST', body: { email: p.email, name: personName(p) } });
    notify('Invitation sent.');
  });
}
function withdrawInvitation(p) {
  confirmAction('Withdraw invitation?', `${p.email} will be removed and their sign-in link will stop working. You can invite them again later.`, 'Withdraw invitation', async () => {
    await api(`/api/people/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    notify('Invitation withdrawn.');
  }, true);
}
function openPerson(p) {
  const invited = p.status === 'invited', suspended = p.status === 'disabled';
  const details = node('dl', { className: 'details-grid' });
  for (const [label, value] of [['Email', p.email], ['Status', invited ? 'Invited, not yet signed in' : suspended ? 'Suspended' : 'Active member'],
    ['Artifacts', Number.isFinite(p.artifactCount) ? `${p.artifactCount} current, including archived` : 'See inventory'],
    ['Last sign-in', p.lastSignInAt ? dateTimeText(p.lastSignInAt) : 'No recorded sign-in']]) {
    details.append(node('dt', { textContent: label }), node('dd', { textContent: value }));
  }
  const actions = node('div', { className: 'manage-actions' });
  if (!invited) actions.append(personArtifacts(p));
  if (invited) actions.append(button('Resend invitation', () => resendInvitation(p)), button('Withdraw invitation', () => withdrawInvitation(p)));
  actions.append(button(suspended ? 'Reactivate account' : 'Suspend account', () => openSuspend(p), suspended ? '' : 'danger'));
  openDialog(personName(p) || p.email, details, actions);
}
// Each audit row as a sentence. The audit keeps the actor; artifact and account targets when recorded.
const EVENT_KIND = { publish: 'artifacts', delete: 'artifacts', expired: 'artifacts', 'rotate-comment-link': 'artifacts', archive: 'artifacts', restore: 'artifacts', rename: 'artifacts', transfer: 'artifacts', sharing_change: 'artifacts', expiration: 'artifacts', invite: 'people', invite_withdrawn: 'people', account_disabled: 'people', account_active: 'people', credential_create: 'credentials', credential_revoke: 'credentials', sign_in: 'sign-ins' };
const EVENT_GLYPH = { artifacts: '▤', people: '✉', credentials: '⚿', 'sign-ins': '→', account_disabled: '⊘', account_active: '✓' };
function eventSentence(e) {
  const artifact = e.artifactId && !['delete','expired'].includes(e.action) ? node('a', { href: viewerUrl({ id: e.artifactId }), textContent: e.artifactTitle || 'an artifact' }) : (e.artifactTitle || 'an artifact');
  const target = e.target || '';
  if (e.action === 'expiration') {
    if (e.details && Object.hasOwn(e.details, 'expiresAt')) {
      if (e.details.expiresAt === null) return ['removed the expiration of ', artifact];
      if (!Number.isNaN(new Date(e.details.expiresAt).getTime())) return ['set the expiration of ', artifact, ' to ', dateTimeText(e.details.expiresAt)];
    }
    return ['changed the expiration of ', artifact, ' (deadline not recorded)'];
  }
  const verbs = {
    publish: ['published ', artifact], delete: ['deleted ', artifact], expired: ['expired ', artifact, ' and permanently deleted its private content and history'],
    'rotate-comment-link': ['rotated the comment link for ', artifact],
    invite: ['invited ', target || 'someone'], invite_withdrawn: ['withdrew the invitation to ', target || 'someone'], archive: ['archived ', artifact], restore: ['restored ', artifact], rename: ['renamed ', artifact],
    transfer: ['transferred ', artifact], sharing_change: ['changed who can open ', artifact], expiration: ['changed the expiration of ', artifact], sign_in: ['signed in'],
    account_disabled: ['suspended ', target || 'an account'], account_active: ['reactivated ', target || 'an account'],
    credential_create: ['created an API credential'], credential_revoke: ['revoked an API credential'],
  };
  return verbs[e.action] || [String(e.action || '').replaceAll('_', ' ')];
}
function dayLabel(value) {
  const d = new Date(value), today = new Date();
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  const days = Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function renderActivity() {
  const events = activityEvents;
  const filter = node('div', { className: 'event-filter', role: 'group', ariaLabel: 'Show' }, ...Object.entries(KIND_LABELS).map(([kind, label]) => {
    const b = button(label, () => { if (state.kind === kind) return; state.kind = kind; resetPagination(); writeUrl(); loadPage(); });
    b.setAttribute('aria-pressed', String(state.kind === kind));
    return b;
  }));
  const noun = state.kind === 'all' ? 'event' : `${KIND_LABELS[state.kind].toLowerCase().replace(/s$/, '')} event`;
  $('pagination').hidden = !nextCursor;
  $('more').hidden = !nextCursor;
  $('more').textContent = 'Show older events';
  $('shown').textContent = `${events.length} ${noun}${events.length === 1 ? '' : 's'} shown`;
  if (!events.length) {
    $('result-status').textContent = 'No events';
    const searching = state.q || state.kind !== 'all';
    return $('content').replaceChildren(filter, empty(searching ? 'No matching activity' : 'No activity yet', searching ? 'Try a different person or artifact, change the event kind, or clear your filters.' : 'Artifact changes, invitations, account changes and sign-ins will appear here.'));
  }
  const shown = events;
  const out = [filter];
  let day = '', list = null;
  for (const e of shown) {
    const label = dayLabel(e.createdAt);
    if (label !== day) {
      day = label;
      out.push(node('h2', { className: 'day-head', textContent: label }));
      list = node('div', { className: 'record-list', role: 'list' });
      out.push(list);
    }
    const kind = EVENT_KIND[e.action] || 'artifacts';
    const entry = node('div', { className: `event${kind === 'sign-ins' ? ' quiet' : ''}`, role: 'listitem' },
      node('span', { className: 'ico', ariaHidden: 'true', textContent: EVENT_GLYPH[e.action] || EVENT_GLYPH[kind] }),
      node('span', {}, node('strong', { textContent: e.actorName || (e.action === 'expired' ? 'System' : 'Account') }), ' ', ...eventSentence(e)),
      node('time', { dateTime: e.createdAt, textContent: relativeDate(e.createdAt), title: new Date(e.createdAt).toLocaleString() }));
    entry.dataset.action = e.action;
    list.append(entry);
  }
  $('content').replaceChildren(...out);
  $('result-status').textContent = `${events.length}${nextCursor ? '+' : ''} ${noun}${events.length === 1 && !nextCursor ? '' : 's'} · newest first`;
}
function cliSetupGuide() {
  const commands = [
    'git clone https://github.com/danmestas/html-artifact-publisher.git',
    'cd html-artifact-publisher',
    `export HTML_PUBLISHER_URL=${JSON.stringify(location.origin)}`,
    'export HTML_PUBLISHER_TOKEN="<your-personal-credential>"',
    'node scripts/publish-html.mjs --title "My artifact" page.html',
  ].join('\n');
  const copy = button('Copy setup example', async () => {
    try { await navigator.clipboard.writeText(commands); notify('Setup example copied. Replace the credential placeholder locally.'); }
    catch { notify('Clipboard unavailable. Select and copy the setup example.'); }
  });
  return node('section', { className: 'cli-guide' },
    node('h2', { textContent: 'Publish from your terminal' }),
    node('p', { className: 'muted', textContent: 'Use Node.js 22 or newer. Replace the placeholder with your personal credential and page.html with your file. Publishing does not require Go or TinyGo.' }),
    node('pre', {}, node('code', { textContent: commands })), copy,
    node('p', {}, node('a', { href: 'https://github.com/danmestas/html-artifact-publisher#cli-usage', target: '_blank', rel: 'noopener noreferrer', textContent: 'Full CLI instructions' })));
}
function renderCredentials(credentials) {
  if (!credentials.length) return $('content').replaceChildren(empty('Publish as yourself', 'Create a named API credential for your CLI. The secret is displayed only once.'), cliSetupGuide());
  const list = node('div', { className: 'record-list' });
  for (const c of credentials) list.append(node('div', { className: 'record' },
    node('div', { className: 'identity' }, node('strong', { textContent: c.name }), node('small', { textContent: `Created ${dateText(c.createdAt)}` })),
    button('Revoke', () => confirmAction('Revoke credential?', `Any CLI using “${c.name}” will lose access immediately. This cannot be undone.`, 'Revoke credential', async () => {
      await api(`/api/credentials/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      notify('Credential revoked.');
    }, true))));
  $('content').replaceChildren(list, cliSetupGuide());
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
function finishDialogClose() {
  // Native close events are queued. Never clear a reopened dialog or clean twice.
  if ($('dialog').open || dialogFocus === null) return;
  ++dialogSequence;
  $('dialog-body').replaceChildren(); // Includes any one-time credential.
  message('dialog-error');
  const focus = dialogFocus;
  dialogFocus = null;
  if (focus.isConnected) focus.focus();
  else $('main').focus();
}
function closeDialog() {
  $('dialog').close();
  finishDialogClose(); // Explicit closes remove secrets synchronously.
}
$('dialog-close').addEventListener('click', closeDialog);
$('dialog').addEventListener('close', finishDialogClose);
async function dialogTask(action, { close = true, reload = true } = {}) {
  const seq = dialogSequence, epoch = accountEpoch;
  const controls = [...$('dialog-body').querySelectorAll('button,input,select')];
  const states = controls.map(c => c.disabled);
  controls.forEach(c => { c.disabled = true; });
  $('dialog-close').disabled = true;
  message('dialog-error');
  try {
    await action();
    if (epoch !== accountEpoch) return;
    if (seq === dialogSequence && close) closeDialog();
    if (reload && user) { await loadPage(); loadRecent(true); }
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
  const cancel = button('Cancel', () => closeDialog());
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
    ['Owner', mine(item) ? 'You' : item.ownerName || 'Instance owner'], ['Visibility', item.visibility === 'shared' ? 'Shared' : 'Private'],
    // Your own access is only news when the artifact is someone else's.
    ...(item.canManage ? [] : [['Access', item.permission === 'write' ? 'Can edit' : 'Can view']]), ['Status', item.archived ? 'Archived' : 'Active'],
    ['Updated', dateText(item.updatedAt)], ['Created', dateText(item.createdAt)],
    ['Expires', item.expiresAt ? dateTimeText(item.expiresAt) : 'Does not expire'],
  ]) details.append(node('dt', { textContent: label }), node('dd', { textContent: value }));
  const actions = node('div', { className: 'manage-actions' },
    node('a', { className: 'button-link', href: viewerUrl(item), textContent: 'Open artifact and history' }),
    button(item.starred ? 'Unstar artifact' : 'Star artifact', () => dialogTask(async () => {
      await api(`/api/artifacts/${encodeURIComponent(item.id)}/star`, { method: 'PUT', body: { starred: !item.starred } });
      notify(item.starred ? 'Artifact unstarred.' : 'Artifact starred.');
    })));
  if (item.canManage) {
    actions.append(button('Manage access', () => openSharing(item)), button('Rename', () => openRename(item)),
      button('Expiration', () => openExpiration(item)),
      button(item.archived ? 'Restore to library' : 'Archive artifact', () => confirmAction(item.archived ? 'Restore artifact?' : 'Archive artifact?',
        item.archived ? 'This artifact will return to the library. Its existing sharing stays the same.' : 'This hides the artifact from the default library. Existing links and named access will still work. You can restore it from Archived; the instance owner can also restore it from Every artifact.',
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
function openExpiration(item) {
  const form = node('form');
  const mode = node('select', { id: 'expiration-mode' },
    node('option', { value: 'date', textContent: 'Expire on a date' }), node('option', { value: 'never', textContent: 'Never expires' }));
  const date = node('input', { id: 'expiration-date', type: 'datetime-local', step: '1', required: true });
  if (item.expiresAt) date.value = localDateTimeValue(item.expiresAt);
  mode.value = item.expiresAt ? 'date' : 'never';
  // The label belongs to the field: hiding only the input would leave it
  // orphaned above an empty gap, so the whole wrapper goes with it.
  const dateField = node('div', { id: 'expiration-date-field' },
    node('label', { htmlFor: 'expiration-date', textContent: 'Date and time' }), date);
  const showDate = (focus) => {
    const never = mode.value === 'never';
    dateField.hidden = never;
    date.disabled = never;
    if (!never && focus) date.focus();
  };
  mode.addEventListener('change', () => showDate(true));
  formField(form, 'Expiration', mode);
  showDate(false);
  form.append(dateField);
  form.append(node('p', { className: 'explain', id: 'expiration-zone', textContent: `Times use this browser's time zone (${timeZoneName()}); the artifact expires at that instant everywhere. Expiration removes the artifact and its history from the library and stops its links. It does not unpublish independent public copies.` }));
  const current = item.expiresAt ? `Currently expires ${dateTimeText(item.expiresAt)}.` : 'This artifact does not expire.';
  form.append(node('p', { className: 'muted', textContent: current }));
  submit(form, 'Save expiration', async () => {
    let expiresAt;
    if (mode.value === 'never') expiresAt = null;
    else {
      if (!date.value) throw new Error('Choose a date and time, or choose Never expires.');
      const chosen = new Date(date.value);
      if (Number.isNaN(chosen.getTime())) throw new Error('Choose a valid date and time.');
      if (chosen.getTime() <= Date.now()) throw new Error('Choose a time in the future. Past dates would expire the artifact at once.');
      expiresAt = chosen.toISOString();
    }
    const result = await api(`/api/artifacts/${encodeURIComponent(item.id)}/manage`, { method: 'PATCH', body: { expiresAt } });
    // A 202 means the deadline is stored but the library has not caught up yet:
    // saying it was saved would claim more than the server confirmed.
    if (result?.expirationPending) notify('Expiration update accepted. The library is still updating; refresh shortly.');
    else notify(expiresAt ? 'Expiration saved.' : 'Expiration cleared. This artifact will not expire.');
  });
  openDialog('Expiration', form);
  if (mode.value === 'date') { date.focus(); date.select?.(); } else mode.focus();
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
      body.append(form, node('p', { className: 'explain', textContent: 'Only active members are listed. Someone who is invited but has not signed in, or is suspended, cannot be added yet.' }));
    } else body.append(node('p', { className: 'explain', textContent: 'No other active members are available to add. Invited people appear here once they sign in; the instance owner can invite more.' }));
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
    form.append(node('p', { className: 'explain', textContent: 'Only active members can take ownership. Invited and suspended accounts are not listed.' }));
    submit(form, 'Transfer ownership', async () => {
      await api(`/api/artifacts/${encodeURIComponent(item.id)}/manage`, { method: 'PATCH', body: { ownerId: target.value } });
      notify('Ownership transferred. Named sharing cleared.');
    });
    $('dialog-body').replaceChildren(form);
  } catch (err) { if (seq === dialogSequence) message('dialog-error', err.message); }
}
function openDelete(item) {
  const form = node('form');
  form.append(node('p', { textContent: `Permanently delete “${item.title}” and its entire history? Private source links will stop working. Independent public copies remain published; unpublish them from Published links. This cannot be undone.` }));
  const input = formField(form, 'Type DELETE to confirm', node('input', { id: 'delete-confirm', required: true, autocomplete: 'off', pattern: 'DELETE' }));
  const cancel = button('Cancel', () => closeDialog());
  const confirm = submit(form, 'Permanently delete artifact', async () => {
    if (input.value !== 'DELETE') throw new Error('Type DELETE to confirm.');
    await api(`/api/artifacts/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    notify('Artifact deleted.');
  }, true);
  confirm.classList.remove('full');
  form.append(node('div', { className: 'actions' }, cancel, confirm));
  openDialog('Delete artifact', form);
  cancel.focus();
}
function openSuspend(person) {
  const suspended = person.status === 'disabled';
  confirmAction(suspended ? 'Reactivate account?' : 'Suspend account?', suspended
    ? `${person.email} can sign in again. Previously revoked API credentials remain revoked.`
    : `${person.email} will be signed out everywhere and all their API credentials revoked. Their artifacts will remain in the instance. Previously issued artifact capability links still work; suspension does not revoke those links.`,
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
// A page's files: index.html, or a lone top-level HTML file renamed to it.
function withEntry(files) {
  if ('index.html' in files) return files;
  const pages = Object.keys(files).filter(p => /\.html?$/i.test(p) && !p.includes('/'));
  if (pages.length !== 1) throw new Error(pages.length ? 'Several HTML files were chosen: name the page index.html.' : 'Choose an HTML page (.html), with any files it uses.');
  const { [pages[0]]: page, ...rest } = files;
  return { 'index.html': page, ...rest };
}
function openUpload() {
  const form = node('form');
  form.append(node('p', { className: 'muted', textContent: 'Choose an HTML page, or the page with the files it uses: images, styles, scripts, fonts, video, and data such as .wasm modules or SQLite databases. The page must be index.html or the only HTML file. It will be private to you and the instance owner, with no expiration.' }));
  const files = formField(form, 'Files', node('input', { id: 'upload-files', type: 'file', multiple: true }));
  const folder = formField(form, 'Or a whole folder', node('input', { id: 'upload-folder', type: 'file' }));
  folder.webkitdirectory = true;
  const chosen = node('p', { className: 'tiny', role: 'status' });
  form.append(chosen);
  const title = formField(form, 'Artifact title', node('input', { id: 'upload-title', required: true, maxLength: 200 }));
  let selection = [];
  for (const [input, other] of [[files, folder], [folder, files]]) input.addEventListener('change', () => {
    other.value = '';
    selection = [...input.files];
    const size = selection.reduce((n, f) => n + f.size, 0);
    chosen.textContent = selection.length ? `${selection.length} file${selection.length === 1 ? '' : 's'}, ${size < 1048576 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`}` : '';
    const first = selection[0];
    if (!title.value && first) title.value = (first.webkitRelativePath ? first.webkitRelativePath.split('/')[0] : first.name.replace(/\.[^.]*$/, '')).slice(0, 200);
  });
  submit(form, 'Publish artifact', async () => {
    if (!selection.length) throw new Error('Choose the files to publish.');
    const trimmed = title.value.trim();
    if (!trimmed) throw new Error('Enter an artifact title.');
    const picked = withEntry(await readFileList(selection));
    if (!picked['index.html'].length) throw new Error('The HTML page is empty.');
    // Images, data and large files go to storage first; the rest travels as
    // base64 in one JSON request, which must fit the server's 10 MB body cap.
    const inline = Object.entries(picked).reduce((n, [path, bytes]) => n + (isBlob(path, bytes) ? 0 : bytes.length), 0);
    if (inline > 7 * 1024 * 1024) throw new Error('The HTML, CSS and other text files must be no larger than 7 MB together.');
    const stored = await withBlobs(picked, '/api/blobs', '', path => { chosen.textContent = `Uploading ${path}…`; });
    chosen.textContent = 'Publishing…';
    await api('/api/artifacts', { method: 'POST', body: { title: trimmed, ttlSeconds: null, files: encodeFiles(stored) } });
    state.view = 'mine'; state.q = ''; resetPagination(); writeUrl();
    notify('Artifact published. Find it in Created by me.');
  });
  openDialog('Publish artifact', form);
  files.focus();
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
      const epoch = accountEpoch, seq = dialogSequence;
      const data = await api('/api/credentials', { method: 'POST', body: { name: name.value.trim() } });
      if (epoch !== accountEpoch || seq !== dialogSequence) return;
      // Never persist the secret, put it in a URL, or send it into an artifact.
      const secret = node('div', { className: 'secret', textContent: data.token, tabIndex: 0, ariaLabel: 'New API credential' });
      const copy = button('Copy credential', async () => {
        try { await navigator.clipboard.writeText(data.token); copy.textContent = 'Copied'; }
        catch { message('dialog-error', 'Clipboard unavailable. Select and copy the credential above.'); }
      });
      openDialog('Save your credential now', node('p', { className: 'notice', textContent: 'This is the only time this credential will be shown. Save it in your secret manager before closing.' }),
        secret, node('div', { className: 'actions' }, copy, button('I’ve saved it', () => closeDialog())),
        node('p', { className: 'explain', textContent: 'Never include your credential in HTML, URLs, screenshots, or shared files.' }), cliSetupGuide());
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
    adoptAccount(user);
    if (!user) { rememberLoginReturn(); return showLogin(); }
    if (location.pathname === '/login') history.replaceState(null, '', '/');
    await showApp();
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('boot').hidden = true;
    showLogin();
    message('login-feedback', 'Could not check whether you are signed in. Reload the page to try again.', 'error');
  }
}
main();
