---
name: tmux
description: "Remote control tmux sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output."
license: Vibecoded
---

# tmux Skill

Use tmux as a programmable terminal multiplexer for interactive work. Works on Linux and macOS with stock tmux; avoid custom config by using a private socket.

> **Windows 注意**:pi 在 Windows 上使用 Git Bash,其中不含 tmux。需要本 skill 时请改用 WSL2 或远程 Linux/macOS 环境。

## Quickstart (isolated socket)

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/claude-tmux-sockets  # well-known dir for all agent sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"                # keep agent sessions separate from your personal tmux
SESSION=claude-python                           # slug-like names; avoid spaces
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'python3 -q' Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200  # watch output
tmux -S "$SOCKET" kill-session -t "$SESSION"                   # clean up
```

After starting a session ALWAYS tell the user how to monitor the session by giving them a command to copy paste:

```
To monitor this session yourself:
  tmux -S "$SOCKET" attach -t claude-lldb

Or to capture the output once:
  tmux -S "$SOCKET" capture-pane -p -J -t claude-lldb:0.0 -S -200
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop.  But the earlier you send it, the happier the user will be.

## Socket convention

- Agents MUST place tmux sockets under `CLAUDE_TMUX_SOCKET_DIR` (defaults to `${TMPDIR:-/tmp}/claude-tmux-sockets`) and use `tmux -S "$SOCKET"` so we can enumerate/clean them. Create the dir first: `mkdir -p "$CLAUDE_TMUX_SOCKET_DIR"`.
- Default socket path to use unless you must isolate further: `SOCKET="$CLAUDE_TMUX_SOCKET_DIR/claude.sock"`.

## Targeting panes and naming

- Target format: `{session}:{window}.{pane}`, defaults to `:0.0` if omitted. Keep names short (e.g., `claude-py`, `claude-gdb`).
- Use `-S "$SOCKET"` consistently to stay on the private socket path. If you need user config, drop `-f /dev/null`; otherwise `-f /dev/null` gives a clean config.
- Inspect: `tmux -S "$SOCKET" list-sessions`, `tmux -S "$SOCKET" list-panes -a`.

## Managing Multiple Sessions

### Session Operations
- **Create new session**: `tmux -S "$SOCKET" new -d -s session-name -n window-name`
- **List all sessions**: `tmux -S "$SOCKET" list-sessions` or `tmux -S "$SOCKET" ls`
- **Attach to session**: `tmux -S "$SOCKET" attach -t session-name`
- **Detach from session**: `Ctrl+b d` (when attached) or send-keys: `tmux -S "$SOCKET" send-keys -t session:0.0 C-b d`
- **Switch between sessions** (when attached): `Ctrl+b s` or `tmux -S "$SOCKET" switch-client -t session-name`
- **Kill session**: `tmux -S "$SOCKET" kill-session -t session-name`
- **Rename session**: `tmux -S "$SOCKET" rename-session -t old-name new-name`

### Session Info and Inspection
- **Session metadata**: `tmux -S "$SOCKET" list-sessions -F '#{session_name}: #{session_windows} windows (#{session_attached} attached)'`
- **Check if session exists**: `tmux -S "$SOCKET" has-session -t session-name 2>/dev/null && echo "exists" || echo "not found"`

## Managing Windows in a Session

### Window Operations
- **Create new window**: `tmux -S "$SOCKET" new-window -t session-name: -n window-name`
- **List windows**: `tmux -S "$SOCKET" list-windows -t session-name`
- **Select window**: `tmux -S "$SOCKET" select-window -t session-name:window-index` or `tmux -S "$SOCKET" select-window -t session-name:window-name`
- **Kill window**: `tmux -S "$SOCKET" kill-window -t session-name:window-index`
- **Rename window**: `tmux -S "$SOCKET" rename-window -t session-name:window-index new-name`
- **Move window**: `tmux -S "$SOCKET" move-window -s source-session:window -d dest-session:window`

### Window Navigation (when attached)
- **Next window**: `Ctrl+b n`
- **Previous window**: `Ctrl+b p`
- **Select window by number**: `Ctrl+b 0-9`
- **Window list**: `Ctrl+b w`

## Managing Panes in a Window

### Pane Creation (Splitting)
- **Split horizontally** (top/bottom): `tmux -S "$SOCKET" split-window -t session:window -v -p 50`
  - `-v` = vertical split (creates panes stacked vertically)
  - `-p 50` = percentage of window height (50%)
  - `-l 20` = fixed lines (20 lines tall)
- **Split vertically** (left/right): `tmux -S "$SOCKET" split-window -t session:window -h -p 50`
  - `-h` = horizontal split (creates panes side by side)
  - `-p 30` = percentage of window width (30%)
- **Split with command**: `tmux -S "$SOCKET" split-window -t session:window -h 'python3 -q'`
- **Split in specific direction**: `tmux -S "$SOCKET" split-window -t session:window -v -f` (full width/height)

### Pane Selection and Navigation
- **List all panes**: `tmux -S "$SOCKET" list-panes -t session:window`
- **List all panes (all windows)**: `tmux -S "$SOCKET" list-panes -a -t session`
- **Select pane**: `tmux -S "$SOCKET" select-pane -t session:window.pane`
- **Select pane by direction** (when attached): `Ctrl+b ←/↑/↓/→` or `Ctrl+b q` then pane number
- **Last pane**: `tmux -S "$SOCKET" last-pane -t session:window`

### Pane Resizing
- **Resize pane**: `tmux -S "$SOCKET" resize-pane -t session:window.pane -D 10` (down 10 lines)
  - Directions: `-U` (up), `-D` (down), `-L` (left), `-R` (right)
  - `-x 80` = set width to 80 columns
  - `-y 24` = set height to 24 lines
