/**
 * @freva-org/browser-python/console - the batteries-included console.
 *
 * Importing THIS module pulls in jQuery, jQuery Terminal and Prism; importing the root package
 * does not, and a test asserts it - a host embedding only the headless engine pays none of the
 * console's weight. Safe to import during server-side rendering: it defines classes and constants
 * but registers nothing and touches no global. `./auto` is the browser-only half.
 */

export {
  BrowserPythonConsole,
  defineBrowserPythonConsole,
  DEFAULT_TAG_NAME,
} from "./browser-python-console.js";

export { HistoryStore, historyStorageKey, HISTORY_KEY_PREFIX } from "./history-store.js";
export {
  registerDisplayRenderer,
  registeredDisplayMimes,
  displayRendererFor,
} from "./display-renderers.js";
export { DEFAULT_BANNER } from "./console-types.js";

export type {
  BrowserPythonConsoleElement,
  ConsoleDisplayOutput,
  ConsoleHighlightOptions,
  ConsoleHistoryOptions,
  ConsoleOutputOptions,
  ConsoleSurfaceAdapter,
  ConsoleTextOutput,
  ConsoleTheme,
  ConsoleToolbarMode,
  DisplayRenderer,
  HistoryPersistence,
} from "./console-types.js";
