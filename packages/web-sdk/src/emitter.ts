/** Minimal typed event emitter (no Node dependencies). */
export type Listener<T> = (payload: T) => void;

export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    (this.listeners[event] ??= new Set()).add(listener);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapped: Listener<Events[K]> = (payload) => {
      this.off(event, wrapped);
      listener(payload);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this.listeners[event]?.delete(listener);
    return this;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) this.listeners = {};
    else delete this.listeners[event];
    return this;
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (err) {
        // A throwing listener must not break the SDK's internal flow.
        console.error(`[call-lagao] listener for "${String(event)}" threw`, err);
      }
    }
  }
}
