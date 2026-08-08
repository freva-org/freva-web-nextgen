// index.ts - the public surface of @freva-org/freva-client-terminal.

export { createTerminal, TERM_THEMES } from "./terminal.js";
export { wrapPlan } from "./wrap.js";
export type { WrapPlan } from "./wrap.js";
export { supportsPlaintextOnly } from "./editor.js";
export { STYLES } from "./styles.js";
export type {
  SegmentKind,
  TerminalCompletion,
  TerminalCompletionItem,
  TerminalHandle,
  TerminalMenuItem,
  TerminalOptions,
  TerminalSegment,
  TerminalStorage,
  TerminalTab,
} from "./types.js";
