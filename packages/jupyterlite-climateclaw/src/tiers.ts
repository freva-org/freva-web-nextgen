// How much the chat's controls show for the room they have.

/**
 * How much room the composer's toolbar has. Wide: full labels. Medium: short labels, the code
 * toggle as an icon. Narrow: icons only; the tooltips keep the words.
 */
export type Tier = "wide" | "medium" | "narrow";

export function tierFor(width: number): Tier {
  return width >= 430 ? "wide" : width >= 300 ? "medium" : "narrow";
}

/**
 * What the chip shows for the header's width: host and model, the model, or the logo alone (the
 * tooltip always has both). In the header's "More commands" popup it has room for both.
 */
export type ChipTier = "full" | "model" | "logo";

export function chipTierFor(headerWidth: number, inPopup: boolean): ChipTier {
  if (inPopup) return "full";
  return headerWidth >= 480 ? "full" : headerWidth >= 330 ? "model" : "logo";
}
