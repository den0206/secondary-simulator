import * as crypto from 'crypto';

export class FrameBuffer {
  private lastHash: string = '';
  private consecutiveNoChanges: number = 0;
  private baseInterval: number;
  private currentInterval: number;

  constructor(baseInterval: number = 500) {
    this.baseInterval = baseInterval;
    this.currentInterval = baseInterval;
  }

  shouldSendFrame(frame: Buffer): boolean {
    const newHash = crypto.createHash('md5').update(frame).digest('hex');

    if (newHash === this.lastHash) {
      this.consecutiveNoChanges++;
      return false;
    }

    this.lastHash = newHash;
    this.consecutiveNoChanges = 0;
    return true;
  }

  getAdaptiveInterval(adaptiveEnabled: boolean): number {
    if (!adaptiveEnabled) {
      return this.baseInterval;
    }

    if (this.consecutiveNoChanges > 10) {
      this.currentInterval = Math.min(this.currentInterval * 1.3, 3000);
    } else if (this.consecutiveNoChanges === 0) {
      this.currentInterval = this.baseInterval;
    }

    return Math.round(this.currentInterval);
  }

  reset(): void {
    this.lastHash = '';
    this.consecutiveNoChanges = 0;
    this.currentInterval = this.baseInterval;
  }

  setBaseInterval(interval: number): void {
    this.baseInterval = interval;
    if (this.currentInterval < interval) {
      this.currentInterval = interval;
    }
  }
}
