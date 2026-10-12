import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Input,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Channel, HubService, ProviderRow } from "./contracts.ts";
import { notify } from './terminal.ts';

const MAX_PROVIDER_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 512;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_INPUT_PROMPT = "API key: ";
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

type InferenceApi = Channel["api"];
type DiscoveryType = NonNullable<Channel["discovery"]>["type"];
type CredentialChoice = "keep" | "direct" | "environment" | "command" | "keyless";


interface RefreshResult {
	id: string;
	status: ProviderRow["status"];
	count: number;
	message?: string;
}


/** Mask public Input rendering while retaining its editing and cursor contract. */
class MaskedInput extends Input {
	constructor() {
		super({ prompt: "" });
	}

	override render(width: number): string[] {
		const available = width - visibleWidth(SECRET_INPUT_PROMPT);
		if (available <= 0) return [truncateToWidth(SECRET_INPUT_PROMPT, width, "")];
		return super.render(available).map(line => {
			const masked = line.split(CURSOR_MARKER).map(part => {
				const plain = stripTerminalSequences(part).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
				return [...segmenter.segment(plain)].map(({ segment }) => /^\s+$/.test(segment)
					? segment
					: "•".repeat(Math.max(1, visibleWidth(segment)))).join("");
			}).join(CURSOR_MARKER);
			return SECRET_INPUT_PROMPT + masked;
		});
	}
}

class SecretInputComponent implements Component, Focusable {
	focused = true;

	private readonly input = new MaskedInput();
	private completed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (value: string | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (this.completed) return;
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			this.keybindings.matches(data, "tui.select.cancel")
		) {
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, "enter") || this.keybindings.matches(data, "tui.select.confirm")) {
			this.finish(this.input.getValue());
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.input.handleMouse(event);
		if (result) this.tui.requestRender();
		return result;
	}

	render(width: number): string[] {
		this.input.focused = this.focused;
		const innerWidth = Math.max(1, width);
		return [
			this.theme.fg("accent", "Direct API key"),
			this.theme.fg("muted", "Enter to save · Escape to cancel"),
			this.input.render(innerWidth)[0] ?? "",
		];
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.input.setValue("");
	}

    private finish(value: string | undefined): void {
        if (this.completed) return;
        this.completed = true;
        this.input.setValue("");
        this.done(value);
    }
}


function safeErrorMessage(error: unknown, fallback: string, secrets: readonly string[] = []): string {
	const raw = error instanceof Error ? error.message : "";
	if (!raw || raw.length > 240 || /[\r\n]/.test(raw)) return fallback;
	if (secrets.some(secret => secret.length > 0 && raw.includes(secret))) return fallback;
	return raw;
}

function scrubDetail(detail: string | undefined, secrets: readonly string[], fallback: string): string {
	if (!detail || detail.length > 240 || /[\r\n]/.test(detail)) return fallback;
	if (secrets.some(secret => secret.length > 0 && detail.includes(secret))) return fallback;
	return detail;
}

function validateProviderId(raw: string): string {
	const value = raw.trim();
	if (value.length === 0 || value.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID.test(value)) {
		throw new Error("Provider ID must start with a letter or number and contain only stable ID characters.");
	}
	return value;
}

function validateEndpoint(raw: string, existing?: string): string {
	const value = raw.trim() || existing?.trim() || "";
	if (!value) throw new Error("Endpoint URL is required.");
	if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Endpoint URL contains unsupported control characters.");
	try {
		const parsed = new URL(value);
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
			throw new Error("unsupported endpoint");
		}
	} catch {
		throw new Error("Endpoint URL must use HTTP or HTTPS and must not contain credentials.");
	}
	return value;
}

function validateDisplayName(raw: string, existing?: string): string | undefined {
	const value = raw.trim();
	const chosen = value || existing?.trim() || "";
	if (chosen.length > MAX_DISPLAY_NAME_LENGTH) throw new Error("Display name is too long.");
	if (!chosen) return undefined;
	if (/[\u0000-\u001f\u007f]/.test(chosen)) throw new Error("Display name contains unsupported control characters.");
	return chosen;
}

function inferEnvironmentName(existing?: Channel): string {
	const configured = existing?.apiKey.trim() ?? "";
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(configured);
	return match?.[1] ?? existing?.envVars?.[0] ?? "MY_API_KEY";
}

function orderedInferenceApis(existing?: Channel): InferenceApi[] {
    const options: InferenceApi[] = ["openai-responses", "openai-completions"];
    if (existing?.api === "openai-completions") options.reverse();
    return options;
}

