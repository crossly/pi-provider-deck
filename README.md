# Pi Provider Deck

A pi extension for configuring multiple model providers, discovering models, and refreshing catalogs with F5. Includes an interactive provider/model panel, add/edit/remove workflows, per-provider progress, and marked/all-provider refresh.

Requires **pi 1.1.0 or newer** and **Node.js 22.19 or newer**. The development and cold-install checks pin pi 1.1.0. Uses public pi extension APIs; the native `/model` picker is unchanged.

## Installation

After the package is published to npm:

```sh
pi install npm:pi-provider-deck
```

Pin a release:

```sh
pi install npm:pi-provider-deck@1.0.2
```

From GitHub after the repository is created:

```sh
pi install git:github.com/crossly/pi-provider-deck
```

For a local checkout before publication:

```sh
npm ci --ignore-scripts
pi install ./
```

Run `/reload` in an existing pi session, or start a new session.

### Upgrade, uninstall, and old local installations

```sh
pi update --extensions
pi remove npm:pi-provider-deck
```

A pinned npm version stays pinned; remove it and install the desired version to change that pin.

If upgrading from the development `omp-channels.ts` or `provider-deck.ts` bootstrap in `~/.pi/agent/extensions/`, back up and remove that bootstrap **before** installing this package. Otherwise both copies register the same commands. Removing the extension does not delete provider configuration or credentials.

The registry filename stays **`~/.pi/agent/omp-channels.json`** to preserve existing users' provider data. Renaming the npm package does not migrate, overwrite, or duplicate that registry. No developer-specific path is required by the npm package.

## Use

Open `/model-hub`, `/channels`, `/models`, or press **Alt+M**.

| Panel key | Action |
|---|---|
| **F2** | Add a provider, including from an empty list |
| **F3** | Edit a managed provider |
| **Delete / F4** | Confirm removal/hiding of a provider |
| **F5** | Force-refresh the highlighted provider; All refreshes configured dynamic providers |
| **Ctrl+R / Shift+F5** | Refresh all configured dynamic providers |
| **Space → F6** | Mark providers, then refresh the marked set |
| **Tab** | Switch provider/model focus |
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

### Configuring and removing providers

The wizard configures provider ID, URL, display name, inference API, credentials, and discovery protocol. Saving triggers discovery immediately. A failed discovery leaves the saved configuration intact and reports the failure; it never claims successful network discovery when credential resolution fails.

Credentials support masked direct API keys, environment variables, `!command`, and keyless local endpoints. During editing, **Keep existing** does not show the old key. Enter retains the current endpoint/name. Model defaults/overrides and unknown configuration fields are retained.

Removing an owned channel deletes its registry entry and unregisters its provider. Removing a native/other-extension provider persistently hides it from this panel. Neither operation deletes pi `auth.json` or `models.json`; an active model is not silently switched. Hidden IDs live in `hiddenProviders` in the registry so static model declarations cannot make them reappear here. Remove an ID from that array to restore a hidden native provider, or re-add a channel with that ID.

## Configuration

```json
{
  "channels": [
    {
      "id": "team-gateway",
      "name": "Team gateway",
      "baseUrl": "https://gateway.example/v1",
      "api": "openai-responses",
      "apiKey": "$GATEWAY_API_KEY",
      "defaults": {
        "contextWindow": 131072,
        "maxTokens": 16384,
        "reasoning": false,
        "input": ["text"]
      },
      "discovery": { "type": "openai", "timeoutMs": 10000 }
    }
  ],
  "hiddenProviders": []
}
```

### Protocols and metadata

Managed channels generate through **`openai-responses`** or **`openai-completions`**. Catalog adapters do not convert an incompatible inference protocol:

- `openai` (default): `/v1/models`; an existing `/v1` suffix is not doubled. `injectV1: false` uses the host's `/models` convention. `discovery.url` explicitly overrides the catalog URL.
- `ollama`: `/api/tags`, normalized from the host or `/v1` base URL.
- `gemini`: `<baseUrl>/models`, normalizes `models/` IDs and follows pagination. API-key discovery uses `x-goog-api-key`.

For native Google/Anthropic/etc. inference, configure pi's built-in provider; this panel delegates its discovery/refresh to pi.

A bare model ID does not establish context size, output limits, image/reasoning support, or price. Configure accurate defaults and per-model overrides; metadata is not guessed from model names. Missing limits use the prior extension's **unverified 128K/16K fallback**, explicitly flagged in the panel. Zero price means unknown, not a guarantee of free usage. Pi's pricing tiers, image/input limits, thinking-specific sampling, and explicit model metadata are supported.

Explicit static entries in the registry directory's `models.json` remain available even when omitted by remote discovery. They supply metadata, not authority to override a managed channel's URL/API/key. Managed channels use a stable `pi-provider-deck:<provider>` dispatch identity internally; the panel displays the actual configured OpenAI transport. F5 does not rewrite `models.json`; remove obsolete static entries yourself if you want only remotely listed models.

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

### 1.0.2 — publication hardening and package rename

- Renames the public package to `pi-provider-deck`; preserves existing configuration and command names.
- Hardens cached transport isolation, redirects, credential-command errors/process cleanup, and terminal-safe output.
- Adds transactional cross-process configuration updates and owned-provider lifecycle cleanup.
- Enforces a shared refresh queue and independent cancellation for coalesced callers.
- Preserves complete/unknown model and discovery metadata and adds explicit SDK configuration isolation.
- Adds MIT licensing/attribution, public install instructions, CI, and actual packed npm-install acceptance checks.

### 1.0.1

Configured-only provider list, visible F2/F3/Delete management, masked key input, and persistent removal.

## License

MIT. Applicable Pi attribution is retained in `NOTICE`.
