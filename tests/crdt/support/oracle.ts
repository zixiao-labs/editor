import type { SpecTransaction } from "./replica.js";

// A declaration-based, factorial oracle for tiny empty-base insertion histories.
// Does NOT inspect parent/side or call the model's traversal/sibling comparator.
export function oracleOrder(history: readonly SpecTransaction[]): readonly string[] {
  const elements = history.flatMap((tx) => tx.inserts);
  if (elements.length > 7) throw new Error("oracle supports at most seven elements");
  const byId = new Map(elements.map((node) => [node.id, node]));
  const prior = new Map<string, Set<string>>();
  for (const tx of history) {
    const external = history.filter((other) => tx.depends.includes(other.id))
      .flatMap((other) => other.inserts.map((node) => node.id));
    tx.inserts.forEach((node, index) => {
      prior.set(node.id, new Set([...external, ...tx.inserts.slice(0, index).map((n) => n.id)]));
    });
  }
  const closed: Set<string>[] = [];
  for (let mask = 0; mask < 2 ** elements.length; mask++) {
    const subset = new Set(elements.filter((_, i) => mask & (1 << i)).map((node) => node.id));
    if ([...subset].every((id) => [...prior.get(id)!].every((p) => subset.has(p)))) closed.push(subset);
  }
  const descendant = (id: string, ancestor: string): boolean => {
    while (id !== "^") {
      if (id === ancestor) return true;
      const node = byId.get(id);
      if (!node) throw new Error("oracle expects an empty base");
      id = node.left;
    }
    return ancestor === "^";
  };
  const solutions: string[][] = [];
  const satisfies = (order: string[]): boolean => {
    const rank = (id: string, local: string[]) => id === "^" ? -1 :
      id === "$" ? local.length : local.indexOf(id);
    for (const node of elements) {
      if (!(rank(node.left, order) < rank(node.id, order) &&
        rank(node.id, order) < rank(node.right, order))) return false;
      for (const other of elements) {
        if (node.left === other.left && node.right === other.right &&
          node.id < other.id && rank(node.id, order) >= rank(other.id, order)) return false;
      }
    }
    for (const subset of closed) {
      const local = order.filter((id) => subset.has(id));
      for (const id of local) {
        const node = byId.get(id)!;
        const firstWithLeft = local.find((other) => byId.get(other)!.left === node.left);
        if (node.left !== "^" && firstWithLeft === id &&
          rank(id, local) !== rank(node.left, local) + 1) return false;
        const sameRight = local.filter((other) => byId.get(other)!.right === node.right);
        if (node.right !== "$" && sameRight[sameRight.length - 1] === id) {
          const right = byId.get(node.right)!;
          const exception = node.left !== right.left && local.some((c) =>
            rank(node.left, local) < rank(c, local) && rank(c, local) < rank(right.id, local) &&
            !descendant(c, node.left));
          if (!exception && rank(node.right, local) !== rank(id, local) + 1) return false;
        }
      }
    }
    return true;
  };
  const enumerate = (prefix: string[], remaining: string[]) => {
    if (!remaining.length) {
      if (satisfies(prefix)) solutions.push(prefix);
      return;
    }
    for (const id of remaining) {
      enumerate([...prefix, id], remaining.filter((other) => id !== other));
    }
  };
  enumerate([], elements.map((node) => node.id));
  if (solutions.length !== 1) throw new Error(`oracle expected unique order; got ${solutions.length}`);
  return Object.freeze(solutions[0]!);
}

// Removes a transaction and its causal descendants, never a dangling dependency.
// Greedy 1-minimal reduction, not a promise of a globally shortest counterexample.
export function minimizeHistory(
  history: readonly SpecTransaction[],
  fails: (history: readonly SpecTransaction[]) => boolean,
): readonly SpecTransaction[] {
  let current = [...history];
  for (;;) {
    let reduced = false;
    for (const tx of current) {
      const removed = new Set([tx.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of current) {
          if (!removed.has(item.id) && item.depends.some((id) => removed.has(id))) {
            removed.add(item.id);
            changed = true;
          }
        }
      }
      const candidate = current.filter((item) => !removed.has(item.id));
      if (fails(candidate)) {
        current = candidate;
        reduced = true;
        break;
      }
    }
    if (!reduced) return Object.freeze(current);
  }
}
