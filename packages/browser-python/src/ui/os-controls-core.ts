// Which window controls `osControls: auto` draws. Kept apart from the playground so it can be
// tested without a DOM.

export type OsControls = "mac" | "windows" | "linux";

interface NavLike {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

export function osControlsFor(configured: OsControls | "auto", nav?: NavLike): OsControls {
  if (configured !== "auto") return configured;
  const n = nav ?? (typeof navigator !== "undefined" ? (navigator as unknown as NavLike) : {});
  for (const hint of [n.userAgentData?.platform, n.platform, n.userAgent]) {
    const p = (hint ?? "").toLowerCase();
    if (!p) continue;
    if (p.includes("win")) return "windows";
    if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
    if (p.includes("linux") || p.includes("x11") || p.includes("android") || p.includes("cros"))
      return "linux";
  }
  return "linux";
}
