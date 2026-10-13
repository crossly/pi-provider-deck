# Pi Provider Deck

A pi extension for configuring multiple model providers, discovering models, and refreshing catalogs with F5. Includes an interactive provider/model panel, add/edit/remove workflows, per-provider progress, and marked/all-provider refresh.

Requires **pi 1.1.0 or newer** and **Node.js 22.19 or newer**. The development and cold-install checks pin pi 1.1.0. Uses public pi extension APIs; the native `/model` picker is unchanged.

## Installation

After the package is published to npm:

```sh
pi install npm:pi-provider-deck
```

## Use

Open `/model-hub`, `/channels`, `/models`, or press **Alt+M**.

### Panel keys

| Key | Action |
|---|---|
| **a** | Add a provider, including from an empty list |
| **e** | Edit the highlighted managed provider |
| **d** / **x** | Confirm removal/hiding of the highlighted provider |
| **r** | Force-refresh the highlighted provider |
| **R** | Refresh all configured dynamic providers |
| **Space** | Mark/unmark the highlighted provider |
| **Tab** | Switch between provider/model panes |
| Arrows / PageUp / PageDown / Home / End | Navigate |
| Type / Backspace in the model pane | Filter; Backspace never deletes a provider |
| **Enter** | Select a model for the current session |
| **Esc / Ctrl+C** | Close and cancel this panel's outstanding waits |

The main editor's F5 refreshes the active provider. `/model-hub <provider>` opens a specific provider pane.

Command equivalents:

```text
/channels list
/channels add [id]
/channels edit <id>
/channels remove <id>
/channels refresh
/channels refresh provider-a,provider-b
/models-refresh provider-a,provider-b
```

The default list shows managed channels and other authenticated/configured pi providers—not pi's entire unconfigured builtin catalog. A managed channel without credentials stays visible so it can be edited or removed.

Run `/reload` in an existing pi session, or start a new session.

### Upgrade, uninstall, and old local installations

```sh
pi update --extensions
pi remove npm:pi-provider-deck
```

A pinned npm version stays pinned; remove it and install the desired version to change that pin.

If upgrading from the development `omp-channels.ts` or `provider-deck.ts` bootstrap in `~/.pi/agent/extensions/`, back up and remove that bootstrap **before** installing this package. Otherwise both copies register the same commands. Removing the extension does not delete provider configuration or credentials.

Provider configuration lives directly in pi's native **`~/.pi/agent/models.json`** — the single source of truth. Extension-owned providers carry a `piProviderDeck` metadata block; native and other-extension entries are never modified. A legacy `~/.pi/agent/omp-channels.json` registry is migrated automatically on first start and renamed to `omp-channels.json.migrated` as a backup.

## Configuring and removing providers

The wizard configures provider ID, URL, display name, inference API, credentials, and discovery protocol. Saving triggers discovery immediately. A failed discovery leaves the saved configuration intact and reports the failure; it never claims successful network discovery when credential resolution fails.

Credentials support masked direct API keys, environment variables, `!command`, and keyless local endpoints. During editing, **Keep existing** does not show the old key. Enter retains the current endpoint/name. Model defaults/overrides and unknown configuration fields are retained.

Removing an owned provider deletes its models.json entry and unregisters it. Removing a native/other-extension provider persistently hides it from this panel via `piProviderDeck.hidden: true` in its models.json entry; its credentials and model declarations are never touched. Set `hidden: false` (or delete the marker) to restore a hidden native provider.

## Configuration

```json
{
  "providers": {
    "team-gateway": {
      "name": "Team gateway",
      "baseUrl": "https://gateway.example/v1",
      "api": "openai-responses",
      "apiKey": "$GATEWAY_API_KEY",
      "piProviderDeck": {
        "managed": true,
        "group": "work",
        "defaults": {
          "contextWindow": 131072,
          "maxTokens": 16384,
          "reasoning": false,
          "input": ["text"]
        },
        "discovery": { "type": "openai", "timeoutMs": 10000 }
      }
    }
  }
}
```

### Provider groups

