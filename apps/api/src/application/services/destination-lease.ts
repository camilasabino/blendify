export type DestinationLeaseEvent = 'lease_lost' | 'lease_renew_failed';

export interface DestinationLeaseStore {
  renew(ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
}

export interface DestinationLeasePolicy {
  leaseMs: number;
  renewIntervalMs: number;
}

export class DestinationLease {
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  private lost = false;

  constructor(
    private readonly store: DestinationLeaseStore,
    private readonly policy: DestinationLeasePolicy,
    private readonly onEvent: (event: DestinationLeaseEvent) => void,
  ) {
    this.timer = setInterval(() => void this.renew(), policy.renewIntervalMs);
    this.timer.unref();
  }

  get isLost(): boolean {
    return this.lost;
  }

  async release(): Promise<void> {
    this.stop();
    await this.store.release();
  }

  private stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private async renew(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const renewed = await this.store.renew(this.policy.leaseMs);
      if (renewed || this.stopped) {
        return;
      }
      this.lost = true;
      this.stop();
      this.onEvent('lease_lost');
    } catch {
      this.onEvent('lease_renew_failed');
    }
  }
}
