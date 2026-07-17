export type DisplayTargetSelectorT = {
  deviceName: string;
};

class DisplayTargetRegistry {
  private readonly selectors = new Map<string, DisplayTargetSelectorT>();

  replace(entries: Array<[string, DisplayTargetSelectorT]>): void {
    this.selectors.clear();
    for (const [portId, selector] of entries) {
      this.selectors.set(portId, selector);
    }
  }

  resolve(portId: string): DisplayTargetSelectorT | null {
    return this.selectors.get(portId) ?? null;
  }

  clear(): void {
    this.selectors.clear();
  }
}

export const displayTargetRegistry = new DisplayTargetRegistry();
