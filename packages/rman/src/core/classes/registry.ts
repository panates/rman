/**
 * An ordered collection of contributions, held **on the application** rather than in a module.
 *
 * Every registry rman had was a module-level array (`const providers: Provider[] = []` in
 * `manifest.ts`, `workspace.ts`, `bin-path.ts`, `run.service.ts`), which made it process-global:
 * two repositories in one process shared it. The test suite needed a root hook emptying five of
 * them before every single test, and without it whichever spec ran first decided the answer for
 * the rest - so the core appeared to work in tests that had registered nothing.
 *
 * An instance per `RmanApplication` closes the whole class: a new application starts empty, and
 * nothing has to be cleaned up afterwards - the root hook is deleted.
 *
 * **Registry, not service.** The distinction is multiplicity: a registry is for a question whose
 * answer is the *sum* of what was contributed (every provider's bin directories, the first provider
 * that recognizes a directory). A question with exactly one answer is a service, replaceable
 * through `RmanApplication.getService`.
 */
export class Registry<T> implements Iterable<T> {
  private readonly items: T[] = [];

  /** Contributions in registration order, which for a plugin is `plugins` declaration order. */
  get all(): readonly T[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** Idempotent by identity: a plugin may both declare a contribution and register it itself, and
   *  the same function arriving twice would make the registry lie about what is in it. */
  add(item: T): this {
    if (!this.items.includes(item)) this.items.push(item);
    return this;
  }

  /** The first contribution `ask` gives an answer for - "first that recognizes it" resolution,
   *  which is how a directory finds the manifest reader and the workspace layout that claim it. */
  first<R>(ask: (item: T) => R | undefined): R | undefined {
    for (const item of this.items) {
      const answer = ask(item);
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }
}
