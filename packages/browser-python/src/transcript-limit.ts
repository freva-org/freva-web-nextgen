/**
 * How much transcript this package will ever hold, or hand to anyone. ONE NUMBER, in a module of
 * its own, because three places need it and must not drift: the console's output pruning, the embed
 * protocol bounding what a playground may send its parent, and any host deciding how much it will
 * receive. It sits in the package ROOT so importing it does not pull jQuery Terminal and Prism in.
 *
 * 2,000,000 characters is roughly 2 MB of UTF-8: large enough that no real session is truncated,
 * small enough that a runaway loop cannot exhaust a tab through the transcript alone.
 */
export const MAX_TRANSCRIPT_CHARS = 2_000_000;
