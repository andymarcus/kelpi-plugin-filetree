# File Tree for Kelpi

A colour-coded file tree sidebar for [Kelpi](https://github.com/benfriebe/kelpi), based on
[filetree-cli](https://github.com/andymarcus/filetree-cli). It shows the folder of the focused
pane and follows it as you switch panes or `cd` around.

- **Git status**: badges for changed files, dots on folders with changes inside, deleted files
  shown struck through, ignored files dimmed or hidden, and the branch in the footer.
- **Change files**: new file or folder, rename, duplicate, move by dragging, and Move to Trash,
  all with Undo. Nothing is ever overwritten or deleted permanently.
- **See what agents are doing**: files that change on disk are highlighted for a few seconds.
- **Find things**: fuzzy search by name, search inside files, hover previews, bookmarks and
  sort orders.
- **Works with Kelpi**: palette commands, a "Reveal in File Tree" pane menu item, and settings
  under Settings → Plugins.

## Install

With Kelpi running:

```sh
curl -fsSL https://raw.githubusercontent.com/andymarcus/kelpi-plugin-filetree/main/install.sh | sh
```

Then go to **Settings → Plugins → Workbench views** and set the right sidebar
(`sidebar.secondary`) or the left one (`sidebar.primary`) to **File Tree**.

Run the same command again to update. To install a particular version, set `FILETREE_VERSION`:

```sh
curl -fsSL https://raw.githubusercontent.com/andymarcus/kelpi-plugin-filetree/main/install.sh | FILETREE_VERSION=v1.0.0 sh
```

The script:
- downloads the latest release's package from GitHub
- checks it against the release's SHA-256 checksum
- validates it with `kelpi plugin validate`
- installs it with `kelpi plugin install --trust`

[Read it first](install.sh) if you prefer. Plugins run with your account's access, and
`--trust` confirms you're fine with that. The checksum catches a corrupted download, not a
tampered release.

### Without the script

Download `kelpi-plugin-filetree.kelpi-plugin` from the
[latest release](https://github.com/andymarcus/kelpi-plugin-filetree/releases/latest), then:

```sh
kelpi plugin install kelpi-plugin-filetree.kelpi-plugin --trust
```

### From source

```sh
git clone https://github.com/andymarcus/kelpi-plugin-filetree.git
kelpi plugin install ./kelpi-plugin-filetree --trust
```

To pick up edits while you work, use `kelpi plugin dev . --trust`.

### Publishing a release

1. Bump `version` in `kelpi.plugin.json`.
2. Commit and push.
3. Run `scripts/release.sh`. It runs the checks and tests, refuses a version that isn't higher than the latest release, packs the committed tree (without tests and dev scripts), tags it, and creates a GitHub release with the package and its checksum, which is where the install command looks.

## How it follows you

Kelpi only tracks a pane's directory when its shell reports it (OSC 7, which Kelpi injects
for zsh only), and agents such as Claude never report it. So for terminal panes the plugin
reads the actual directory of the pane's foreground process instead. It finds the pane's
terminal through the `KELPI_PANE_ID` variable that every process in the pane inherits.
- **At a shell prompt**: the shell's directory, in bash, zsh or fish.
- **Running Claude, vim and so on**: that program's working directory.
- **Markdown, CSV and diff panes**: the file's folder.
- **Web and plugin panes**: the tree keeps showing the last folder.

**Pin** (`p`) holds the current folder, and **Pin as Root** on any folder switches to it.

### What it reads, and how often

Kelpi doesn't tell plugins which process belongs to a pane, so the plugin works it out:

1. **Once per pane:** it finds the pane's terminal by looking for that pane's `KELPI_PANE_ID` value in process environments.
   - It only reads your own processes that have a terminal: `ps -E` without `-x` on macOS, and only processes with a terminal on Linux.
   - Only the `KELPI_PANE_ID=` value is looked at. Nothing else is kept or logged.
   - The answer is cached, so this runs again only if the cached terminal stops matching. A pane whose terminal can't be found isn't scanned again for 30 s.
   - A program in the pane can pass the marker on to terminals of its own (tmux does), so the pane's terminal is the one holding the oldest marked process: its shell.
2. **While following a terminal:** it asks which program is in the foreground on that terminal and reads its working directory.
   - On macOS this runs `ps -t <tty>` and `lsof` on one process, about 25 ms. On Linux it reads `/proc`, with no extra processes.
   - The check runs every 1.5 s after something changes, then slows down to every 6 s while the folder stays the same.
   - Switching panes or the folder changing switch it back to 1.5 s. Title and status updates from Kelpi don't trigger a lookup.
   - It stops while the sidebar is hidden or a folder is pinned.

Switching panes is picked up straight away from Kelpi's own state updates, without waiting for a check.

All of this runs locally in the plugin's backend, with your account's access, like every Kelpi plugin.

## Keys

| Key | Action |
| --- | --- |
| `↑ ↓` / `j k` | Move |
| `⇧↑ ⇧↓`, `⌘`-click, `⇧`-click | Select several |
| `⌘A` / `Esc` | Select all / clear the selection |
| `← →` / `h l` | Collapse / expand, or go to the parent |
| `⏎` | Open (folders toggle) |
| `e` | Open in your editor in a new split |
| `Space` | Preview |
| `g` | Open the file's git changes in a diff pane |
| `i` | Insert paths in the terminal (`@path` for Claude panes) |
| `c` / `⇧C` | Copy paths / relative paths |
| `r` | Reveal in Finder |
| `a` / `⇧A` | New file / new folder |
| `F2` / `m` | Rename |
| `⇧D` | Duplicate |
| `d` / `⌘⌫` | Move to Trash |
| `u` / `⌘Z` | Undo |
| `/` / `⇧F` | Search names / search inside files (`Tab` switches) |
| `s` | Next sort order |
| `.` / `⇧I` | Show or hide hidden files / git-ignored files |
| `p` | Pin / unpin folder |
| `b` / `⇧B` | Bookmark folder / bookmarks menu |
| `⇧W` | Collapse all |
| `?` | Shortcut help |

On Linux, `Ctrl` replaces `⌘` and `Delete` replaces `⌘⌫`.

Right-click for the same actions plus **Open Terminal Here** and **Open with Default App**. The
`⋯` button holds sorting and view options.

Drag a file or folder from the tree into a terminal pane to drop in its path, quoted for the
shell. Drag it onto a folder in the tree to move it there; resting on a closed folder opens it.

## Git

In a git repository the tree shows each item's status. A file's badge is its change: `M`
modified, `A` added, `R` renamed, `D` deleted, `U` untracked, `!` conflict. A folder's dot
takes the colour of the most serious change inside it. Files git still tracks but that are gone
from disk show struck through, so deletions are visible too. Ignored files are dimmed, or hidden
with `⇧I`.

The footer shows the branch, how far it is ahead of or behind its upstream, and how many files
changed. Click it to open all the changes in a Kelpi diff pane; `g` does the same for one file
or folder.

Git runs with `GIT_OPTIONAL_LOCKS=0`, so it never takes the index lock and can't make your own
git commands fail. One `git status` per repository answers every row. It reruns when files
change, when `.git` changes (commits, staging, checkouts), and every few seconds while the
repository is on screen, to catch changes in collapsed folders. In very large repositories that
check runs less often.

## Changing files

- **New file or folder** (`a`, `⇧A`) opens a name box in the selected folder. Typing
  `src/lib/util.ts` makes the folders on the way.
- **Rename** (`F2`) selects the name without its extension, as Finder does.
- **Duplicate** (`⇧D`) makes `name copy.ext`, then `name copy 2.ext`.
- **Move**: drag items onto a folder. Moving several items happens completely or not at all.
- **Move to Trash** (`d`) uses the system Trash: Finder's Put Back works on macOS, and `gio`
  is used on Linux. It asks first unless you turn that off in settings.
- **Undo** (`u`) reverses the last 30 changes, newest first: a trashed item goes back where it
  was, a rename or move goes back, and a new item moves to the Trash.

Nothing ever replaces an existing item: a name that is taken is an error you can fix in place.
When no Trash is available, Move to Trash fails rather than deleting.

## Search

`/` searches file and folder names, fuzzily. `⇧F` (or `Tab` in the search box) searches the
text inside files, with the `.*` button for regular expressions. It uses
[ripgrep](https://github.com/BurntSushi/ripgrep) when installed, which skips git-ignored files,
and falls back to `grep`. Choosing a match opens the file at that line: `+line` for terminal
editors, and `file:line` for VS Code, Cursor, Zed, Sublime Text and similar.

## Settings

Settings → Plugins → File Tree:

| Setting | Default | |
| --- | --- | --- |
| Show hidden files | on | Also `.` |
| Sort by | Name | Name, date modified, size or type. Also `s` |
| Folders first | on | |
| Always hide | `.DS_Store, Thumbs.db` | Comma-separated names or globs, such as `*.pyc` or `dist/cache` |
| Preview on hover | on | |
| Highlight changed files (seconds) | 8 | 0 turns it off |
| Show git status | on | |
| Hide git-ignored files | off | Also `⇧I` |
| Select the focused document's file | on | For Markdown, CSV and diff panes |
| Ask before moving to the Trash | on | |
| Editor command | empty | Empty uses `$VISUAL` or `$EDITOR`. Example: `code --wait` |
| Folder check interval (seconds) | 1.5 | How often a terminal's folder is checked |

## Commands

In the command palette, and for `kelpi plugin run andymarcus.filetree.<name>`: `focus`,
`search`, `search-content`, `reveal`, `new-file`, `new-folder`, `collapse-all`, `refresh`,
`toggle-hidden`, `toggle-ignored`, `toggle-pin` and `undo`. **Reveal in File Tree** is also in
each pane's menu. Commands act on a File Tree that is showing in a sidebar.

## Opening files

- `.md` / `.markdown` / `.csv` / `.tsv` open in a Kelpi document pane.
- `.html`, `.pdf`, `.svg` and images open in a Kelpi web pane.
- Other text files open in your editor in a new split. This runs through `sh`, so an `$EDITOR` with arguments, such as `code --wait`, works in zsh and fish too.
- Everything else opens in the default app, except programs. Executables (by permission bit or file header) and files a default app would run (`.jar`, `.pkg`, `.app` and similar) are revealed in Finder instead. Use **Open with Default App** to run one on purpose.
- Fifos, sockets and devices are never opened.

## Safety

- File names with control characters are never typed into a terminal by **Insert path**, **Open in Editor** or dragging, because the terminal would act on them. They show in the tree as symbols such as `␍`. Copy the path instead.
- Relative paths starting with `-` or `=` are inserted as `./-name`, so a shell can't read them as options.

## Layout

- `kelpi.plugin.json`: manifest. It declares the sidebar view, the commands and settings, and a
  private `andymarcus.filetree.fs` service.
- `backend.mjs`: Node backend that lists folders, searches, watches folders, resolves pane
  directories, changes files and runs OS actions.
- `lib/`: the backend's parts. `gitrepo.mjs` and `git.mjs` for git status, `fileops.mjs` and
  `trash.mjs` for changes, `fuzzy.mjs`, `grep.mjs` and `contentsearch.mjs` for search,
  `names.mjs` and `patterns.mjs` for name rules.
- `ui/`: the build-free view (`app.js`, `util.js`, `categories.js`, `style.css`).

## Limits

- Listings show up to 3,000 entries per folder. Item counts are skipped in folders with more than 400 subfolders.
- Sorting by date or size needs a stat of every entry; folders with more than 20,000 entries use name order.
- Name search keeps up to 3 folder indexes, rebuilt at most every 3 s while files change. It indexes up to 60,000 entries breadth first and skips paths over 1,024 characters. It never descends into `.git`, `node_modules`, `.venv` or similar build and cache folders.
- Text search stops at 400 matches, 20 per file, and skips files over 4 MB.
- Git status reads up to 50,000 changed or ignored paths per repository.

## Development

The plugin has no build step and no dependencies. Node 22 or later runs the tooling.

```sh
npm test            # unit and backend tests (node --test)
npm run check       # every script parses; `kelpi plugin validate` when Kelpi is installed
npm run harness -- --root ~/some/project
```

The harness serves the view in a normal browser at http://localhost:4173, against the real
backend, with a stand-in for Kelpi's `window.kelpi`. Add `?theme=light` for the light theme.
Kelpi actions the view takes (opening files, sending to a terminal) are recorded at
`/harness/log` instead of performed. See `test/harness/server.mjs` for driving it.

CI runs both on macOS and Linux, and fails a pull request that changes the plugin without
raising its version.

## License

MIT. See [LICENSE](LICENSE).
