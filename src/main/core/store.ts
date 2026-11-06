// App state: one JSON file in the app's data folder, written atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { State } from "../../shared/types.ts";

export class Store {
  private state: State;
  private listeners = new Set<(s: State) => void>();

  private file: string;

  constructor(file: string) {
    this.file = file;
    this.state = Store.load(file);
  }

  private static load(file: string): State {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
      // Chats and comments from before features (per workspace) are left behind.
      return {
        features: s.features ?? [],
        chats: (s.chats ?? []).filter((c) => c.featureId),
        comments: (s.comments ?? []).filter((c) => c.featureId),
      };
    } catch {
      return { features: [], chats: [], comments: [] };
    }
  }

  get(): State {
    return this.state;
  }

  update(fn: (s: State) => State): State {
    this.state = fn(this.state);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
    for (const l of this.listeners) l(this.state);
    return this.state;
  }

  subscribe(listener: (s: State) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