function orderedDiscoveryTypes(existing?: Channel): DiscoveryType[] {
	const current = existing?.discovery?.type;
	const all: DiscoveryType[] = ["openai", "ollama", "gemini"];
	return current ? [current, ...all.filter(type => type !== current)] : all;
}

function parseInferenceApi(value: string | undefined): InferenceApi | undefined {
    if (value === "openai-responses") return "openai-responses";
    if (value === "openai-completions") return "openai-completions";
    return undefined;
}

function parseDiscoveryType(value: string | undefined): DiscoveryType | undefined {
    if (value === "openai") return "openai";
    if (value === "ollama") return "ollama";
    if (value === "gemini") return "gemini";
    return undefined;
}

function parseCredentialChoice(value: string | undefined, hasExisting: boolean): CredentialChoice | undefined {
	if (value === undefined) return undefined;
	if (hasExisting && (value === "Keep existing" || value === "Keep existing credential")) return "keep";
	if (value === "Direct API key") return "direct";
	if (value === "Environment variable") return "environment";
	if (value === "!Command" || value === "Command") return "command";
	if (value === "Keyless local" || value === "Keyless local endpoint") return "keyless";
	return undefined;
}

function activeChannelId(existing: Channel | undefined, requestedId: string | undefined): string | undefined {
	const requested = requestedId?.trim();
	if (existing && requested && existing.id !== requested) {
		throw new Error("The channel ID cannot change during an edit.");
	}
	return requested || existing?.id;
}

async function promptDirectApiKey(ctx: ExtensionContext): Promise<string | undefined> {
    const result = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => new SecretInputComponent(tui, theme, keybindings, done),
        {
            overlay: true,
            overlayOptions: { width: "70%", maxHeight: "50%", margin: 1 },
        },
    );
    return result;
}

/**
 * Add or edit one managed channel. The form deliberately keeps credentials
 * opaque: existing values are never put in a prompt placeholder or rendered
 * into an error/notification.
 */