- **Resize with arrow keys** (when attached): `Ctrl+b Ctrl+←/↑/↓/→`

### Pane Management
- **Kill pane**: `tmux -S "$SOCKET" kill-pane -t session:window.pane`
- **Break pane to new window**: `tmux -S "$SOCKET" break-pane -t session:window.pane -n new-window-name`
- **Join pane to another window**: `tmux -S "$SOCKET" join-pane -s source:window.pane -t dest:window`
- **Swap panes**: `tmux -S "$SOCKET" swap-pane -s session:window.0 -t session:window.1`
- **Rotate panes**: `tmux -S "$SOCKET" rotate-window -t session:window`
- **Toggle pane zoom** (fullscreen): `tmux -S "$SOCKET" resize-pane -t session:window.pane -Z`

### Layout Presets
- **Set layout**: `tmux -S "$SOCKET" select-layout -t session:window main-horizontal`
  - Available layouts: `even-horizontal`, `even-vertical`, `main-horizontal`, `main-vertical`, `tiled`
- **Next layout** (when attached): `Ctrl+b Space`

## Common Multi-Pane Workflows

### Example: Development Environment
```bash
# Create session with editor, build, and test panes
tmux -S "$SOCKET" new -d -s dev -n main
tmux -S "$SOCKET" split-window -t dev:0 -v -p 30  # bottom 30% for tests
tmux -S "$SOCKET" split-window -t dev:0.0 -h -p 50  # right 50% for build
tmux -S "$SOCKET" send-keys -t dev:0.0 'vim .' Enter
tmux -S "$SOCKET" send-keys -t dev:0.1 'npm run build' Enter
tmux -S "$SOCKET" send-keys -t dev:0.2 'npm test' Enter
```

### Example: Monitoring Dashboard
```bash
# Create 4-pane monitoring dashboard
tmux -S "$SOCKET" new -d -s monitor -n dashboard
tmux -S "$SOCKET" split-window -t monitor:0 -v -p 50
tmux -S "$SOCKET" split-window -t monitor:0.0 -h -p 50
tmux -S "$SOCKET" split-window -t monitor:0.1 -h -p 50
# Top-left: logs
tmux -S "$SOCKET" send-keys -t monitor:0.0 'tail -f /var/log/app.log' Enter
# Top-right: metrics
tmux -S "$SOCKET" send-keys -t monitor:0.1 'htop' Enter
# Bottom-left: db
tmux -S "$SOCKET" send-keys -t monitor:0.2 'psql -U user db' Enter
# Bottom-right: api calls
tmux -S "$SOCKET" send-keys -t monitor:0.3 'httpstat :8080' Enter
```

## Finding sessions

- List sessions on your active socket with metadata: `./scripts/find-sessions.sh -S "$SOCKET"`; add `-q partial-name` to filter.
- Scan all sockets under the shared directory: `./scripts/find-sessions.sh --all` (uses `CLAUDE_TMUX_SOCKET_DIR` or `${TMPDIR:-/tmp}/claude-tmux-sockets`).

## Sending input safely

- Prefer literal sends to avoid shell splitting: `tmux -L "$SOCKET" send-keys -t target -l -- "$cmd"`
- When composing inline commands, use single quotes or ANSI C quoting to avoid expansion: `tmux ... send-keys -t target -- $'python3 -m http.server 8000'`.
- To send control keys: `tmux ... send-keys -t target C-c`, `C-d`, `C-z`, `Escape`, etc.

## Watching output

- Capture recent history (joined lines to avoid wrapping artifacts): `tmux -L "$SOCKET" capture-pane -p -J -t target -S -200`.
- For continuous monitoring, poll with the helper script (below) instead of `tmux wait-for` (which does not watch pane output).
- You can also temporarily attach to observe: `tmux -L "$SOCKET" attach -t "$SESSION"`; detach with `Ctrl+b d`.
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action don't assume they remembered the command.

## Spawning Processes

Some special rules for processes:

- when asked to debug, use lldb by default
- when starting a python interactive shell, always set the `PYTHON_BASIC_REPL=1` environment variable. This is very important as the non-basic console interferes with your send-keys.

## Synchronizing / waiting for prompts

- Use timed polling to avoid races with interactive tools. Example: wait for a Python prompt before sending code:
  ```bash
  ./scripts/wait-for-text.sh -t "$SESSION":0.0 -p '^>>>' -T 15 -l 4000
  ```
- For long-running commands, poll for completion text (`"Type quit to exit"`, `"Program exited"`, etc.) before proceeding.

## Interactive tool recipes

- **Python REPL**: `tmux ... send-keys -- 'python3 -q' Enter`; wait for `^>>>`; send code with `-l`; interrupt with `C-c`. Always with `PYTHON_BASIC_REPL`.
- **gdb**: `tmux ... send-keys -- 'gdb --quiet ./a.out' Enter`; disable paging `tmux ... send-keys -- 'set pagination off' Enter`; break with `C-c`; issue `bt`, `info locals`, etc.; exit via `quit` then confirm `y`.
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern—start the program, poll for its prompt, then send literal text and Enter.

## Cleanup

- Kill a session when done: `tmux -S "$SOCKET" kill-session -t "$SESSION"`.
- Kill all sessions on a socket: `tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t`.
- Remove everything on the private socket: `tmux -S "$SOCKET" kill-server`.

## Helper: wait-for-text.sh

`./scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout. Works on Linux/macOS with bash + tmux + grep.

```bash
./scripts/wait-for-text.sh -t session:0.0 -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]
```

- `-t`/`--target` pane target (required)
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- `-l` history lines to search from the pane (integer, default 1000)
- Exits 0 on first match, 1 on timeout. On failure prints the last captured text to stderr to aid debugging.
