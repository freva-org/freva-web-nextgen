// components/autocomplete.ts - the shared item shape for the terminal's autocomplete list. The
// terminal computes the items (keys, or values-with-counts) and owns the menu/positioning itself
// (see terminal.ts showMenu); this module carries only the type they agree on.

export interface AcItem {
  value: string;
  count: number | null;
}
