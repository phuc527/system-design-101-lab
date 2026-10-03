import { beforeEach, describe, expect, it } from "vitest";
import { CapCluster } from "../src/services/cap.service.js";
import { ServiceUnavailableError } from "../src/utils/errors.js";

describe("CapCluster", () => {
  let cap: CapCluster;

  beforeEach(() => {
    cap = new CapCluster();
  });

  it("replicates writes to both nodes when the network is healthy", () => {
    const result = cap.write("A", "balance", "100");
    expect(result.replicatedTo).toEqual(["A", "B"]);
    expect(cap.read("B", "balance").value).toBe("100");
    expect(cap.state().divergentKeys).toEqual([]);
  });

  describe("CP mode during a partition", () => {
    it("refuses writes and reads (chooses Consistency over Availability)", () => {
      cap.write("A", "balance", "100");
      cap.partition();
      expect(() => cap.write("A", "balance", "200")).toThrow(ServiceUnavailableError);
      expect(() => cap.read("B", "balance")).toThrow(ServiceUnavailableError);
    });

    it("works again after the partition heals, with no data lost", () => {
      cap.write("A", "balance", "100");
      cap.partition();
      const { conflicts } = cap.heal();
      expect(conflicts).toEqual([]);
      expect(cap.read("B", "balance").value).toBe("100");
    });
  });

  describe("AP mode during a partition", () => {
    beforeEach(() => {
      cap.setMode("AP");
      cap.write("A", "balance", "100");
      cap.partition();
    });

    it("keeps answering, but replicas diverge (stale reads)", () => {
      const write = cap.write("A", "balance", "200");
      expect(write.replicatedTo).toEqual(["A"]);
      expect(write.warning).toBeDefined();

      const staleRead = cap.read("B", "balance");
      expect(staleRead.value).toBe("100");
      expect(staleRead.possiblyStale).toBe(true);
      expect(cap.state().divergentKeys).toEqual(["balance"]);
    });

    it("heals with Last-Write-Wins and reports the discarded write", () => {
      cap.write("A", "balance", "200"); // version 2
      cap.write("B", "balance", "50"); //  version 3 - written later, wins

      const { state, conflicts } = cap.heal();
      expect(state.divergentKeys).toEqual([]);
      expect(cap.read("A", "balance").value).toBe("50");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.discarded.value).toBe("200");
    });

    it("copies keys that only exist on one side", () => {
      cap.write("B", "newKey", "x");
      const { conflicts } = cap.heal();
      expect(conflicts).toEqual([]);
      expect(cap.read("A", "newKey").value).toBe("x");
    });
  });
});
