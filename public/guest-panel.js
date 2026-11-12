// Guest participation belongs to the first-party viewer, never the sandboxed page.
// Keep private profiles out of browser storage and discard owner data on account changes.
export function guestPanel({ artifact, info, account, current, manage, path, refresh }) {
  const $ = id => document.getElementById(id);
  let profile = null;
  let busy = false;
  let request = 0;
  let cursor = '';
  let profileRevision = 0;
  let visibleLoads = 0;
  $('guestProfileForm').addEventListener('input', () => { profileRevision++; });
  const text = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  };
  const button = (label, action) => {
    const node = text('button', label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await action(); }
      catch (error) {
        request++;
        cursor = '';
        $('guestList').replaceChildren();
        $('moreGuests').hidden = true;
        $('guestManagementStatus').textContent = error.message;
      }
      finally { node.disabled = false; }
    });
    return node;
  };
  function render() {
    const state = info();
    $('guestProfile').hidden = !state?.guestDiscussion || state.role !== 'read';
    $('guestManagement').hidden = !state?.guestDiscussion || !state.canManage;
    $('claimGuest').disabled = !profile || busy;
  }
  function resetManagement() {
    request++;
    cursor = '';
    $('guestManagement').hidden = true;
    $('guestList').replaceChildren();
    $('guestManagementStatus').textContent = '';
    $('moreGuests').hidden = true;
  }
  async function loadProfile() {
    render();
    if ($('guestProfile').hidden) return;
    const revision = profileRevision;
    try {
      const result = await artifact().guest();
      if (revision !== profileRevision) return;
      profile = result.guest;
      $('guestName').value = profile?.name === 'Guest' ? '' : profile?.name || '';
      $('guestEmail').value = profile?.email || '';
      $('guestProfileStatus').textContent = profile?.claimedAccountId
        ? 'Identity linked. The owner must approve named access separately.' : '';
      render();
    } catch (error) { $('guestProfileStatus').textContent = `Could not load identity: ${error.message}`; }
  }
  async function ensureProfile() {
    if (info()?.role !== 'read' || !info()?.guestDiscussion) return;
    if (!$('guestProfileForm').reportValidity()) throw new Error('Correct your comment identity above before posting.');
    const name = $('guestName').value.trim();
    const email = $('guestEmail').value.trim().toLowerCase();
    // Revalidate the browser identity, so an expired/cleared cookie cannot silently
    // attach a comment to a cached profile or grant authority from a stale UI.
    const live = await artifact().guest();
    if (!live.canComment) throw new Error('Commenting is unavailable for this identity or link.');
    if (!live.guest || (live.guest.name !== (name || 'Guest')) || live.guest.email !== email) {
      profile = (await artifact().identifyGuest({ name, email })).guest;
    } else profile = live.guest;
    render();
  }
  $('guestProfileForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    $('saveGuestProfile').disabled = true;
    $('guestProfileStatus').textContent = 'Saving…';
    try { await ensureProfile(); $('guestProfileStatus').textContent = 'Comment identity saved. Your email is not shown in threads.'; }
    catch (error) { $('guestProfileStatus').textContent = `Could not save: ${error.message}`; }
    finally { busy = false; $('saveGuestProfile').disabled = false; render(); }
  });
  $('claimGuest').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      if (!(await account())) throw new Error('Sign in with your invited account, then return in this browser.');
      await ensureProfile();
      await artifact().claimGuest();
      await loadProfile();
      $('guestProfileStatus').textContent = 'Identity linked. Ask the owner to approve named access.';
    } catch (error) { $('guestProfileStatus').textContent = error.message; }
    finally { busy = false; render(); }
  });
  async function loadGuests(append = false, { revalidateOnly = false } = {}) {
    const owner = await account();
    if (!owner || !info()?.canManage) { resetManagement(); return; }
    // Background checks must not supersede a visible refresh or Load more.
    if (revalidateOnly && visibleLoads) return;
    if (!revalidateOnly) visibleLoads++;
    const sequence = ++request;
    if (!revalidateOnly) $('guestManagementStatus').textContent = 'Loading participants…';
    try {
      const query = revalidateOnly ? '?limit=1' : append && cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const result = await manage(path(`guests${query}`));
      // A delayed result must never expose the former owner's private participant data.
      const stillOwner = await current(owner);
      if (sequence !== request) return;
      if (!stillOwner) { resetManagement(); return; }
      if (revalidateOnly) return; // Keep the person's current pagination and scroll position.
      if (!append) $('guestList').replaceChildren();
      for (const guest of result.guests) {
        const row = document.createElement('article');
        row.className = 'guest-participant';
        row.append(text('strong', `${guest.name || 'Guest'} · unverified`),
          text('p', guest.email ? `Private email (unverified): ${guest.email}` : 'No email supplied.'));
        if (guest.claimedAccountId) {
          row.append(text('p', `Linked verified account: ${guest.claimedAccountName || guest.claimedAccountId}${guest.claimedAccountEmail ? ` (${guest.claimedAccountEmail})` : ''}.`));
          const permission = document.createElement('select');
          permission.setAttribute('aria-label', `Named access for ${guest.name || 'Guest'}`);
          for (const [value, label] of [['read', 'Can view'], ['write', 'Can edit']]) {
            const option = text('option', label); option.value = value; permission.append(option);
          }
          permission.value = guest.permission === 'write' ? 'write' : 'read';
          row.append(permission, button('Approve named access', async () => {
            await manage(path(`guests/${encodeURIComponent(guest.id)}/upgrade`), { method: 'POST', body: { permission: permission.value } });
            await refresh();
            await loadGuests();
            $('guestManagementStatus').textContent = 'Named access granted to the verified account. The shared link is unchanged.';
          }));
        } else {
          row.append(text('p', 'Not linked to an account. Invite this person from People & invitations; they must sign in and link their guest identity before approval.'));
        }
        row.append(button(guest.blocked ? 'Allow guest comments' : 'Block guest comments', async () => {
          await manage(path(`guests/${encodeURIComponent(guest.id)}`), { method: 'PATCH', body: { blocked: !guest.blocked } });
          await loadGuests();
        }));
        $('guestList').append(row);
      }
      cursor = result.nextCursor || '';
      $('moreGuests').hidden = !cursor;
      $('guestManagementStatus').textContent = $('guestList').childElementCount ? '' : 'No guest participants yet.';
    } catch (error) {
      const stillOwner = await current(owner);
      if (sequence !== request) return;
      // A denied refresh may mean ownership changed without an account change.
      // Never retain private rows on any failed refresh, including pagination.
      cursor = '';
      $('guestList').replaceChildren();
      $('moreGuests').hidden = true;
      if (stillOwner) $('guestManagementStatus').textContent = `Could not load participants: ${error.message}`;
    } finally {
      if (!revalidateOnly) visibleLoads--;
    }
  }
  $('refreshGuests').addEventListener('click', () => loadGuests());
  $('moreGuests').addEventListener('click', () => loadGuests(true));
  return { render, loadProfile, ensureProfile, loadGuests, resetManagement };
}