Set an optional `group` on a channel (or enter one in the add/edit form) to organize the panel into visual sections. Providers without a group appear under "General". Groups are display-only labels; they do not affect discovery, credentials, or refresh behavior.

### Protocols and metadata

Managed channels generate through **`openai-responses`** or **`openai-completions`**. Catalog adapters do not convert an incompatible inference protocol:

- `openai` (default): `/v1/models`; an existing `/v1` suffix is not doubled. `injectV1: false` uses the host's `/models` convention. `discovery.url` explicitly overrides the catalog URL.
- `ollama`: `/api/tags`, normalized from the host or `/v1` base URL.
- `gemini`: `<baseUrl>/models`, normalizes `models/` IDs and follows pagination. API-key discovery uses `x-goog-api-key`.

For native Google/Anthropic/etc. inference, configure pi's built-in provider; this panel delegates its discovery/refresh to pi.

A bare model ID does not establish context size, output limits, image/reasoning support, or price. Configure accurate defaults and per-model overrides; metadata is not guessed from model names. Missing limits use the prior extension's **unverified 128K/16K fallback**, explicitly flagged in the panel. Zero price means unknown, not a guarantee of free usage. Pi's pricing tiers, image/input limits, thinking-specific sampling, and explicit model metadata are supported.

Explicit static `models` entries in a provider's models.json entry remain available even when omitted by remote discovery. They supply metadata, not authority to override a managed provider's URL/API/key. Managed providers use a stable `pi-provider-deck:<provider>` dispatch identity internally; the panel displays the actual configured OpenAI transport. Refresh does not rewrite `models.json`; remove obsolete static entries yourself if you want only remotely listed models.

### Credential security

- Keys/references support literals, `$NAME`, `${NAME}`, or `!command`; headers support environment interpolation and command references.
- An explicit channel key/environment/command is authoritative for that managed endpoint. Stored pi credentials are a fallback only when the channel has no explicit credential source. This prevents old `models.json` or stored values from shadowing an endpoint/key edit. Use separate provider IDs for independently authenticated endpoints.
- POSIX commands use a shell; native Windows command credentials use a platform-appropriate shell. Commands must use that platform's syntax. Treat command-bearing configuration as trusted executable code.
- Timeouts and cancellation terminate the command process tree; failed commands report an error rather than masquerading as a successful catalog refresh.
- Authenticated catalog redirects are rejected. Model IDs containing terminal controls are rejected, and notification sinks strip terminal escape/control sequences.
- Cached models are rebound/validated against the current transport. An endpoint/API/key edit must not send a new credential to an old cached endpoint.
- Resolved credential headers are never persisted in model-cache records. Direct keys in the registry are **plaintext**, not encrypted; use environment or secret-manager commands when possible. POSIX registry files are written privately (0600); Windows protection depends on your user-profile ACLs.

### Persistence, concurrency, and cancellation

Registry edits are locked, reread, merged, and atomically committed. Unrelated external changes are preserved; conflicting edits to the same provider are rejected for you to retry. `sync`, add/edit/remove, and provider ownership changes share the transaction/lifecycle rules. Reload/disposal unregisters owned providers and prevents obsolete async operations from registering them again.

Refreshes use one service-wide bounded queue. Duplicate provider refreshes share work, but each caller's cancellation remains independent; an operation with no remaining waiters is cancelled. Failures preserve usable metadata under the **current** endpoint/API, not stale credential-bearing transport. Valid empty remote catalogs replace the dynamic list with an empty list.

## SDK embedding

The default export is the CLI entry point and uses pi's process configuration directory. An SDK host with its own `agentDir` must use the explicit factory; pi's extension context does not expose that directory implicitly:

```typescript
import { createProviderDeck } from "pi-provider-deck";

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [createProviderDeck({ agentDir })],
});
```

Pass `configPath` instead to select an exact registry file. The package entry is TypeScript; SDK hosts use their TypeScript loader/build tooling, while pi's package loader handles it automatically.

