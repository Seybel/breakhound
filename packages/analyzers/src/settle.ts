interface SettleProbe {
  pending: () => number;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Waits for layout plus everything the page does in response to a resize:
 * media query listeners, ResizeObservers, and debounced handlers whose timers
 * the engine's resize probe tracks. Gives up after `maxWaitMs`.
 */
export async function settleAfterResize(maxWaitMs: number): Promise<void> {
  await frame();
  await frame();
  const probe = (window as unknown as { __breakhound_settle?: SettleProbe }).__breakhound_settle;
  if (probe && probe.pending() > 0) {
    const deadline = performance.now() + maxWaitMs;
    while (probe.pending() > 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Let the re-render triggered by the handler reach layout.
    await frame();
    await frame();
  }
  window.scrollTo(0, 0);
}
