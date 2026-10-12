import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

/** Notifications allow line breaks, never terminal escape/control sequences. */
export function notify(ctx: ExtensionContext, message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  const safe = stripTerminalSequences(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  ctx.ui.notify(safe, type);
}
