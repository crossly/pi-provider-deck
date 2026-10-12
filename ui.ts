import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	HubResult,
	HubService,
	HubUIOptions,
	ProviderRow,
	RefreshSummary,
} from "./contracts.ts";

const DEFAULT_TERMINAL_ROWS = 24;
const MAX_MESSAGE_WIDTH = 180;

type Pane = "providers" | "models";

type ProviderItem = { id: string; row: ProviderRow };

interface ModelEntry {
	key: string;
	model: Model<Api>;
	provider: ProviderRow;
}

interface PendingRefresh {
	controller: AbortController;
	promise: Promise<void>;
}

/**
 * Show the model-hub picker. The service owns provider/catalog state; this
 * component only owns transient cursor, filter, and refresh-request state.
 */
export async function showModelHub(
	ctx: ExtensionContext,
	service: HubService,
	options?: HubUIOptions,
): Promise<HubResult> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Model hub is unavailable because interactive UI is not available.", "warning");
		return undefined;
	}

	return ctx.ui.custom<HubResult>(
		(tui, theme, keybindings, done) => {
			const component = new ModelHubComponent(ctx, service, tui, theme, keybindings, done, options);
			if (options?.refreshOnOpen) {
				void component.refreshAll();
			}
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "96%",
				maxHeight: "100%",
				margin: 1,
			},
		},
	);
}

class ModelHubComponent implements Component, Focusable {
	focused = true;

	private readonly filterInput = new Input({ prompt: "" });
	private readonly pending = new Map<string, PendingRefresh>();
	private readonly selectedProviderIds = new Set<string>();
	private readonly initialProvider: string | undefined;
	private readonly done: (result: HubResult) => void;
	private readonly ctx: ExtensionContext;
	private readonly service: HubService;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;

	private rows: ProviderRow[] = [];
	private providerCursor = 0;
	private modelCursor = 0;
	private pane: Pane = "providers";
	private modelEntries: ModelEntry[] = [];
	private filteredModels: ModelEntry[] = [];
	private selectedModelKey: string | undefined;
	private operationMessage: string | undefined;
	private disposed = false;
	private completed = false;
	private unsubscribe: (() => void) | undefined;