## Development and release

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:install
```

The install acceptance check packs the actual npm artifact, serves it from an isolated loopback registry, runs the real `pi install npm:pi-provider-deck@<version>`, verifies host packages are not physically installed as dependencies, loads the commands via RPC, and exercises authenticated model discovery. No user configuration or external inference service is used.

CI runs type checks, behavioral regressions, packed-install verification, and pack inspection on Linux/Windows with Node 22.19/24. Source tests use actual pi SDK/model registries, local HTTP servers, temporary registries, and event-driven gates for races. `prepublishOnly` runs the same checks before a real npm publication.

Local acceptance was exercised on Node 22.19 and Node 26: 26 behavioral regressions and the exact packed npm installation passed. Windows/Linux CI jobs are configured but are not reported as passed until they run on GitHub.

Release manually after the intended GitHub repository exists and CI passes:

```sh
npm login
npm publish --access public
```

The package name was checked as unoccupied while preparing this release; npm names are not reserved by a local check. Recheck ownership/name availability before publishing. No publish/upload is performed by development checks or CI.

## Changelog

### 1.2.1 — discovery writeback

- A successful provider refresh now persists the discovered catalog into that provider's `models` array in `models.json`, so external consumers (e.g. Paseo) see the full runtime catalog without an RPC query. Per-model user overrides and the `piProviderDeck` metadata block are preserved; transport fields (`provider`, `api`, `baseUrl`, `headers`) are excluded.

### 1.2.0 — models.json as the single source of truth

- Provider configuration now lives directly in pi's native `~/.pi/agent/models.json`; the private `omp-channels.json` registry is gone. Extension-owned providers carry a `piProviderDeck` metadata block (`managed`, `group`, `defaults`, `modelOverrides`, `discovery`, `hidden`); native and other-extension entries are never modified.
- First start migrates a legacy `omp-channels.json` automatically and renames it `omp-channels.json.migrated` as a backup. Hidden legacy provider IDs become hidden-marker entries in models.json.
- Removing a managed provider deletes its models.json entry; removing a native provider writes `piProviderDeck.hidden: true` into its entry so static model declarations cannot make it reappear.
- Static `models` arrays in a provider entry are honored natively (no separate static-metadata pass).

### 1.1.1 — interaction and layout fixes

- Add/edit wizard: pressing Enter on an empty field now reopens the panel silently instead of surfacing validation errors; only real input mistakes are reported.
- Panel layout: reserves the overlay's terminal margins in the row budget and clamps rendered rows, so the bottom border and help line are no longer cut off on shorter terminals.

### 1.1.0 — UI redesign and provider groups

- Replaces F-key shortcuts with letter keys: `a` add, `e` edit, `d`/`x` remove, `r` refresh, `R` refresh all, `Space` mark, `Tab` pane, `Enter` choose. Removes redundant F2/F3/F4/F5/F6/Shift+F5/Ctrl+R and right-arrow pane switching.
- Adds optional provider groups: configure `group` in the add/edit form; the panel organizes providers into visual group sections.
- Compacts the panel: removes the "All providers" row, shows one line per provider and model, and collapses help to a single line.
- Keeps editor-level F5 (active provider refresh) unchanged; only the panel shortcuts changed.

### 1.0.2 — publication hardening and package rename

- Renames the public package to `pi-provider-deck`; preserves existing configuration and command names.
- Hardens cached transport isolation, redirects, credential-command errors/process cleanup, and terminal-safe output.
- Preserves inner command quotes verbatim for native Windows `cmd /s /c`, including executable paths containing spaces.
- Waits for Windows process-tree enumeration/termination before killing the shell; verifies descendant shutdown through TCP liveness, not malformed HTTP responses.
- Adds transactional cross-process configuration updates and owned-provider lifecycle cleanup.
- Enforces a shared refresh queue and independent cancellation for coalesced callers.
- Preserves complete/unknown model and discovery metadata and adds explicit SDK configuration isolation.
- Adds MIT licensing/attribution, public install instructions, CI, and actual packed npm-install acceptance checks.

### 1.0.1

Configured-only provider list, visible F2/F3/Delete management, masked key input, and persistent removal.

## License

MIT. Applicable Pi attribution is retained in `NOTICE`.
