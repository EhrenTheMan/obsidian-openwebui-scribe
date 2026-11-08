# OpenWebUI Scribe (`obsidian-openwebui-scribe`)

An autonomous AI note-taking and thought-partner plugin for Obsidian.

Scan and complete inline `(scribe: ...)` tags in markdown notes using local **Ollama** and **OpenWebUI** services, with configurable model routing and fallback.

---

## Features

- **Inline Tag Processing**: Write notes naturally and annotate with `(scribe: <query>)` to auto-expand notes in place.
- **Smart Model Routing**:
  - **Fast Route** (Default: Local Ollama): For definitions, rapid summaries, and concise expansions.
  - **Deep Route** (Default: OpenWebUI): For proofs, complex logic, and deep analysis.
- **Flag Support**:
  - `-d`, `--deep`, `deep:`, `think:` — Routes request to the deep-thinking model.
  - `-v`, `--verbose` — Request detailed, thorough explanations instead of high-density concise output.
- **Collapsible Thinking Callouts**: Embed expandable callouts containing model thinking chains and telemetry.
- **Optional GPU Telemetry**: Reports utilization, memory usage, and temperature when supported by `nvidia-smi`.
- **Companion CLI Tool**: Standalone Python CLI (`scribe`) to process active notes, specific files, or entire vaults from the terminal.

---

## Tag Syntax Examples

| Syntax | Action | Route |
| :--- | :--- | :--- |
| `(scribe: define idempotency)` | Short, high-density definition | Fast (Local Ollama) |
| `(scribe -d: explain Dijkstra's algorithm vs A*)` | In-depth comparison | Deep (OpenWebUI) |
| `(scribe --deep: verify proof of halting problem)` | Formal reasoning | Deep (OpenWebUI) |
| `(scribe -v: break down TCP 3-way handshake)` | Detailed breakdown | Fast (Local Ollama) |
| `(scribe -d -v: architectural tradeoffs of raft)` | Deep + verbose | Deep (OpenWebUI) |

---

## Obsidian Commands & Hotkeys

- **Process Scribe tags in active note**: `Alt + Mod + S`
- **Insert Scribe command tag**: `Alt + Mod + A` (inserts `(scribe: )` and positions cursor inside)
- **Scan & process Scribe tags in entire vault**: Accessible from the Obsidian Command Palette.

---

## Repository Structure

```
obsidian-openwebui-scribe/
├── cli/
│   └── scribe.py          # Companion CLI script (also at ~/.local/bin/scribe)
├── data.example.json      # Example settings configuration (template)
├── jsconfig.json          # VS Code JavaScript configuration for IntelliSense
├── main.js                # Obsidian plugin implementation
├── manifest.json          # Obsidian plugin manifest
├── package.json           # Node project manifest & Obsidian types
├── .gitignore             # Git ignore file (excludes secrets and node_modules)
└── README.md
```

---

## Local Development in VS Code

1. Install dependencies to enable editor type-checking and IntelliSense:
   ```bash
   npm install
   ```
2. Open the project in VS Code:
   ```bash
   code .
   ```
3. Copy `data.example.json` to `data.json` if configuring local test settings:
   ```bash
   cp data.example.json data.json
   ```

### Linking with Obsidian Vault

To test changes live in Obsidian without manually copying files, create a symlink from your vault's plugins folder to this repo:

```bash
# Example symlink command:
ln -sfn "/path/to/obsidian-openwebui-scribe" "/path/to/vault/.obsidian/plugins/obsidian-openwebui-scribe"
```

Then reload Obsidian or toggle the plugin off and on in Settings -> Community Plugins.

---

## CLI Companion Tool

The repository also includes `cli/scribe.py` (which can be symlinked or copied to `~/.local/bin/scribe`):

```bash
# Process (scribe:...) tags in active Obsidian note
scribe active

# Scan and complete tags across the entire vault
scribe scan

# Process a specific note file
scribe file "/path/to/note.md"

# Test local Ollama and OpenWebUI endpoints & optional GPU metrics
scribe test
```

Set `OBSIDIAN_VAULT_PATH` to your vault location to configure the CLI's default vault path. The default is `~/Documents/Obsidian`.

---

## License

MIT License. Copyright (c) 2026 EhrenTheMan.
