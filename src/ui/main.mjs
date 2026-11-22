// `lain tui` entry point — the OpenTUI screen, the dashboard mount, and the key bindings
import { createCliRenderer } from '@opentui/core';
import { handleDashboardKey, mountDashboard } from './dashboard.mjs';

export class TuiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'TuiError';
    this.code = code;
  }
}

/**
 * Launch the dashboard on the current terminal and block until the user quits
 * with `q` (or Ctrl-C). Refuses a non-TTY stream pair: the renderer is a
 * full-screen terminal application, and a piped invocation would either hang
 * waiting for input or scribble escape sequences into a log.
 *
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 *   injectable so the non-TTY refusal is testable without a terminal
 * @returns {Promise<void>}
 */
export async function launchLainTui(streams = {}) {
  const stdin = /** @type {NodeJS.ReadStream} */ (streams.stdin ?? process.stdin);
  const stdout = /** @type {NodeJS.WriteStream} */ (streams.stdout ?? process.stdout);
  const isTTY = (/** @type {{ isTTY?: boolean }} */ stream) =>
    typeof stream.isTTY === 'boolean' ? stream.isTTY : process.platform === 'win32';
  if (process.env.FORCE_TUI_TTY !== '1' && (!isTTY(stdin) || !isTTY(stdout))) {
    throw new TuiError('TUI_REQUIRES_TTY', 'lain tui needs a real terminal; a pipe has no screen to paint');
  }
  // exitOnCtrlC: false — Ctrl-C is the dashboard's quit key, handled through
  // the key handler, not a renderer shortcut that skips the dispose path.
  const renderer = await createCliRenderer({ stdin, stdout, exitOnCtrlC: false });
  const view = mountDashboard(renderer);
  /** @type {() => void} */
  let requestQuit = () => {};
  const quit = /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      requestQuit = () => resolve();
    })
  );
  renderer.keyInput.on('keypress', (/** @type {import('@opentui/core').KeyEvent} */ key) => {
    handleDashboardKey(key, view, { quit: requestQuit });
  });
  renderer.requestRender();
  await quit;
  view.dispose();
  renderer.destroy();
  // The renderer writes its teardown into stdout; awaiting `closed` keeps the
  // process from tearing the terminal down mid-write.
  await renderer.closed;
}
