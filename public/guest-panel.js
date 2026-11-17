// Guest participation belongs to the first-party viewer, never the sandboxed page.
// Keep private profiles out of browser storage and discard owner data on account changes.
export function guestPanel({ artifact, info, account, current, manage, path, refresh, onIdentity, onSaved, onChoice, openIdentity }) {
  const $ = id => document.getElementById(id);
  let profile = null;
  // Which identity a new comment would carry: the reader's own deliberate
  // choice, never implied by signing in. `guest` is the default for a
  // capability link; the viewer may choose `account` for a signed-in reader.
  let identityChoice = 'guest';
  let identityInitialized = false;
  let viewer = null; // the server's private view of who is asking: {key,label,verified,canUseAccount}
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
  /** The line above the discussions: who a comment will be from, and how to change it. */
  function identitySummary() {
    // Say what a comment would actually carry. The server's view of the chosen
    // requester wins once it has answered; the local profile fills in first.
    if (viewer && typeof viewer.label === 'string' && viewer.label) {
      return { label: viewer.label, verified: viewer.verified === true };
    }
    if (identityChoice === 'account') {
      return viewer?.canUseAccount?.name
        ? { label: viewer.canUseAccount.name, verified: true }
        : { label: 'account identity pending', verified: false };
    }
    const name = profile?.name && profile.name !== 'Guest' ? profile.name : '';
    return { label: name || 'Guest', verified: false };
  }
  function setIdentityOpen(open) {
    const panel = $('guestProfile');
    if (!panel) return;
    panel.hidden = !open;
    $('identityChange').setAttribute('aria-expanded', String(open));
    if (open) $('guestName').focus({ preventScroll: true });
  }
  function render() {
    const state = info();
    const discuss = !!state?.guestDiscussion;
    // The form is a deliberate disclosure the reader opens; it closes itself
    // when the identity controls no longer apply. Every role that can discuss
    // may carry a guest identity, not just a read link: a comment/edit-link
    // holder who identifies gets owned messages too.
    if (!discuss || !(state.canComment ?? true)) $('guestProfile').hidden = true;
    $('guestManagement').hidden = !state?.guestDiscussion || !state.canManage;
    $('claimGuest').disabled = !profile || busy;
    const line = $('identityLine');
    if (line) {
      line.hidden = !discuss || !(state.canComment ?? true);
      const summary = identitySummary();
      $('identityText').textContent = `Commenting as ${summary.label} · ${summary.verified ? 'verified account' : 'unverified guest'}`;
      // A signed-in reader may deliberately comment under either identity.
      const canUseAccount = !!(viewer?.canUseAccount || state.canManage);
      $('useAccountIdentity').hidden = !discuss || !canUseAccount || identityChoice === 'account';
      $('useGuestIdentity').hidden = !discuss || identityChoice === 'guest';
      $('identityAccountNote').hidden = !canUseAccount || identityChoice !== 'account';
      $('identityAccountNote').textContent = 'Your signed-in account will be shown. Your permission to read and comment does not change.';
    }
    // The compact line in the composing bubble describes the same identity.
    if ($('bubbleIdentity')) $('bubbleIdentity').textContent = `Commenting as ${identitySummary().label} · ${identitySummary().verified ? 'verified' : 'unverified'}`;
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
    if (!identityInitialized) {
      // Account-only URLs already use verified account access. Capability URLs
      // remain guests unless the reader deliberately chooses their account.
      identityChoice = artifact()?.auth ? 'guest' : 'account';
      identityInitialized = true;
    }
    render();
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
  /**
   * Ensure the browser's guest identity exists and matches the name fields,
   * for any role that can discuss. Only the guest choice needs this: an
   * account-selected post carries no guest cookie. Not a permission check and
   * never grants access; the server still decides what a comment may be.
   */
  async function ensureProfile() {
    if (!info()?.guestDiscussion || identityChoice !== 'guest') return;
    if (!$('guestProfileForm').checkValidity()) {
      openIdentity?.();
      setIdentityOpen(true);
      $('guestProfileForm').reportValidity();
      throw new Error('Correct your comment identity before posting.');
    }
    const revision = profileRevision;
    const name = $('guestName').value.trim();
    const email = $('guestEmail').value.trim().toLowerCase();
    // Revalidate the browser identity, so an expired/cleared cookie cannot silently
    // attach a comment to a cached profile or grant authority from a stale UI.
    const live = await artifact().guest();
    if (revision !== profileRevision) throw new Error('Comment identity changed. Review your details and try again.');
    if (!live.canComment) throw new Error('Commenting is unavailable for this identity or link.');
    if (!live.guest || (live.guest.name !== (name || 'Guest')) || live.guest.email !== email) {
      const saved = (await artifact().identifyGuest({ name, email })).guest;
      if (revision !== profileRevision) throw new Error('Comment identity changed. Review your details and try again.');
      profile = saved;
    } else profile = live.guest;
    $('guestProfileStatus').textContent = 'Comment identity saved. Your email is not shown in threads.';
    render();
  }
  $('identityChange').addEventListener('click', () => {
    setIdentityOpen($('guestProfile').hidden);
    render();
  });
  $('identityDone').addEventListener('click', () => {
    if (!$('guestProfileForm').reportValidity()) return;
    setIdentityOpen(false);
    $('identityChange').focus({ preventScroll: true });
    render();
  });
  $('bubbleIdentityChange').addEventListener('click', () => {
    openIdentity?.();
    setIdentityOpen(true);
    // Reviewing identity is a deliberate pause; the bubble keeps its text.
    $('guestProfile').scrollIntoView({ block: 'nearest' });
  });
  $('useAccountIdentity').addEventListener('click', () => {
    identityChoice = 'account';
    setIdentityOpen(false);
    render();
    // The server names a different principal for this choice; ask it again so
    // the line, the draft binding and the per-viewer flags all follow.
    onChoice?.('account');
  });
  $('useGuestIdentity').addEventListener('click', () => {
    identityChoice = 'guest';
    setIdentityOpen(false);
    render();
    onChoice?.('guest');
  });
  $('guestProfileForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    $('saveGuestProfile').disabled = true;
    $('guestProfileStatus').textContent = 'Saving…';
    try { await ensureProfile(); setIdentityOpen(false); render(); onSaved?.(); }
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
  return {
    render, loadProfile, ensureProfile, loadGuests, resetManagement,
    /** Invalidate cached requester data without recursively firing onIdentity. */
    resetViewer({ keepProfile = false } = {}) {
      viewer = null;
      profileRevision++;
      if (!keepProfile) {
        profile = null;
        $('guestName').value = '';
        $('guestEmail').value = '';
        $('guestProfileStatus').textContent = '';
      }
      setIdentityOpen(false);
      render();
    },
    /** The server's private view of this requester, from GET …/tickets. */
    setViewer(next) {
      if (!next || typeof next !== 'object') return;
      const previous = viewer?.key ?? null;
      viewer = { key: typeof next.key === 'string' ? next.key : null, label: typeof next.label === 'string' ? next.label : '', verified: next.verified === true, canUseAccount: next.canUseAccount ?? null };
      render();
      // A draft typed before the server named this reader belonged to the
      // tab, not to this identity: it is dropped, never shown to the new one.
      if (previous && previous !== viewer.key) onIdentity?.(previous, viewer.key);
    },
    /** What a new comment would carry: the reader's own choice, guest by default. */
    identity() { return identityChoice; },
    /** Whether the reader deliberately chose their signed-in account. */
    usesAccount() { return identityChoice === 'account'; },
    /** The identity drafts and view state belong to; null until the server names one. */
    identityKey() { return viewer?.key ?? null; },
    /** The identity shown to the reader right now. */
    summary: identitySummary,
    profile() { return profile; },
  };
}
