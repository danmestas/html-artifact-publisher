// Agent setup page: the copyable install prompt, derived from this instance's
// origin, and clipboard helpers. No identity or credentials are ever stored.
const REPO = 'https://github.com/danmestas/html-artifact-publisher';
const ZIP = `${REPO}/archive/refs/heads/main.zip`;

export { REPO, ZIP };

export const SKILLS = ['publish-html-page', 'artifact-design', 'artifact-runtime', 'artifact-diagrams', 'artifact-dataviz', 'pikchr'];
export const REPO_GIT = `${REPO}.git`;

// Resolves the retained checkout from an installed publish-html-page skill.
// A symlinked skill resolves to <checkout>/skills/publish-html-page and the
// suffix is stripped; anything else (a copied skill, a different layout) is not
// guessed from — an explicit HTML_PUBLISHER_CHECKOUT must supply the checkout.
// The candidate must hold the CLI, public/ assets and the skill itself.
export const CHECKOUT_RESOLVER = `set -e
install_dir="$HOME/.claude/skills/publish-html-page"
resolved="$(readlink -f "$install_dir" 2>/dev/null || true)"
candidate=""
case "$resolved" in
  */skills/publish-html-page) candidate="\${resolved%/skills/publish-html-page}" ;;
esac
valid_checkout() {
  [ -n "$1" ] && [ -f "$1/scripts/publish-html.mjs" ] && [ -d "$1/public" ] && [ -d "$1/skills/publish-html-page" ]
}
CHECKOUT=""
if valid_checkout "$candidate"; then CHECKOUT="$candidate"; fi
if [ -z "$CHECKOUT" ] && valid_checkout "\${HTML_PUBLISHER_CHECKOUT:-}"; then CHECKOUT="$HTML_PUBLISHER_CHECKOUT"; fi
if [ -z "$CHECKOUT" ]; then
  echo "Cannot determine the html-artifact-publisher checkout." >&2
  echo "Install the skill as a symlink to the retained checkout, or set HTML_PUBLISHER_CHECKOUT to it." >&2
  echo "A copied skill does not contain scripts/ or public/ and cannot infer the checkout." >&2
  exit 1
fi
echo "$CHECKOUT"`;

// Copyable and safe to run as-is, including on a rerun: clones only when the
// expected destination is absent. An existing destination is reused only when
// it is a git checkout of this repository (origin matches) and still holds the
// CLI, public/ assets and required skills; an unrelated, empty or altered
// directory is refused without being touched. Each skill is linked without
// forcing, so existing files, directories and dangling symlinks survive.
export function installCommands() {
  return `set -e
checkout="$HOME/tools/html-artifact-publisher"
expected_origin="${REPO_GIT}"
if [ -e "$checkout" ] || [ -L "$checkout" ]; then
  if [ ! -d "$checkout/.git" ]; then
    echo "Error: $checkout exists but is not a git checkout. Move it aside and rerun; nothing was changed." >&2
    exit 1
  fi
  origin="$(git -C "$checkout" remote get-url origin 2>/dev/null || true)"
  if [ "$origin" != "$expected_origin" ]; then
    echo "Error: $checkout is a git checkout of \${origin:-<no origin>}, not $expected_origin. Move it aside and rerun; nothing was changed." >&2
    exit 1
  fi
  for required in scripts/publish-html.mjs public skills/publish-html-page; do
    if [ ! -e "$checkout/$required" ]; then
      echo "Error: $checkout is missing $required; it is not a usable checkout. Move it aside and rerun; nothing was changed." >&2
      exit 1
    fi
  done
  echo "Using existing checkout at $checkout."
else
  git clone "$expected_origin" "$checkout"
fi
mkdir -p "$HOME/.claude/skills"
for skill in ${SKILLS.join(' ')}; do
  target="$HOME/.claude/skills/$skill"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Skipped $skill: $target already exists; left unchanged."
    continue
  fi
  ln -s "$checkout/skills/$skill" "$target"
  echo "Linked $skill -> $checkout/skills/$skill"
done`;
}

// Real, quoted shell values so the example parses and runs; the token is a
// placeholder the person replaces locally, never a real secret.
export function envExample(origin) {
  return `export HTML_PUBLISHER_URL="${origin}"
export HTML_PUBLISHER_TOKEN="replace-with-your-personal-credential"`;
}