	constructor(
		ctx: ExtensionContext,
		service: HubService,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: HubResult) => void,
		options?: HubUIOptions,
	) {
		this.ctx = ctx;
		this.service = service;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.initialProvider = options?.initialProvider;

 		this.readSnapshot();
 		try {
 			this.unsubscribe = service.subscribe(() => this.handleServiceUpdate());
 		} catch (error) {
 			this.operationMessage = `Unable to subscribe to provider updates: ${safeMessage(error)}`;
 		}
	}

    handleInput(data: string): void {
        if (this.disposed) return;

        if (this.isCancelKey(data)) {
            this.finish(undefined);
            return;
        }
        // Single-letter action keys (case-sensitive) — no pi app/TUI binding uses these.
        const letter = this.singleLetter(data);
        if (letter === "a") {
            this.finish({ action: "add" });
            return;
        }
        if (letter === "e") {
            this.editHighlightedProvider();
            return;
        }
        if (letter === "d" || letter === "x") {
            this.removeHighlightedProvider();
            return;
        }
        if (letter === "r") {
            void this.refreshHighlighted();
            return;
        }
        if (letter === "R") {
            void this.refreshAll();
            return;
        }
        if (this.isTabKey(data)) {
            this.pane = this.pane === "providers" ? "models" : "providers";
            this.tui.requestRender();
            return;
        }

        if (this.pane === "providers") {
            this.handleProviderInput(data);
        } else {
            this.handleModelInput(data);
        }
    }

 	render(width: number): string[] {
 		const renderWidth = Math.max(1, Math.floor(width));
 		const innerWidth = Math.max(1, renderWidth - 2);
		const helpLines = this.renderHelpLines(innerWidth);
		// The overlay reserves `margin: 1` top+bottom outside our component; render
		// at most that many rows or pi truncates our bottom border and help.
		const terminalRows = Math.max(6, this.getTerminalRows() - 2);
 		const bodyBudget = Math.max(3, terminalRows - helpLines.length - 3);
		const markedCount = this.selectedProviderIds.size;
		const busy = this.rows.filter((row) => row.status === "refreshing");
		const title = this.renderTitle(busy.length, markedCount);

		const lines: string[] = [];
		lines.push(this.borderLine(`╭${"─".repeat(Math.max(0, innerWidth))}╮`));
		lines.push(this.outerLine(this.fit(title, innerWidth), innerWidth));

		if (innerWidth >= 70) {
			const leftWidth = Math.max(18, Math.floor((innerWidth - 1) * 0.36));
			const rightWidth = Math.max(1, innerWidth - leftWidth - 1);
			const left = this.renderProviderPane(leftWidth, bodyBudget);
			const right = this.renderModelPane(rightWidth, bodyBudget);
			for (let i = 0; i < bodyBudget; i++) {
				lines.push(
					this.outerLine(
						`${this.fit(left[i] ?? "", leftWidth)}${this.borderLine("│")}${this.fit(right[i] ?? "", rightWidth)}`,
						innerWidth,
					),
				);
			}
 		} else {
 			const providerBudget = bodyBudget <= 1 ? bodyBudget : Math.max(1, Math.min(bodyBudget - 1, Math.floor(bodyBudget * 0.42)));
 			const modelBudget = Math.max(0, bodyBudget - providerBudget);
 			const providerLines = this.renderProviderPane(innerWidth, providerBudget);
 			const modelLines = this.renderModelPane(innerWidth, modelBudget);
 			for (const line of providerLines.slice(0, providerBudget)) {
 				lines.push(this.outerLine(this.fit(line, innerWidth), innerWidth));
 			}
 			for (const line of modelLines.slice(0, modelBudget)) {
 				lines.push(this.outerLine(this.fit(line, innerWidth), innerWidth));
 			}
 		}
 
		for (const help of helpLines) {
			lines.push(this.outerLine(this.fit(this.theme.fg("dim", help), innerWidth), innerWidth));
		}
		lines.push(this.borderLine(`╰${"─".repeat(Math.max(0, innerWidth))}╯`));
		// Never exceed the terminal budget: pi clamps silently and would cut the bottom.
		return lines.slice(0, terminalRows);
 	}

 	invalidate(): void {
 		this.filterInput.invalidate();
 		this.tui.requestRender();
 	}

 	dispose(): void {
 		this.cleanup();
 	}

 	async refreshAll(): Promise<void> {
 		if (this.disposed) return;
		const ids = this.rows.filter((row) => row.dynamic && row.configured).map((row) => row.id);
 		if (ids.length === 0) {
 			this.setOperationMessage("No dynamic providers can be refreshed.");
 			return;
 		}
		await this.refresh(ids, "All configured providers");
 	}
 
	private async refreshHighlighted(): Promise<void> {
		const item = this.providerItems()[this.providerCursor];
		if (!item) return;
		if (!item.row.dynamic) {
			this.setOperationMessage(`${this.displayName(item.row.name)} is static; cached models remain available.`);
			return;
		}
		await this.refresh([item.row.id], this.displayName(item.row.name));
	}
 
 	private async refreshSelected(): Promise<void> {
 		const ids = [...this.selectedProviderIds].filter((id) => this.rows.some((row) => row.id === id && row.dynamic));
 		if (ids.length === 0) {
 			this.setOperationMessage("No selected dynamic providers to refresh.");
 			return;
 		}
		await this.refresh(ids, `${ids.length} selected provider${ids.length === 1 ? "" : "s"}`);
 	}
 
 	private async refresh(ids: readonly string[], label: string): Promise<void> {
 		if (this.disposed || ids.length === 0) return;
 		const normalized = [...new Set(ids)];
 		const key = [...normalized].sort().join("\u0000");
 		const existing = this.pending.get(key);
 		if (existing) {
 			this.setOperationMessage(`${label}…`);
 			return existing.promise;
 		}

 		const controller = new AbortController();
		this.setOperationMessage(`Refreshing ${label}…`);
 		const promise = (async () => {
 			try {
 				const summary = await this.service.refresh(this.ctx, normalized, controller.signal);
 				if (!this.disposed) this.showRefreshSummary(summary, label);
 			} catch (error) {
 				if (!this.disposed) {
 					if (controller.signal.aborted || isAbortLike(error)) {
 						this.setOperationMessage(`${label}: cancelled.`);
 					} else {
 						this.setOperationMessage(`${label}: failed — ${safeMessage(error)}`);
 					}
 				}
 			} finally {
 				if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
 				if (!this.disposed) this.tui.requestRender();
 			}
 		})();
 		this.pending.set(key, { controller, promise });
 		await promise;
 	}

 	private showRefreshSummary(summary: RefreshSummary, label: string): void {
 		const failed = summary.results.filter((result) => result.status === "error");
 		const cancelled = summary.results.filter((result) => result.status === "cancelled");
 		const timedOut = failed.find((result) => /tim(?:e|ed)\s*out|timeout/i.test(result.message ?? ""));
 		if (timedOut) {
 			this.setOperationMessage(`${label}: timed out — ${safeMessage(timedOut.message)}`);
 		} else if (failed.length > 0) {
 			const first = failed.find((result) => result.message)?.message;
 			this.setOperationMessage(`${label}: failed${first ? ` — ${safeMessage(first)}` : "."}`);
 		} else if (cancelled.length > 0) {
 			this.setOperationMessage(`${label}: cancelled.`);
 		} else {
 			const count = summary.results.reduce((total, result) => total + result.count, 0);
			this.setOperationMessage(`${label}: refreshed ${summary.results.length} provider(s), ${count} model${count === 1 ? "" : "s"}.`);
 		}
 	}

 	private handleProviderInput(data: string): void {
 		if (this.isUp(data)) this.moveProvider(-1);
 		else if (this.isDown(data)) this.moveProvider(1);
 		else if (this.isPageUp(data)) this.moveProvider(-this.pageSize());
 		else if (this.isPageDown(data)) this.moveProvider(this.pageSize());
 		else if (matchesKey(data, "home")) this.moveProviderTo(0);
 		else if (matchesKey(data, "end")) this.moveProviderTo(this.providerItems().length - 1);
 		else if (matchesKey(data, "space")) this.toggleProviderSelection();
 		else if (this.isConfirm(data)) {
 			this.pane = "models";
 			this.tui.requestRender();
 		}
 	}

 	private handleModelInput(data: string): void {
 		if (this.isUp(data)) this.moveModel(-1);
 		else if (this.isDown(data)) this.moveModel(1);
 		else if (this.isPageUp(data)) this.moveModel(-this.pageSize());
 		else if (this.isPageDown(data)) this.moveModel(this.pageSize());
 		else if (matchesKey(data, "home")) this.moveModelTo(0);
 		else if (matchesKey(data, "end")) this.moveModelTo(this.filteredModels.length - 1);
 		else if (this.isConfirm(data)) {
 			this.chooseModel();
 		} else {
 			const before = this.filterInput.getValue();
 			this.filterInput.handleInput(data);
 			if (before !== this.filterInput.getValue()) this.updateFilter();
 			else this.tui.requestRender();
 		}
 	}

    private highlightedProvider(): ProviderRow | undefined {
        if (this.pane === "models") {
            return this.filteredModels[this.modelCursor]?.provider ?? this.currentProvider();
        }
        return this.currentProvider();
    }

    private editHighlightedProvider(): void {
        const row = this.highlightedProvider();
        if (!row) {
            this.setOperationMessage("No provider selected. Press a to add one.");
            return;
        }
        if (!row.managed) {
            const name = this.displayName(row.name || row.id);
            const id = this.displayName(row.id);
            this.setOperationMessage(
                `${name} is a native/other-extension provider and is not editable via the channel form. Use /login ${id} or edit the provider's configuration.`,
            );
            return;
        }
        this.finish({ action: "edit", providerId: row.id });
    }

    private removeHighlightedProvider(): void {
        const row = this.highlightedProvider();
        if (!row) {
            this.setOperationMessage("No provider selected. Press a to add one.");
            return;
        }
        this.finish({ action: "remove", providerId: row.id });
    }

 	private chooseModel(): void {
 		const entry = this.filteredModels[this.modelCursor];
 		if (!entry) {
 			this.setOperationMessage("No matching model.");
 			return;
 		}
		if (!entry.provider.configured) {
			this.setOperationMessage(`Authentication required. Use /login ${this.displayName(entry.provider.id)}.`);
			return;
		}
 		this.finish({ model: entry.model });
 	}

 	private toggleProviderSelection(): void {
 		const item = this.providerItems()[this.providerCursor];
 		if (!item) return;
		if (this.selectedProviderIds.has(item.id)) {
			this.selectedProviderIds.delete(item.id);
		} else {
			this.selectedProviderIds.add(item.id);
		}
		this.tui.requestRender();
	}

 	private moveProvider(delta: number): void {
 		this.moveProviderTo(this.providerCursor + delta);
 	}

 	private moveProviderTo(index: number): void {
 		const items = this.providerItems();
 		if (items.length === 0) return;
 		const next = clamp(index, 0, items.length - 1);
 		if (next === this.providerCursor) return;
 		this.providerCursor = next;
 		this.rebuildModels(this.selectedModelKey);
 		this.tui.requestRender();
 	}

 	private moveModel(delta: number): void {
 		this.moveModelTo(this.modelCursor + delta);
 	}

 	private moveModelTo(index: number): void {
 		if (this.filteredModels.length === 0) {
 			this.modelCursor = 0;
 			this.tui.requestRender();
 			return;
 		}
 		this.modelCursor = clamp(index, 0, this.filteredModels.length - 1);
 		this.selectedModelKey = this.filteredModels[this.modelCursor]?.key;
 		this.tui.requestRender();
 	}

 	private readSnapshot(): void {
 		try {
 			this.applyRows(this.service.snapshot(this.ctx), true);
 		} catch (error) {
 			this.rows = [];
 			this.rebuildModels(undefined);
 			this.operationMessage = `Unable to read providers: ${safeMessage(error)}`;
 		}
 	}

 	private handleServiceUpdate(): void {
 		if (this.disposed) return;
 		try {
 			this.applyRows(this.service.snapshot(this.ctx));
 		} catch (error) {
 			this.operationMessage = `Unable to update providers: ${safeMessage(error)}`;
 		}
 		this.tui.requestRender();
 	}

    private applyRows(nextRows: ProviderRow[], initial = false): void {
        const currentItem = this.providerItems()[this.providerCursor];
        const currentProviderId = currentItem?.id;
        const currentModelKey = this.selectedModelKey;
        this.rows = nextRows.slice();
        for (const id of [...this.selectedProviderIds]) {
            if (!this.rows.some((row) => row.id === id)) this.selectedProviderIds.delete(id);
        }

        const items = this.providerItems();
        let nextProvider = currentProviderId ? items.findIndex((item) => item.id === currentProviderId) : -1;
        if (initial) {
            const requested = this.initialProvider ? items.findIndex((item) => item.id === this.initialProvider) : -1;
            nextProvider = requested >= 0 ? requested : (items.length > 0 ? 0 : -1);
        } else if (nextProvider < 0) {
            nextProvider = items.length > 0 ? 0 : -1;
        }
        this.providerCursor = items.length === 0 ? 0 : clamp(nextProvider >= 0 ? nextProvider : 0, 0, items.length - 1);
        this.rebuildModels(currentModelKey);
    }

 	private updateFilter(): void {
 		const key = this.filteredModels[this.modelCursor]?.key ?? this.selectedModelKey;
 		this.rebuildModels(key);
 		this.tui.requestRender();
 	}

 	private rebuildModels(previousKey: string | undefined): void {
 		const provider = this.currentProvider();
		const sourceRows = provider ? [provider] : this.rows.filter((row) => row.configured);
 		const entries: ModelEntry[] = [];
 		for (const row of sourceRows) {
 			for (const model of row.models) {
 				entries.push({
 					key: `${row.id}\u0000${model.id}\u0000${model.baseUrl}`,
 					model,
 					provider: row,
 				});
 			}
 		}
 		this.modelEntries = entries;
 		const query = this.filterInput.getValue().trim().toLocaleLowerCase();
 		this.filteredModels = query
 			? entries.filter((entry) => {
					const haystack = [entry.model.id, entry.model.name, entry.provider.transportApi ?? entry.model.api, entry.provider.name]
 						.map((value) => this.displayName(value))
 						.join(" ")
 						.toLocaleLowerCase();
 					return haystack.includes(query);
 				})
 			: entries;

 		const preservedIndex = previousKey ? this.filteredModels.findIndex((entry) => entry.key === previousKey) : -1;
 		this.modelCursor = this.filteredModels.length === 0 ? 0 : clamp(preservedIndex >= 0 ? preservedIndex : this.modelCursor, 0, this.filteredModels.length - 1);
 		this.selectedModelKey = this.filteredModels[this.modelCursor]?.key;
 	}

	private renderProviderPane(width: number, height: number): string[] {
		const items = this.providerItems();
		const lines: string[] = [];
		const title = ` ${this.pane === "providers" ? "▶" : " "} Providers (${items.length})`;
		lines.push(this.theme.fg(this.pane === "providers" ? "accent" : "text", title));
		const scroll = scrollFor(this.providerCursor, items.length, Math.max(0, height - 1));
		let lastGroup: string | undefined = undefined;
		for (let offset = 0; offset < height - 1; offset++) {
			const index = scroll + offset;
			const item = items[index];
			if (!item) {
				lines.push("");
				continue;
			}
			// Group header between rows from different groups.
			const groupName = item.row.group;
			if (groupName !== lastGroup) {
				if (offset > 0 || index > 0) lines.push(this.theme.fg("dim", "  ──"));
				lines.push(this.theme.fg("muted", `  ${groupName || "General"}`));
				lastGroup = groupName;
			}
			const selected = index === this.providerCursor;
			const marked = this.selectedProviderIds.has(item.row.id);
			const count = item.row.models.length;
			const status = this.statusLabel(item.row);
			const label = `${marked ? "◉" : "○"} ${this.displayName(item.row.name)}  ${count} ${status}`;
			lines.push(this.providerLine(label, selected, width));
		}
		if (items.length === 0) lines.push(this.theme.fg("dim", "  No providers. Press a to add one"));
		return padLines(lines, height);
	}

	private renderModelPane(width: number, height: number): string[] {
		const lines: string[] = [];
		const title = ` ${this.pane === "models" ? "▶" : " "} Models (${this.filteredModels.length}/${this.modelEntries.length})`;
		lines.push(this.theme.fg(this.pane === "models" ? "accent" : "text", title));
		this.filterInput.focused = this.focused && this.pane === "models";
		const filterWidth = Math.max(1, width - 2);
		const filterRendered = this.filterInput.render(filterWidth)[0] ?? "";
		lines.push(this.fit(`${this.theme.fg("muted", "Filter ")}${filterRendered}`, width));

		const visibleItems = Math.max(0, height - 2);
		const scroll = scrollFor(this.modelCursor, this.filteredModels.length, visibleItems);
		for (let offset = 0; offset < visibleItems; offset++) {
			const index = scroll + offset;
			const entry = this.filteredModels[index];
			if (!entry) {
				lines.push("");
				continue;
			}
			const selected = index === this.modelCursor;
			const name = this.displayName(entry.model.name || entry.model.id);
			const id = this.displayName(entry.model.id);
			const primary = name === id ? name : `${name} · ${id}`;
			const context = formatContextWindow(entry.model.contextWindow);
			lines.push(this.modelLine(`${selected ? "▶" : " "} ${primary}  ${context}`, selected, width));
		}
		if (this.filteredModels.length === 0) {
			lines.push(this.theme.fg("dim", this.filterInput.getValue() ? "  No matching models." : "  No cached models."));
		}
		return padLines(lines, height);
	}

	private renderTitle(busyCount: number, markedCount: number): string {
		const pane = this.pane === "providers" ? "Providers" : "Models";
		const marked = markedCount > 0 ? ` · ${markedCount} marked` : "";
		const busy = busyCount > 0 ? ` · refreshing ${busyCount}` : "";
		const operation = this.operationMessage ? ` · ${this.operationMessage}` : "";
		return ` ${this.theme.fg("accent", "Model Hub")}  ${this.theme.fg("muted", `${pane}${marked}${busy}`)}${operation}`;
	}

    private renderHelpLines(width: number): string[] {
        const help = "a add · e edit · d/x remove · r refresh · R refresh all · Space mark · Tab pane · Enter choose · Esc cancel";
        return wrapTextWithAnsi(help, Math.max(1, width));
    }

	private providerLine(label: string, selected: boolean, width: number): string {
		return this.selectedStyle(label, selected, width);
	}

	private modelLine(text: string, selected: boolean, width: number): string {
		return this.selectedStyle(text, selected, width);
	}

	private selectedStyle(text: string, selected: boolean, width: number): string {
		const styled = selected ? this.theme.style(text, { fg: "accent", bg: "selectedBg", bold: true }) : this.theme.fg("text", text);
		return this.fit(styled, width);
	}

    private providerDetail(row: ProviderRow): string {
        const endpoint = sanitizeEndpoint(row.endpoint);
        const message = row.message ? safeMessage(row.message) : "";
        const source = row.managed ? "Managed channel" : "Native/other-extension provider";
        if (message) return `${source} · ${message}${endpoint ? ` · ${endpoint}` : ""}`;
        if (endpoint) return `${source} · ${endpoint}`;
        if (row.status === "static" || !row.dynamic) return `${source} · static provider`;
        return `${source} · ${row.configured ? "Configured; no endpoint reported" : "Not configured"}`;
    }

	private currentProvider(): ProviderRow | undefined {
		return this.providerItems()[this.providerCursor]?.row;
	}

    private providerItems(): ProviderItem[] {
        return this.rows.map((row) => ({ id: row.id, row }));
    }

 	private statusLabel(row: ProviderRow): string {
		if (!row.configured && row.status !== "refreshing") return "no auth";
 		if (row.status === "static" || !row.dynamic) return "static";
 		if (row.status === "refreshing") return "refreshing…";
 		if (row.status === "success") return "ready";
 		if (row.status === "error") return "error";
 		if (row.status === "cancelled") return "cancelled";
 		return "idle";
 	}

 	private setOperationMessage(message: string): void {
 		if (this.disposed) return;
 		this.operationMessage = safeMessage(message);
 		this.tui.requestRender();
 	}

 	private finish(result: HubResult): void {
 		if (this.completed) return;
 		this.completed = true;
 		this.cleanup();
 		this.done(result);
 	}

 	private cleanup(): void {
 		if (this.disposed) return;
 		this.disposed = true;
 		this.unsubscribe?.();
 		this.unsubscribe = undefined;
 		for (const operation of this.pending.values()) operation.controller.abort();
 		this.pending.clear();
 	}

 	private isCancelKey(data: string): boolean {
 		return matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || this.keybindings.matches(data, "tui.select.cancel");
 	}

	/** Recognize one printable ASCII letter as an action key; ignores space/tab/escape. */
	private singleLetter(data: string): string | undefined {
		if (data.length !== 1) return undefined;
		const code = data.charCodeAt(0);
		if (code < 0x21 || code > 0x7e) return undefined;
		return data;
	}

 	private isTabKey(data: string): boolean {
 		return matchesKey(data, "tab") || matchesKey(data, "shift+tab") || this.keybindings.matches(data, "tui.input.tab");
 	}

 	private isConfirm(data: string): boolean {
 		return matchesKey(data, "enter") || this.keybindings.matches(data, "tui.select.confirm");
 	}

 	private isUp(data: string): boolean {
 		return matchesKey(data, "up") || this.keybindings.matches(data, "tui.select.up");
 	}

 	private isDown(data: string): boolean {
 		return matchesKey(data, "down") || this.keybindings.matches(data, "tui.select.down");
 	}

 	private isPageUp(data: string): boolean {
 		return matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.select.pageUp");
 	}

 	private isPageDown(data: string): boolean {
 		return matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.select.pageDown");
 	}

 	private pageSize(): number {
 		return Math.max(1, Math.floor(this.getTerminalRows() * 0.6));
 	}

 	private getTerminalRows(): number {
 		const rows = this.tui.terminal.rows;
 		return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_TERMINAL_ROWS;
 	}

 	private outerLine(content: string, width: number): string {
 		return `${this.borderLine("│")}${this.fit(content, width)}${this.borderLine("│")}`;
 	}

 	private borderLine(content: string): string {
 		return this.theme.fg("border", content);
 	}

 	private fit(text: string, width: number): string {
 		const target = Math.max(0, Math.floor(width));
 		if (target === 0) return "";
 		const clipped = truncateToWidth(text, target, "…", true);
 		const padding = Math.max(0, target - visibleWidth(clipped));
 		return `${clipped}${" ".repeat(padding)}`;
 	}

 	private displayName(value: unknown): string {
 		return stripTerminalSequences(String(value ?? "")).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
 	}
}

