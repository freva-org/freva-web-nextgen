/**
 * The chat's own words in ClimateClaw's panel: @jupyter/chat's English strings, with its input's
 * placeholder ("Type a chat message, @ to mention...") replaced by ClimateClaw's. Passed to the
 * panel's ChatWidget as its translator; nothing else is translated or changed.
 */

import type { ChatWidget } from "@jupyter/chat";

type Translator = NonNullable<ConstructorParameters<typeof ChatWidget>[0]["translator"]>;

const CHAT_PLACEHOLDER = "Type a chat message, @ to mention...";
export const INPUT_PLACEHOLDER = "Ask ClimateClaw about this notebook or Freva data…";

/** gettext's `%1`, `%2` placeholders; `%%` is a percent sign. */
export function format(text: string, ...args: unknown[]): string {
  return text
    .replace(/%%/g, "%% ")
    .replace(/%(\d+)/g, (match, n: string) => {
      const value = args[Number(n) - 1];
      return value === undefined ? match : String(value);
    })
    .replace(/%% /g, "%");
}

export function chatTranslator(placeholder = INPUT_PLACEHOLDER): Translator {
  const n = (one: string, many: string, count: number, ...args: unknown[]) =>
    format(count === 1 ? one : many, count, ...args);
  const bundle = {
    __: (text: string, ...args: unknown[]) =>
      text === CHAT_PLACEHOLDER ? placeholder : format(text, ...args),
    _n: n,
    _p: (_context: string, text: string, ...args: unknown[]) => format(text, ...args),
    _np: (_context: string, one: string, many: string, count: number, ...args: unknown[]) =>
      n(one, many, count, ...args),
    gettext: (text: string, ...args: unknown[]) => format(text, ...args),
    ngettext: n,
    pgettext: (_context: string, text: string, ...args: unknown[]) => format(text, ...args),
    npgettext: (_context: string, one: string, many: string, count: number, ...args: unknown[]) =>
      n(one, many, count, ...args),
    dcnpgettext: (
      _domain: string,
      _context: string,
      one: string,
      many: string,
      count: number,
      ...args: unknown[]
    ) => n(one, many, count, ...args),
  };
  return { languageCode: "en", load: () => bundle } as unknown as Translator;
}
