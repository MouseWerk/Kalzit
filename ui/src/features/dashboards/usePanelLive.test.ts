import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { QueryOutcome } from "../../api/generated/shapes";
import type { TargetOutcome } from "./results";
import { writeLiveResult } from "./usePanelLive";

function frame(value: string): Record<string, QueryOutcome> {
  return {
    A: {
      result: {
        shape: "frame",
        frame: { fields: [{ name: "v", type: "string", values: [value] }] },
      },
    },
  };
}

describe("writeLiveResult", () => {
  it("is not overwritten by a request that was still on its way when the push came", async () => {
    const client = new QueryClient();
    const key = ["panel-data", "o1", "d", "p1", "stored", 0, 1, {}, ["A"], 0];
    let answer: (value: TargetOutcome[]) => void = () => undefined;
    const fetching = client
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<TargetOutcome[]>((resolve) => {
            answer = resolve;
          }),
      })
      .catch(() => undefined);
    await writeLiveResult(client, key, frame("pushed"), ["A"]);
    // The older answer arrives after the push and is dropped.
    answer([{ refId: "A", result: { shape: "frame", frame: { fields: [] } } }]);
    await fetching;
    const data = client.getQueryData<TargetOutcome[]>(key);
    expect(data?.[0]).toMatchObject({
      refId: "A",
      result: { frame: { fields: [{ values: ["pushed"] }] } },
    });
  });
});