export async function configureChannel(
	ctx: ExtensionContext,
	service: HubService,
	id?: string,
	existing?: Channel,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		notify(ctx, "Adding or editing providers requires interactive UI.", "warning");
		return undefined;
	}

	const requested = activeChannelId(existing, id);
	let providerId = requested;
	if (!providerId) {
		const entered = await ctx.ui.input("Provider ID", "my-provider");
		if (entered === undefined) return undefined;
		providerId = validateProviderId(entered);
	} else {
		providerId = validateProviderId(providerId);
	}

    const rowExists = service.snapshot(ctx).some(row => row.id === providerId) || service.channels().some(channel => channel.id === providerId);
	if (rowExists && !existing) {
		throw new Error("A provider with that ID already exists; edit the existing provider instead.");
	}

	const endpointInput = await ctx.ui.input(existing ? "Endpoint URL (Enter keeps current)" : "Endpoint URL", existing?.baseUrl ?? "https://api.example.com/v1");
	if (endpointInput === undefined) return undefined;
	const baseUrl = validateEndpoint(endpointInput, existing?.baseUrl);

	const nameInput = await ctx.ui.input(existing ? "Display name (Enter keeps current)" : "Display name (optional)", existing?.name ?? "e.g. Team Gateway");
	if (nameInput === undefined) return undefined;
	const displayName = validateDisplayName(nameInput, existing?.name);

	const groupInput = await ctx.ui.input(existing ? "Group (Enter keeps current, empty removes)" : "Group (optional)", existing?.group ?? "e.g. work, personal");
	if (groupInput === undefined) return undefined;
	const groupName = validateDisplayName(groupInput, existing?.group);
	const selectedApi = parseInferenceApi(await ctx.ui.select("Inference API", orderedInferenceApis(existing)));
	if (!selectedApi) return undefined;

	const credentialOptions = [
		...(existing ? ["Keep existing"] : []),
		"Direct API key",
		"Environment variable",
		"!Command",
		"Keyless local",
	];
	const credentialChoice = parseCredentialChoice(await ctx.ui.select("Credentials", credentialOptions), Boolean(existing));
	if (!credentialChoice) return undefined;

	let apiKey = existing?.apiKey ?? "";
	let authHeader = existing?.authHeader;
	const sensitiveValues: string[] = [];
	if (credentialChoice === "direct") {
		const directKey = await promptDirectApiKey(ctx);
		if (directKey === undefined) return undefined;
		if (!directKey.trim()) throw new Error("A direct API key is required; choose Keyless local for an endpoint without credentials.");
		apiKey = directKey;
		authHeader = true;
		sensitiveValues.push(directKey);
	} else if (credentialChoice === "environment") {
		const envNameInput = await ctx.ui.input("Environment variable name", inferEnvironmentName(existing));
		if (envNameInput === undefined) return undefined;
		const envName = envNameInput.trim();
		if (!ENVIRONMENT_NAME.test(envName)) throw new Error("Environment variable name is invalid.");
		apiKey = `$${envName}`;
		authHeader = true;
	} else if (credentialChoice === "command") {
		const commandInput = await ctx.ui.input("Command that prints the API key", "e.g. secret-tool lookup service gateway");
		if (commandInput === undefined) return undefined;
		const command = commandInput.trim();
		if (!command || /[\u0000-\u001f\u007f]/.test(command)) throw new Error("A non-empty credential command is required.");
		apiKey = command.startsWith("!") ? command : `!${command}`;
		authHeader = true;
		sensitiveValues.push(command, apiKey);
	} else if (credentialChoice === "keyless") {
		apiKey = "";
		authHeader = false;
    } else {
        sensitiveValues.push(apiKey);
        if (apiKey.startsWith("!")) sensitiveValues.push(apiKey.slice(1));
    }

	const selectedDiscovery = parseDiscoveryType(
		await ctx.ui.select(
			"Model catalog protocol (catalog only; generation uses the selected OpenAI API, not native Google inference)",
			orderedDiscoveryTypes(existing),
		),
	);
	if (!selectedDiscovery) return undefined;

	const channel: Channel = {
		...(existing ?? {}),
		id: providerId,
		baseUrl,
		api: selectedApi,
		apiKey,
		...(authHeader !== undefined ? { authHeader } : {}),
		discovery: { ...(existing?.discovery ?? {}), type: selectedDiscovery },
	};
	if (groupName) channel.group = groupName;
	else if (!existing?.group) delete channel.group;

	try {
		await service.upsert(channel, ctx);
	} catch (error) {
		throw new Error(safeErrorMessage(error, "Unable to save provider configuration.", sensitiveValues));
	}

	try {
		const summary = await service.refresh(ctx, [providerId]);
		const result = summary.results.find(item => item.id === providerId) as RefreshResult | undefined;
		if (!result) {
			notify(ctx, `Saved ${providerId}, but model discovery returned no status. Configuration remains saved; previous cached models were kept.`, "warning");
		} else if (result.status === "error" || result.status === "cancelled") {
			const fallback = result.status === "cancelled" ? "model discovery was cancelled" : "model discovery failed";
			const detail = scrubDetail(result.message, sensitiveValues, fallback);
			notify(ctx, `Saved ${providerId}, but ${detail}. Configuration remains saved; previous cached models were kept.`, "warning");
		} else {
			const noun = result.count === 1 ? "model" : "models";
			notify(ctx, `Saved ${providerId}; discovered ${result.count} ${noun}.`, "info");
		}
	} catch (error) {
		const detail = safeErrorMessage(error, "model discovery failed", sensitiveValues);
		notify(ctx, `Saved ${providerId}, but ${detail}. Configuration remains saved; previous cached models were kept.`, "warning");
	}

	return providerId;
}

/** Confirm and remove/hide one Model Hub provider without touching auth or static model files. */
export async function removeProvider(ctx: ExtensionContext, service: HubService, row: ProviderRow): Promise<boolean> {
	if (!ctx.hasUI) {
		notify(ctx, "Removing providers requires interactive UI confirmation.", "warning");
		return false;
	}

	const active = ctx.model?.provider === row.id;
	const activeWarning = active
		? " This is the active model provider; the current model will not be switched automatically."
		: "";
	const title = row.managed ? "Remove channel" : "Hide provider";
	const message = row.managed
		? `Remove ${row.id} from the Model Hub channel registry? Stored credentials and models.json remain untouched.${activeWarning}`
		: `Hide ${row.id} from Model Hub? The compiled/pi provider registration, authentication, and models.json remain untouched.${activeWarning}`;
	if (!(await ctx.ui.confirm(title, message))) return false;

	try {
		await service.remove(row.id, ctx);
	} catch (error) {
		notify(ctx, safeErrorMessage(error, `Unable to remove ${row.id} from Model Hub.`), "error");
		return false;
	}

	if (row.managed) {
		notify(ctx, `Removed channel ${row.id} from Model Hub. Stored credentials and models.json were not deleted.${active ? " The current model was not switched." : ""}`, "info");
	} else {
		notify(ctx, `Hid ${row.id} from Model Hub. pi registration, authentication, and models.json were not changed.${active ? " The current model was not switched." : ""}`, "info");
	}
	return true;
}
