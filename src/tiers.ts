import type { ContainerTier } from "../imgt.config";
import { MAX_SOURCE_BYTES } from "./constants";

export type ContainerRole = "primary" | "overflow";

export function validateTier(name: string, tier: ContainerTier): void {
  if (!Number.isInteger(tier.vcpu) || tier.vcpu < 1 || tier.vcpu > 4)
    throw new Error(`containers.${name}.vcpu must be an integer from 1 to 4`);
}

// Cloudflare custom allocations require at least 3 GiB per vCPU.
export function containerResources(vcpu: number) {
  return { vcpu, memoryMib: 3072 * vcpu, diskMb: 2000 };
}

// One encoder per vCPU, plus two buffered uploads each so the next input is
// ready when an encoder finishes.
export function transformSlots(vcpu: number): number {
  return 3 * vcpu;
}

// Buffered inputs share this budget, leaving room in each 3 GiB for decoding.
export function bufferedSourceBytes(vcpu: number): number {
  return Math.max(vcpu * 1024 * 1024 * 1024, MAX_SOURCE_BYTES);
}

export interface TierLease {
  tier: ContainerRole;
  waitedMs: number;
  release(): void;
}

interface Waiter {
  queuedAt: number;
  grant(lease: TierLease): void;
}

interface OverflowOptions {
  slots: number;
  wakeAtQueuedJobs: number;
  idleTimeoutMs: number;
  // Resolves once the overflow container passes its health check.
  wake: () => Promise<void>;
}

const WAKE_RETRY_MS = 5000;

// Sends transforms to the always-on primary first. When enough jobs wait for
// it, starts the overflow container and also uses it until it goes idle.
export class TierDispatcher {
  readonly #active = { primary: 0, overflow: 0 };
  readonly #waiting: Waiter[] = [];
  #overflow: "asleep" | "waking" | "awake" = "asleep";
  #lastOverflowUse = 0;
  #retryWakeAt = 0;

  constructor(
    private readonly options: {
      primarySlots: number;
      overflow?: OverflowOptions | null;
      now?: () => number;
    },
  ) {
    const { overflow } = options;
    if (
      overflow &&
      (!Number.isInteger(overflow.wakeAtQueuedJobs) ||
        overflow.wakeAtQueuedJobs < 1)
    )
      throw new Error(
        "containers.overflow.wakeAtQueuedJobs must be a positive integer",
      );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  get overflowState(): "asleep" | "waking" | "awake" {
    this.overflowAvailable();
    return this.#overflow;
  }

  acquire(signal: AbortSignal): Promise<TierLease> {
    signal.throwIfAborted();
    const queuedAt = this.now();
    if (this.#waiting.length === 0) {
      const lease = this.take(queuedAt);
      if (lease) return Promise.resolve(lease);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        queuedAt,
        grant: (lease) => {
          signal.removeEventListener("abort", cancel);
          resolve(lease);
        },
      };
      const cancel = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.#waiting.push(waiter);
      this.maybeWake();
    });
  }

  // The overflow stops itself after its idle timeout. Treat it as asleep a
  // little early: a spare wake is cheap, a job sent to a stopped container
  // waits for its cold start.
  private overflowAvailable(): boolean {
    const overflow = this.options.overflow;
    if (!overflow || this.#overflow !== "awake") return false;
    if (this.#active.overflow > 0) return true;
    const margin = Math.min(5000, overflow.idleTimeoutMs / 2);
    if (this.now() - this.#lastOverflowUse < overflow.idleTimeoutMs - margin)
      return true;
    this.#overflow = "asleep";
    console.log(JSON.stringify({ event: "overflow_assumed_idle" }));
    return false;
  }

  private take(queuedAt: number): TierLease | undefined {
    let tier: ContainerRole;
    if (this.#active.primary < this.options.primarySlots) tier = "primary";
    else if (
      this.overflowAvailable() &&
      this.#active.overflow < this.options.overflow!.slots
    )
      tier = "overflow";
    else return undefined;
    this.#active[tier] += 1;
    if (tier === "overflow") this.#lastOverflowUse = this.now();
    let released = false;
    return {
      tier,
      waitedMs: this.now() - queuedAt,
      release: () => {
        if (released) return;
        released = true;
        this.#active[tier] -= 1;
        if (tier === "overflow") this.#lastOverflowUse = this.now();
        this.pump();
      },
    };
  }

  private pump(): void {
    while (this.#waiting.length > 0) {
      const lease = this.take(this.#waiting[0]!.queuedAt);
      if (!lease) break;
      this.#waiting.shift()!.grant(lease);
    }
  }

  private maybeWake(): void {
    const overflow = this.options.overflow;
    if (
      !overflow ||
      this.#overflow === "waking" ||
      this.overflowAvailable() ||
      this.#waiting.length < overflow.wakeAtQueuedJobs ||
      this.now() < this.#retryWakeAt
    )
      return;
    this.#overflow = "waking";
    const started = this.now();
    console.log(
      JSON.stringify({ event: "overflow_wake", waiting: this.#waiting.length }),
    );
    void Promise.resolve()
      .then(overflow.wake)
      .then(
        () => {
          this.#overflow = "awake";
          this.#lastOverflowUse = this.now();
          console.log(
            JSON.stringify({
              event: "overflow_ready",
              durationMs: this.now() - started,
              waiting: this.#waiting.length,
            }),
          );
          this.pump();
        },
        (error) => {
          this.#overflow = "asleep";
          this.#retryWakeAt = this.now() + WAKE_RETRY_MS;
          console.error(
            JSON.stringify({
              event: "overflow_wake_failed",
              durationMs: this.now() - started,
              error: String(error),
            }),
          );
        },
      );
  }
}
