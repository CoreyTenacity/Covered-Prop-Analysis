import type { PickRecord, PickResult } from "@/lib/types";

export function describeGradingResult(actualValue: number, line: number, direction: PickRecord["direction"], result: PickResult) {
  const side = direction === "More" ? "over" : "under";
  if (result === "push") return `Final result: push at ${actualValue} against the ${line} line.`;
  return result === "hit"
    ? `Final result: hit — ${actualValue} cleared the ${line} line on the ${side} side.`
    : `Final result: miss — ${actualValue} stayed on the wrong side of the ${line} line for the ${side} side.`;
}

