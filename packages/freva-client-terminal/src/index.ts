// index.ts - the public surface of @freva-org/freva-client-terminal.

export { createTerminal } from "./terminal.js";
// The window itself, without a freva-client tab strip in it. Exported so a host that needs THIS
// window around content of its own - a Python console, a log viewer - reuses the frame instead of
// drawing a second one that has to be kept looking like it.
export { createTerminalWindow, TERM_THEMES } from "./window.js";
export { wrapPlan } from "./wrap.js";
export type { WrapPlan } from "./wrap.js";
export { supportsPlaintextOnly } from "./editor.js";
export { STYLES } from "./styles.js";
export type {
  SegmentKind,
  TerminalConfirmRequest,
  TerminalCompletion,
  TerminalCompletionItem,
  TerminalHandle,
  TerminalMenuItem,
  TerminalMenuSection,
  TerminalOptions,
  TerminalSegment,
  TerminalStorage,
  TerminalTab,
  TerminalWindowHandle,
  TerminalWindowOptions,
} from "./types.js";
