// icons.ts - COMPILE-TIME-CONSTANT svg path markup. These strings are the only values ever passed
// to svgIcon(), which assigns them with innerHTML. Never put data-derived text in here.

export const ICONS = {
  kebab:
    '<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M7 9l3 3-3 3M12.5 15h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
} as const;

export type IconName = keyof typeof ICONS;
