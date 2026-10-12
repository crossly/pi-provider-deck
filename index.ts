import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import type { ProviderDeckOptions, RefreshSummary } from './contracts.ts';
import { createHubService } from './service.ts';
import { showModelHub } from './ui.ts';
import { configureChannel, removeProvider } from './manage.ts';
import { notify } from './terminal.ts';

const USAGE = '/channels [list | refresh [all|id,id] | add [id] | edit <id> | remove <id>]';

function refreshReport(summary: RefreshSummary) {
  return summary.results.map(row => `${row.id}: ${row.status}, ${row.count} models${row.message ? ` — ${row.message}` : ''}`).join('\n') || 'No configured dynamic providers found.';
}

/** SDK callers must pass their session's agentDir or an explicit configPath. */
export function createProviderDeck(options: ProviderDeckOptions = {}): ExtensionFactory {
  const configPath = options.configPath ?? join(options.agentDir ?? getAgentDir(), 'omp-channels.json');
  return function providerDeck(pi: ExtensionAPI) {
  const service = createHubService(pi, configPath);
  let opening = false;

  const open = async (ctx: ExtensionContext, initialProvider?: string) => {
    if (!ctx.hasUI) {
      notify(ctx, 'Model Hub requires interactive mode. Use /channels list or /models-refresh in RPC mode.', 'warning');
      return;
    }
    if (opening) return;
    opening = true;
    let provider = initialProvider ?? ctx.model?.provider;
    try {
      for (;;) {
        await service.sync(ctx);
        const result = await showModelHub(ctx, service, { initialProvider: provider });
        if (!result) return;
        if ('model' in result) {
          if (!ctx.isIdle()) {
            notify(ctx, 'Wait for the current turn to finish before switching models.', 'warning');
            continue;
          }
          if (await pi.setModel(result.model)) {
            notify(ctx, `Model: ${result.model.provider}/${result.model.id}`, 'info');
            return;
          }
          notify(ctx, `Cannot select ${result.model.provider}/${result.model.id}; check provider authentication.`, 'error');
          continue;
        }
        try {
          if (result.action === 'add') {
            provider = await configureChannel(ctx, service) ?? provider;
          } else if (result.action === 'edit') {
            const channel = service.channels().find(row => row.id === result.providerId);
            if (!channel) {
              notify(ctx, 'This provider is configured by pi or another extension. Use /login or its own configuration to edit it.', 'warning');
            } else {
              provider = await configureChannel(ctx, service, channel.id, channel) ?? provider;
            }
          } else {
            const row = service.snapshot(ctx).find(row => row.id === result.providerId);
            if (row && await removeProvider(ctx, service, row)) provider = undefined;
          }
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : 'Provider management failed.', 'error');
        }
      }
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : 'Model Hub failed.', 'error');
    } finally {
      opening = false;
    }
  };

  const refresh = async (args: string, ctx: ExtensionContext) => {
    await service.sync(ctx);
    const rows = service.snapshot(ctx);
    const raw = args.trim();
    const ids = !raw || raw === 'all' ? rows.filter(row => row.dynamic && row.configured).map(row => row.id) : raw.split(/[\s,]+/).filter(Boolean);
    const unknown = ids.filter(id => !rows.some(row => row.id === id));
    if (unknown.length) {
      notify(ctx, `Unknown or hidden providers: ${unknown.join(', ')}`, 'error');
      return;
    }
    ctx.ui.setStatus('model-hub', `Refreshing ${ids.length} provider(s)…`);
    try {
      const summary = await service.refresh(ctx, ids, ctx.signal);
      const failed = summary.results.some(row => row.status === 'error' || row.status === 'cancelled');
      notify(ctx, refreshReport(summary), failed ? 'warning' : 'info');
    } finally {
      ctx.ui.setStatus('model-hub', undefined);
    }
  };

  const run = async (args: string, ctx: ExtensionContext) => {
    try {
      await service.sync(ctx);
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const target = rest[0];
      if (!action || action === 'hub') return await open(ctx, target);
      if (action === 'list') {
        const rows = service.snapshot(ctx);
        notify(ctx, rows.map(row => `${row.id} — ${row.models.length} models [${row.status}]${row.managed ? ' (channel)' : ''}${row.configured ? '' : ' — authentication required'}${row.message ? `\n  ${row.message}` : ''}`).join('\n') || 'No providers configured. Open /model-hub and press F2 to add one.', 'info');
        return;
      }
      if (action === 'refresh') return await refresh(rest.join(' '), ctx);
      if (action === 'add') {
        await configureChannel(ctx, service, target);
        return;
      }
      if (action === 'edit') {
        const channel = service.channels().find(row => row.id === target);
        if (!channel) throw new Error(`No managed channel ${target ?? ''}. Select one in /model-hub and press F3.`);
        await configureChannel(ctx, service, channel.id, channel);
        return;
      }
      if (action === 'remove') {
        const row = service.snapshot(ctx).find(row => row.id === target);
        if (!row) throw new Error(`No visible provider ${target ?? ''}.`);
        await removeProvider(ctx, service, row);
        return;
      }
      if (service.snapshot(ctx).some(row => row.id === action)) return await open(ctx, action);
      throw new Error(USAGE);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : 'Channel operation failed.', 'error');
    }
  };

  pi.registerCommand('model-hub', { description: 'Manage providers: F2 add, F3 edit, Delete remove, F5 refresh', handler: (args, ctx) => open(ctx, args.trim() || undefined) });
  pi.registerCommand('channels', { description: 'Manage configured providers and dynamically discover their models', handler: run });
  pi.registerCommand('models', { description: 'Alias for /channels (native /model is unchanged)', handler: run });
  pi.registerCommand('models-refresh', {
    description: 'Force model discovery for all visible configured providers or a comma-separated list',
    handler: async (args, ctx) => {
      try { await refresh(args, ctx); }
      catch (error) { notify(ctx, error instanceof Error ? error.message : 'Refresh failed.', 'error'); }
    },
  });
  pi.registerShortcut('alt+m', { description: 'Open multi-provider Model Hub', handler: ctx => open(ctx) });
  pi.registerShortcut('f5', {
    description: 'Force refresh current provider catalog',
    handler: async ctx => {
      try { await refresh(ctx.model?.provider ?? 'all', ctx); }
      catch (error) { notify(ctx, error instanceof Error ? error.message : 'Refresh failed.', 'error'); }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    try { await service.sync(ctx); }
    catch { notify(ctx, 'Model Hub config is invalid; existing providers were kept. Check omp-channels.json.', 'error'); }
  });
  pi.on('session_shutdown', () => service.dispose());
}
}

export default createProviderDeck();