export function installPrompt(origin) {
  return `Set up this instance's HTML publishing tools for me. Explain what you will change, and wait for my confirmation before installing anything.

1. Read the instructions at ${origin}/llms.txt. Before executing anything from the repository below, inspect the instructions and scripts there first.
2. Clone ${REPO} (or download ${ZIP} and extract it) into a dedicated local tools directory such as ~/tools/html-artifact-publisher — not an arbitrary workspace root, and not inside a project you are working on.
3. Install the skills you need from the repository's skills/ folder into your agent's skill directory: ~/.claude/skills for Claude Code, or the equivalent directory for your agent. Create that directory if needed. Prefer a per-skill symlink to the retained checkout (so updates flow through) over copying. Keep any existing installation and preserve unrelated skills, directories and symlinks. Do not overwrite or replace anything already there without asking me first; list what you skipped.
   Skills: publish-html-page (required), artifact-design, artifact-runtime, artifact-diagrams, artifact-dataviz, pikchr. self-host-publisher is optional; load it only when setting up a new instance.
4. Keep that checkout in place. Installed skills run from the checkout: scripts/ (publish-html.mjs, pikchr.mjs) and public/ assets resolve relative to the repository, not to the skill's own folder. For a SYMLINKED skill, resolve it with readlink -f and strip the /skills/publish-html-page suffix, then verify the candidate holds scripts/publish-html.mjs, public/ and skills/publish-html-page before using it. For a COPIED skill, do not infer anything: ask me for the retained checkout path and use that explicitly. If neither yields a valid checkout, stop and tell me rather than guessing. Invoke the CLI by absolute path — node <checkout>/scripts/publish-html.mjs <absolute-file.html> — or cd <checkout> first and pass absolute artifact inputs. Teach me that location and exact command, and run node <checkout>/scripts/publish-html.mjs --help once to confirm it starts.
5. Use Node.js 22 or newer (CI uses 24). Publishing with the CLI does not need Go, TinyGo, Wrangler, or a server deployment.
6. Set HTML_PUBLISHER_URL=${origin} and HTML_PUBLISHER_TOKEN from an existing personal API credential, loaded from a safe environment variable or secret manager. Never put the token in a URL, page content, localStorage, or your output, and never print it back to me.
7. If no personal credential exists yet, do not inspect the browser's cookies or reuse an existing session. Send me to ${origin}/?view=credentials to create a named credential, then read it from my environment or secret manager.

Never pipe a downloaded script into a shell to install it, and do not run the install until I say so.`;
}

export async function copyText(text, clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try { await clipboard.writeText(text); return true; } catch { return false; }
}

export function selectTarget(element) {
  if (!element || typeof element.focus !== 'function') return false;
  element.focus();
  if (typeof element.select === 'function') { element.select(); return true; }
  // A <pre> has no select(). Select its contents with a Range so the person can
  // copy with the keyboard after a denied clipboard write.
  try {
    const selection = element.ownerDocument?.defaultView?.getSelection?.();
    if (!selection) return false;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch { return false; }
}

// The page itself: fill the prompt from this origin and wire the copy buttons.
// Tests import the helpers above without a document, so none of this may run there.
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const prompt = document.getElementById('install-prompt');
    if (prompt) prompt.value = installPrompt(location.origin);
    const commands = document.getElementById('clone-commands');
    if (commands) commands.textContent = installCommands();
    const environment = document.getElementById('env-example');
    if (environment) environment.textContent = envExample(location.origin);
    const resolver = document.getElementById('checkout-resolver');
    if (resolver) resolver.textContent = CHECKOUT_RESOLVER;

    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const source = document.getElementById(button.dataset.copy);
        if (!source) return;
        const status = button.closest('.setup-actions')?.querySelector('[role="status"]');
        const text = 'value' in source ? source.value : source.textContent;
        if (await copyText(text)) {
          if (status) status.textContent = 'Copied to your clipboard.';
          return;
        }
        // Select the source itself so the person can copy it with the keyboard.
        if (selectTarget(source)) {
          if (status) status.textContent = 'Clipboard unavailable. The text is selected; copy it with your keyboard.';
        } else if (status) {
          status.textContent = 'Clipboard unavailable. Select the text above and copy it with your keyboard.';
        }
      });
    }
  });
}
