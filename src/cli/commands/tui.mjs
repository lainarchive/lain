// `lain tui` — launch the live task dashboard
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain tui — the live task dashboard (M-9)

  lain tui
      Open the full-screen dashboard: the live task table and a scrolling
      event log, fed by the Core event bus. Keys: q quit, r refresh,
      up/down scroll the log. Needs a real terminal (TTY) — a piped
      invocation exits 4.
`;

/**
 * The @opentui/core import lives behind this dynamic import on purpose: every
 * other CLI path stays free of the Zig FFI and its experimental warning.
 *
 * @param {{ command?: string, positional: string[], flags: Record<string, string | boolean>, io: { out: (line: string) => void, err: (line: string) => void } }} args
 * @returns {Promise<number>}
 */
export async function tuiCommand({ command, positional, io }) {
  if (command !== undefined || positional.length > 0) {
    io.err(USAGE);
    return EXIT.usage;
  }
  try {
    const { launchLainTui } = await import('../../ui/main.mjs');
    await launchLainTui();
    return EXIT.ok;
  } catch (err) {
    const e = /** @type {Error & {code?: string}} */ (err);
    if (e.name === 'TuiError') {
      io.err(`failed: ${e.message}`);
      return EXIT.failed;
    }
    throw err;
  }
}
