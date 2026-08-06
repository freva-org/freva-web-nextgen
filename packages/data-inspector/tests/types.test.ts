import { describe, it, expect } from "vitest";
import { NcDumpDialogState } from "../src/types";

describe("NcDumpDialogState", () => {
  it("has the expected string values", () => {
    expect(NcDumpDialogState.READY).toBe("ready");
    expect(NcDumpDialogState.LOADING).toBe("loading");
    expect(NcDumpDialogState.ERROR).toBe("error");
  });

  it("covers all three states", () => {
    const values = Object.values(NcDumpDialogState);
    expect(values).toHaveLength(3);
    expect(values).toContain("ready");
    expect(values).toContain("loading");
    expect(values).toContain("error");
  });
});
