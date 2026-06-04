import type { ProcessTracker } from './index.js';

export async function runStartupDiscovery(tracker: ProcessTracker): Promise<void> {
  await tracker.tickOnce();
  await tracker.maybeSweepPorts();
}
