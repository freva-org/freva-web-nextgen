// ClimateClaw at work: one mark per phase beside what it is doing.
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusyLine } from "../src/busy-line.js";

type Node = React.ReactElement<{ className?: string; children?: unknown }>;
const mark = (phase: string, inline = false): Node =>
  (
    (BusyLine({ label: "x", phase, since: null, tier: "wide", inline }) as Node).props
      .children as Node[]
  )[0];

describe("the busy line's mark", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("thinking: the bird; writing code: typed lines; running: DKRZ's logo", () => {
    expect(mark("thinking").props.className).toBe("jp-ClimateClaw-busy-bird");
    expect(mark("thinking", true).props.className).toBe("jp-ClimateClaw-busy-wave");
    expect(mark("coding").props.className).toBe("jp-ClimateClaw-busy-code");
    expect(mark("running").props.className).toBe("jp-ClimateClaw-busy-dkrz");
  });

  it("drawing a figure: a curve plotted on small axes, its pen moving along it", () => {
    const plot = mark("figure");
    expect(plot.props.className).toBe("jp-ClimateClaw-busy-plot");
    const [axes, curve, pen] = plot.props.children as Node[];
    expect(axes.props.className).toBe("jp-ClimateClaw-busy-plotAxes");
    expect(curve.props.className).toBe("jp-ClimateClaw-busy-plotCurve");
    const motion = (pen.props.children as Node).props as { path?: string };
    expect(motion.path).toBe((curve.props as { d?: string }).d);
    expect(mark("figure", true).props.className).toBe("jp-ClimateClaw-busy-plot");
  });

  it("with less motion, the pen rests at the curve's end", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const [, , pen] = mark("figure").props.children as Node[];
    expect(pen.props.children).toBeNull();
    expect(pen.props).toMatchObject({ cx: 22.5, cy: 3 });
  });
});
