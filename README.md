# File Tree for Kelpi

A colour-coded file tree sidebar for [Kelpi](https://github.com/benfriebe/kelpi), based on
[filetree-cli](https://github.com/andymarcus/filetree-cli). It shows the folder of the focused
pane and follows it as you switch panes or `cd` around.

## Install

```sh
git clone https://github.com/andymarcus/kelpi-plugin-filetree.git
kelpi plugin install ./kelpi-plugin-filetree --trust
```

Plugins run with your account's access, so read the code before installing it. `--trust`
confirms that you have.

Then go to **Settings → Plugins → Workbench views** and set the right sidebar
(`sidebar.secondary`) or the left one (`sidebar.primary`) to **File Tree**.

To pick up edits while you work, use `kelpi plugin dev . --trust`.

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
| `← →` / `h l` | Collapse / expand, or go to the parent |
| `⏎` | Open (folders toggle) |
| `e` | Open in `$VISUAL` / `$EDITOR` in a new split |
| `i` | Insert path in the terminal (`@path` for Claude panes) |
| `c` / `⇧C` | Copy path / relative path |
| `r` | Reveal in Finder |
| `/` | Fuzzy search |
| `.` | Toggle hidden files |
| `p` | Pin / unpin folder |
| `?` | Shortcut help |

Right-click for the same actions plus **Open Terminal Here** and **Open with Default App**.

Drag a file or folder from the tree into a terminal pane to drop in its path, quoted for the shell.

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

- `kelpi.plugin.json`: manifest. It declares one sidebar view and a private `andymarcus.filetree.fs` service.
- `backend.mjs`: Node backend that lists folders, runs search, watches folders, resolves pane directories and runs OS actions.
- `ui/`: the build-free view (`app.js`, `categories.js`, `style.css`).

## Limits

- Listings show up to 3,000 entries per folder. Item counts are skipped in folders with more than 400 subfolders.
- Search keeps up to 3 folder indexes, rebuilt at most every 3 s while files change. It indexes up to 60,000 entries breadth first and skips paths over 1,024 characters. It never descends into `.git`, `node_modules`, `.venv` or similar build and cache folders.
