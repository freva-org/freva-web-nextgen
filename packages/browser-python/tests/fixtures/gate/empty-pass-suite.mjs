/**
 * A suite that claims a pass while having executed nothing - the fail-open shape. Catching a
 * launch failure, setting `status: "fail"`, then recomputing from an empty checks array gives a
 * pass, because `[].every(...)` is `true`: FAIL printed, "0/0 checks pass" printed, exit 0.
 * `report()` is the single authority that makes that impossible, asserted through a real exit.
 */
import { report } from "../../../browser-tests/harness.mjs";

process.exit(report("a suite that ran nothing", { status: "pass", checks: [] }));
