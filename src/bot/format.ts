// HTML formatting helpers for Telegram messages (menu, item table, cart summary).
// Filled in during Phase 3/5 once real session state shapes exist.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