function clamp(value: number, min: number, max: number): number {
 	return Math.min(max, Math.max(min, value));
}

function padLines(lines: string[], height: number): string[] {
 	const result = lines.slice(0, Math.max(0, height));
 	while (result.length < height) result.push("");
 	return result;
}

function scrollFor(cursor: number, total: number, visible: number): number {
 	if (visible <= 0 || total <= visible) return 0;
 	return clamp(cursor - visible + 1, 0, total - visible);
}

function formatContextWindow(value: number | undefined): string {
 	if (!Number.isFinite(value) || value === undefined || value <= 0) return "context ?";
 	if (value >= 1_000_000) return `context ${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
 	if (value >= 1_000) return `context ${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
 	return `context ${Math.round(value)}`;
}

function sanitizeEndpoint(value: string | undefined): string {
 	const raw = stripTerminalSequences(String(value ?? "")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
 	if (!raw) return "";
 	try {
 		const url = new URL(raw);
 		url.username = "";
 		url.password = "";
 		url.search = "";
 		url.hash = "";
 		const port = url.port ? `:${url.port}` : "";
 		const path = url.pathname === "/" ? "" : url.pathname;
 		return `${url.protocol}//${url.hostname}${port}${path}`;
 	} catch {
 		const queryStart = raw.search(/[?#]/);
 		let result = queryStart >= 0 ? raw.slice(0, queryStart) : raw;
 		const scheme = result.indexOf("://");
 		const authorityStart = scheme >= 0 ? scheme + 3 : result.startsWith("//") ? 2 : -1;
 		if (authorityStart >= 0) {
 			const pathStart = result.indexOf("/", authorityStart);
 			const authorityEnd = pathStart >= 0 ? pathStart : result.length;
 			const authEnd = result.lastIndexOf("@", authorityEnd);
 			if (authEnd >= authorityStart) result = `${result.slice(0, authorityStart)}${result.slice(authEnd + 1)}`;
 		}
 		return result;
 	}
}

function safeMessage(value: unknown): string {
 	let message = stripTerminalSequences(value instanceof Error ? value.message : String(value ?? ""))
 		.replace(/[\u0000-\u001f\u007f]/g, " ")
 		.replace(/https?:\/\/[^\s)\]}>,]+/gi, (url) => sanitizeEndpoint(url))
 		.replace(/\b(api[-_ ]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
 		.trim();
 	if (message.length > MAX_MESSAGE_WIDTH) message = `${message.slice(0, MAX_MESSAGE_WIDTH - 1)}…`;
 	return message || "unknown error";
}

function isAbortLike(error: unknown): boolean {
 	if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return true;
 	if (typeof error !== "object" || error === null || !("name" in error)) return false;
 	const name = error.name;
 	return name === "AbortError";
}

