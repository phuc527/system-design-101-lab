import { ServiceUnavailableError } from "../utils/errors.js";

/**
 * CAP theorem simulator: two replicas (A and B) of a key-value store
 * living inside this one process, connected by a pretend network link.
 *
 *   C - Consistency:        every read sees the latest write
 *   A - Availability:       every request gets a (non-error) response
 *   P - Partition tolerance: the system keeps running when nodes can't talk
 *
 * Networks DO partition, so P is not optional. When the link between A and B
 * is cut you must choose:
 *
 *   CP mode -> refuse requests (HTTP 503) so nobody ever reads stale data
 *   AP mode -> keep answering, accept that A and B temporarily disagree
 *
 * When the partition heals, AP mode reconciles with Last-Write-Wins (LWW):
 * the write with the highest version survives, the other is silently LOST.
 *
 * Simplification: real CP systems use a majority quorum (e.g. 2 of 3 nodes),
 * so the majority side keeps working. With only 2 nodes there is no majority,
 * so in CP mode both sides refuse.
 */

export type NodeId = "A" | "B";
export type ConsistencyMode = "CP" | "AP";

export const NODE_IDS: readonly NodeId[] = ["A", "B"];

export function isNodeId(v: unknown): v is NodeId {
  return v === "A" || v === "B";
}

export function isConsistencyMode(v: unknown): v is ConsistencyMode {
  return v === "CP" || v === "AP";
}

export interface VersionedValue {
  value: string;
  version: number;
  writtenVia: NodeId;
}

export interface WriteResult {
  key: string;
  value: string;
  version: number;
  writtenVia: NodeId;
  replicatedTo: NodeId[];
  warning?: string;
}

export interface ReadResult {
  key: string;
  readFrom: NodeId;
  value: string | null;
  version: number | null;
  possiblyStale: boolean;
}

export interface Conflict {
  key: string;
  kept: VersionedValue;
  discarded: VersionedValue;
}

export interface CapState {
  mode: ConsistencyMode;
  partitioned: boolean;
  nodes: Record<NodeId, Record<string, VersionedValue>>;
  divergentKeys: string[];
}

export class CapCluster {
  private mode: ConsistencyMode = "CP";
  private partitioned = false;
  private clock = 0;
  private readonly stores: Record<NodeId, Map<string, VersionedValue>> = {
    A: new Map(),
    B: new Map(),
  };

  setMode(mode: ConsistencyMode): CapState {
    this.mode = mode;
    return this.state();
  }

  /** Cut the link. Returns the new state. */
  partition(): CapState {
    this.partitioned = true;
    return this.state();
  }

  /** Restore the link and reconcile divergent replicas with Last-Write-Wins. */
  heal(): { state: CapState; conflicts: Conflict[] } {
    this.partitioned = false;
    const conflicts: Conflict[] = [];
    const keys = new Set([...this.stores.A.keys(), ...this.stores.B.keys()]);

    for (const key of keys) {
      const a = this.stores.A.get(key);
      const b = this.stores.B.get(key);
      if (a && b && a.version === b.version) continue;

      const winner = !a ? b : !b ? a : a.version > b.version ? a : b;
      const loser = a && b ? (winner === a ? b : a) : undefined;
      if (!winner) continue;

      this.stores.A.set(key, winner);
      this.stores.B.set(key, winner);
      if (loser) conflicts.push({ key, kept: winner, discarded: loser });
    }
    return { state: this.state(), conflicts };
  }

  write(via: NodeId, key: string, value: string): WriteResult {
    if (this.partitioned && this.mode === "CP") {
      throw new ServiceUnavailableError(
        `CP mode: node ${via} cannot reach its peer, refusing the write to stay consistent`,
      );
    }

    const entry: VersionedValue = { value, version: ++this.clock, writtenVia: via };

    if (!this.partitioned) {
      // Healthy network: synchronous replication to both nodes.
      this.stores.A.set(key, entry);
      this.stores.B.set(key, entry);
      return { key, ...entry, replicatedTo: ["A", "B"] };
    }

    // AP mode + partition: accept locally, the other node never hears about it (yet).
    this.stores[via].set(key, entry);
    return {
      key,
      ...entry,
      replicatedTo: [via],
      warning: "AP mode: accepted locally only - the other node is unreachable and now has different data",
    };
  }

  read(from: NodeId, key: string): ReadResult {
    if (this.partitioned && this.mode === "CP") {
      throw new ServiceUnavailableError(
        `CP mode: node ${from} cannot confirm it has the latest value, refusing the read`,
      );
    }
    const entry = this.stores[from].get(key);
    return {
      key,
      readFrom: from,
      value: entry?.value ?? null,
      version: entry?.version ?? null,
      possiblyStale: this.partitioned,
    };
  }

  state(): CapState {
    const dump = (id: NodeId): Record<string, VersionedValue> => Object.fromEntries(this.stores[id]);
    const keys = new Set([...this.stores.A.keys(), ...this.stores.B.keys()]);
    const divergentKeys = [...keys].filter(
      (k) => this.stores.A.get(k)?.version !== this.stores.B.get(k)?.version,
    );
    return {
      mode: this.mode,
      partitioned: this.partitioned,
      nodes: { A: dump("A"), B: dump("B") },
      divergentKeys,
    };
  }

  reset(): CapState {
    this.mode = "CP";
    this.partitioned = false;
    this.clock = 0;
    this.stores.A.clear();
    this.stores.B.clear();
    return this.state();
  }
}
