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

const ALL_PROVIDER_ID = "\u0000all-providers";
const DEFAULT_TERMINAL_ROWS = 24;
const MAX_MESSAGE_WIDTH = 180;

type Pane = "providers" | "models";

type ProviderItem =
 	| { all: true; id: typeof ALL_PROVIDER_ID }
	| { all: false; id: string; row: ProviderRow };

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
        if (matchesKey(data, "f2")) {
            this.finish({ action: "add" });
            return;
        }
        if (matchesKey(data, "f3")) {
            this.editHighlightedProvider();
            return;
        }
        if (matchesKey(data, "f4") || matchesKey(data, "delete")) {
            this.removeHighlightedProvider();
            return;
        }
        if (matchesKey(data, "shift+f5") || matchesKey(data, "ctrl+r")) {
            void this.refreshAll();
            return;
        }
        if (matchesKey(data, "f5")) {
            void this.refreshHighlighted();
            return;
        }
        if (matchesKey(data, "f6")) {
            void this.refreshSelected();
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
		const terminalRows = this.getTerminalRows();
 		const bodyBudget = Math.max(1, terminalRows - helpLines.length - 6);
		const allSelected = this.isAllSelected();
		const busy = this.rows.filter((row) => row.status === "refreshing");
		const title = this.renderTitle(busy.length, allSelected);

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
 		return lines;
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
 		if (item.all) {
 			await this.refreshAll();
 			return;
 		}
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
 		else if (matchesKey(data, "right") || this.isConfirm(data)) {
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
            this.setOperationMessage(
                this.isAllSelected()
                    ? "The All providers entry is a group; select a provider to edit."
                    : "No provider selected. Press F2 to add one.",
            );
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
            this.setOperationMessage(
                this.isAllSelected()
                    ? "All providers cannot be removed; select a provider first."
                    : "No provider selected. Press F2 to add one.",
            );
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
 		if (item.all) {
			const dynamicIds = this.rows.filter((row) => row.dynamic && row.configured).map((row) => row.id);
 			const everySelected = dynamicIds.length > 0 && dynamicIds.every((id) => this.selectedProviderIds.has(id));
 			if (everySelected) {
 				for (const id of dynamicIds) this.selectedProviderIds.delete(id);
 			} else {
 				for (const id of dynamicIds) this.selectedProviderIds.add(id);
 			}
 		} else if (this.selectedProviderIds.has(item.id)) {
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
        const currentWasAll = currentItem?.all === true;
        const currentProviderId = currentItem && !currentItem.all ? currentItem.id : undefined;
        const currentModelKey = this.selectedModelKey;
        this.rows = nextRows.slice();
        for (const id of [...this.selectedProviderIds]) {
            if (!this.rows.some((row) => row.id === id)) this.selectedProviderIds.delete(id);
        }

        const items = this.providerItems();
        const firstProvider = items.findIndex((item) => !item.all);
        let nextProvider = currentProviderId ? items.findIndex((item) => item.id === currentProviderId) : -1;
        if (initial) {
            const requested = this.initialProvider ? items.findIndex((item) => !item.all && item.id === this.initialProvider) : -1;
            nextProvider = requested >= 0 ? requested : firstProvider;
        } else if (nextProvider < 0) {
            nextProvider = currentWasAll && items.length > 0 ? 0 : firstProvider;
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
 		const title = ` ${this.pane === "providers" ? "▶" : " "} Providers (${this.rows.length})`;
 		lines.push(this.theme.fg(this.pane === "providers" ? "accent" : "text", title));
 		const visibleItems = Math.max(0, Math.floor((height - 1) / 2));
 		const scroll = scrollFor(this.providerCursor, items.length, visibleItems);
 		for (let offset = 0; offset < visibleItems; offset++) {
 			const index = scroll + offset;
 			const item = items[index];
 			if (!item) {
 				lines.push("");
 				lines.push("");
 				continue;
 			}
 			const selected = index === this.providerCursor;
 			const marked = item.all
				? this.rows.some((row) => row.dynamic && row.configured) && this.rows.filter((row) => row.dynamic && row.configured).every((row) => this.selectedProviderIds.has(row.id))
 				: this.selectedProviderIds.has(item.id);
 			if (item.all) {
 				const totalModels = this.rows.reduce((sum, row) => sum + row.models.length, 0);
 				const status = this.aggregateStatus();
 				lines.push(this.providerLine(`[${marked ? "x" : " "}] All providers`, `${this.rows.length} providers · ${totalModels} models · ${status}`, selected, width));
 				lines.push(this.providerDetailLine("Refresh every dynamic provider", selected, width));
 			} else {
 				const count = item.row.models.length;
 				const status = this.statusLabel(item.row);
				lines.push(this.providerLine(`[${marked ? "x" : " "}] ${count} ${status} · ${this.displayName(item.row.name)}`, "", selected, width));
 				const detail = this.providerDetail(item.row);
 				lines.push(this.providerDetailLine(detail, selected, width));
 			}
 		}
        if (items.length === 0) lines.push(this.theme.fg("dim", "No providers. F2 Add provider"));
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

 		const visibleItems = Math.max(0, Math.floor((height - 2) / 2));
 		const scroll = scrollFor(this.modelCursor, this.filteredModels.length, visibleItems);
 		for (let offset = 0; offset < visibleItems; offset++) {
 			const index = scroll + offset;
 			const entry = this.filteredModels[index];
 			if (!entry) {
 				lines.push("");
 				lines.push("");
 				continue;
 			}
 			const selected = index === this.modelCursor;
 			const name = this.displayName(entry.model.name || entry.model.id);
 			const id = this.displayName(entry.model.id);
 			const primary = name === id ? name : `${name} · ${id}`;
			const details = `${this.displayName(entry.provider.name)} · ${this.displayName(entry.provider.transportApi ?? entry.model.api)} · ${formatContextWindow(entry.model.contextWindow)}`;
 			lines.push(this.modelLine(primary, selected, width));
 			lines.push(this.modelDetailLine(details, selected, width));
 		}
 		if (this.filteredModels.length === 0) {
 			lines.push(this.theme.fg("dim", this.filterInput.getValue() ? "No matching models." : "No cached models."));
 		}
 		return padLines(lines, height);
 	}

 	private renderTitle(busyCount: number, allSelected: boolean): string {
 		const pane = this.pane === "providers" ? "Providers" : "Models";
 		const selection = this.selectedProviderIds.size > 0 ? ` · ${this.selectedProviderIds.size} selected` : "";
 		const busy = busyCount > 0 ? ` · Refreshing ${busyCount}` : "";
 		const operation = this.operationMessage ? ` · ${this.operationMessage}` : "";
 		return ` ${this.theme.fg("accent", "Model Hub")}  ${this.theme.fg("muted", `${pane}${allSelected ? " · all" : ""}${selection}${busy}`)}${operation}`;
 	}

    private renderHelpLines(width: number): string[] {
        const help = [
            "F2 Add provider · F3 Edit provider · F4/Delete Remove provider",
            "Tab pane · ↑↓/PgUp/PgDn/Home/End move · type/Backspace filter only · Enter choose · F5 provider/all · Shift+F5/Ctrl+R all · Space mark · F6 marked · Esc/Ctrl+C cancel",
        ];
        const lineWidth = Math.max(1, width);
        return help.flatMap((line) => wrapTextWithAnsi(line, lineWidth));
    }

 	private providerLine(label: string, status: string, selected: boolean, width: number): string {
 		const text = `${selected ? "▶" : " "} ${label}  ${status}`;
 		return this.selectedStyle(text, selected, width);
 	}

 	private providerDetailLine(text: string, selected: boolean, width: number): string {
 		const styled = selected ? this.theme.style(`  ${text}`, { fg: "accent", bg: "selectedBg" }) : this.theme.fg("dim", `  ${text}`);
 		return this.fit(styled, width);
 	}

 	private modelLine(text: string, selected: boolean, width: number): string {
 		return this.selectedStyle(`${selected ? "▶" : " "} ${text}`, selected, width);
 	}

 	private modelDetailLine(text: string, selected: boolean, width: number): string {
 		const styled = selected ? this.theme.style(`  ${text}`, { fg: "accent", bg: "selectedBg" }) : this.theme.fg("dim", `  ${text}`);
 		return this.fit(styled, width);
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
 		const item = this.providerItems()[this.providerCursor];
 		return item && !item.all ? item.row : undefined;
 	}

    private providerItems(): ProviderItem[] {
        if (this.rows.length === 0) return [];
        return [
            { all: true, id: ALL_PROVIDER_ID },
            ...this.rows.map((row) => ({ all: false as const, id: row.id, row })),
        ];
    }

 	private isAllSelected(): boolean {
 		return this.providerItems()[this.providerCursor]?.all === true;
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

 	private aggregateStatus(): string {
 		if (this.rows.some((row) => row.status === "refreshing")) return "refreshing…";
 		if (this.rows.some((row) => row.status === "error")) return "error";
 		if (this.rows.some((row) => row.status === "cancelled")) return "cancelled";
 		if (this.rows.length > 0 && this.rows.every((row) => row.status === "static" || !row.dynamic)) return "static";
 		if (this.rows.some((row) => row.status === "success")) return "ready";
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

