// Deliberately slow, test-only specification model. Never import this from src.
// Full dependency sets and short IDs are NOT a proposed public wire format.
export interface SpecNode {
  readonly id: string;
  readonly value: string;
  readonly parent: string;
  readonly side: "L" | "R";
  readonly left: string;
  readonly right: string;
  readonly creator: string;
}

export interface SpecTransaction {
  readonly id: string;
  readonly base: string;
  readonly depends: readonly string[];
  readonly inserts: readonly SpecNode[];
  readonly deletes: readonly string[];
  readonly control?: Readonly<{ group: string; generation: number; active: boolean }>;
}

interface Mutation {
  rightOrder?: "id-only";
  reverseTies?: boolean;
  ignoreMissing?: boolean;
}

interface Anchor {
  readonly guard: string;
  readonly edge: "left" | "right";
}

type Resolution =
  | { status: "present"; offsetUtf16: number }
  | { status: "deleted"; beforeUtf16: number; afterUtf16: number }
  | { status: "not-yet-created" };

const START = "^";
const END = "$";
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => cmp(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scalarBoundary(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new Error("INVALID_RANGE");
  }
  let utf16 = 0;
  let scalar = 0;
  for (const value of text) {
    if (utf16 === offset) return scalar;
    utf16 += value.length;
    scalar++;
  }
  if (utf16 === offset) return scalar;
  throw new Error("INVALID_BOUNDARY");
}

function checkUnicode(text: string) {
  for (const value of text) {
    const code = value.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new Error("INVALID_UNICODE");
  }
}

function topological(transactions: readonly SpecTransaction[]): SpecTransaction[] {
  const remaining = new Map(transactions.map((tx) => [tx.id, tx]));
  const done = new Set<string>();
  const ordered: SpecTransaction[] = [];
  while (remaining.size) {
    const next = [...remaining.values()]
      .filter((tx) => tx.depends.every((id) => done.has(id)))
      .sort((a, b) => cmp(a.id, b.id))[0];
    if (!next) throw new Error("INVALID_CAUSAL_GRAPH");
    done.add(next.id);
    remaining.delete(next.id);
    ordered.push(next);
  }
  return ordered;
}

interface View {
  all: SpecNode[];
  visible: SpecNode[];
}

export class SpecReplica {
  readonly #initial: string;
  readonly #mutant: Mutation;
  readonly #accepted = new Map<string, SpecTransaction>();
  #pending = new Map<string, SpecTransaction>();

  constructor(initial = "", mutant: Mutation = {}) {
    checkUnicode(initial);
    this.#initial = initial;
    this.#mutant = mutant;
  }

  revision(): readonly string[] {
    return Object.freeze([...this.#accepted.keys()].sort(cmp));
  }

  history(at = this.revision()): readonly SpecTransaction[] {
    const selected = new Set(at);
    const transactions = at.map((id) => {
      const tx = this.#accepted.get(id);
      if (!tx) throw new Error("UNKNOWN_REVISION");
      if (!tx.depends.every((dependency) => selected.has(dependency))) {
        throw new Error("INVALID_CAUSAL_GRAPH");
      }
      return tx;
    });
    return Object.freeze(topological(transactions));
  }

  #view(transactions: readonly SpecTransaction[]): View {
    const nodes = new Map<string, SpecNode>();
    const children = new Map<string, { L: string[]; R: string[] }>([
      [START, { L: [], R: [] }],
    ]);
    const all = (): SpecNode[] => {
      const visit = (id: string): SpecNode[] => {
        const family = children.get(id)!;
        return [
          ...family.L.flatMap(visit),
          ...(id === START ? [] : [nodes.get(id)!]),
          ...family.R.flatMap(visit),
        ];
      };
      return visit(START);
    };
    const add = (node: SpecNode) => {
      const siblings = children.get(node.parent)?.[node.side];
      if (!siblings || nodes.has(node.id)) throw new Error("INVALID_REFERENCE");
      const order = all().map((element) => element.id);
      const rank = (id: string) => id === END ? order.length : order.indexOf(id);
      const compare = (left: SpecNode, right: SpecNode): number => {
        if (node.side === "R" && !this.#mutant.rightOrder && left.right !== right.right) {
          return rank(right.right) - rank(left.right);
        }
        const tie = cmp(left.id, right.id);
        return this.#mutant.reverseTies ? -tie : tie;
      };
      let index = siblings.findIndex((id) => compare(node, nodes.get(id)!) < 0);
      if (index < 0) index = siblings.length;
      siblings.splice(index, 0, node.id);
      nodes.set(node.id, node);
      children.set(node.id, { L: [], R: [] });
    };
    let previous = START;
    let ordinal = 0;
    for (const value of this.#initial) {
      const id = `root/${String(ordinal++).padStart(6, "0")}`;
      add({ id, value, parent: previous, side: "R", left: previous, right: END, creator: "root" });
      previous = id;
    }
    const controls = new Map<string, { generation: number; id: string; active: boolean }>();
    for (const tx of transactions) {
      for (const node of tx.inserts) add(node);
      if (tx.control) {
        const old = controls.get(tx.control.group);
        if (!old || tx.control.generation > old.generation ||
          (tx.control.generation === old.generation && cmp(tx.id, old.id) > 0)) {
          controls.set(tx.control.group, { ...tx.control, id: tx.id });
        }
      }
    }
    const active = (id: string) => controls.get(id)?.active ?? true;
    const deleted = new Set(transactions.filter((tx) => active(tx.id)).flatMap((tx) => tx.deletes));
    const ordered = all();
    return {
      all: ordered,
      visible: ordered.filter((node) => active(node.creator) && !deleted.has(node.id)),
    };
  }

  snapshot(at = this.revision()) {
    const view = this.#view(this.history(at));
    return immutable({
      text: view.visible.map((node) => node.value).join(""),
      ids: view.visible.map((node) => node.id),
      creators: view.visible.map((node) => node.creator),
    });
  }

  text(at = this.revision()): string {
    return this.snapshot(at).text;
  }

  visibleIds(at = this.revision()): readonly string[] {
    return this.snapshot(at).ids;
  }

  edit(id: string, start: number, end: number, text: string, at = this.revision()): SpecTransaction {
    checkUnicode(text);
    const base = this.text(at);
    const low = scalarBoundary(base, start);
    const high = scalarBoundary(base, end);
    if (high < low) throw new Error("INVALID_RANGE");
    const history = this.history(at);
    const original = this.#view(history);
    const tx: SpecTransaction = {
      id, base: this.#initial, depends: [...at],
      inserts: [], deletes: original.visible.slice(low, high).map((node) => node.id),
    };
    const inserts: SpecNode[] = [];
    for (const value of text) {
      const view = this.#view([...history, { ...tx, inserts }]);
      const left = inserts.length ? inserts[inserts.length - 1]!.id :
        original.visible[low - 1]?.id ?? START;
      const leftIndex = left === START ? -1 : view.all.findIndex((node) => node.id === left);
      const right = view.all[leftIndex + 1]?.id ?? END;
      const hasRight = view.all.some((node) => node.parent === left && node.side === "R");
      inserts.push({
        id: `${id}/${String(inserts.length).padStart(6, "0")}`,
        value, parent: hasRight ? right : left, side: hasRight ? "L" : "R",
        left, right, creator: id,
      });
    }
    return immutable({ ...tx, inserts });
  }

  control(id: string, group: string, active: boolean): SpecTransaction {
    const history = this.history();
    if (!history.some((tx) => tx.id === group && !tx.control)) throw new Error("INVALID_REFERENCE");
    const generation = Math.max(0, ...history.filter((tx) => tx.control?.group === group)
      .map((tx) => tx.control!.generation)) + 1;
    return immutable({
      id, base: this.#initial, depends: [...this.revision()], inserts: [], deletes: [],
      control: { group, active, generation },
    });
  }

  #validate(tx: SpecTransaction, history: readonly SpecTransaction[]) {
    const selected = new Set(tx.depends);
    const dependencies = history.filter((prior) => selected.has(prior.id));
    if (dependencies.some((prior) => prior.depends.some((id) => !selected.has(id)))) {
      throw new Error("INVALID_CAUSAL_GRAPH");
    }
    const original = this.#view(dependencies);
    if (new Set(tx.deletes).size !== tx.deletes.length ||
      tx.deletes.some((id) => !original.visible.some((node) => node.id === id))) {
      throw new Error("INVALID_REFERENCE");
    }
    if (tx.control) {
      if (tx.inserts.length || tx.deletes.length ||
        !dependencies.some((prior) => prior.id === tx.control!.group && !prior.control)) {
        throw new Error("INVALID_REFERENCE");
      }
      const max = Math.max(0, ...dependencies.filter((prior) =>
        prior.control?.group === tx.control!.group).map((prior) => prior.control!.generation));
      if (tx.control.generation !== max + 1) throw new Error("INVALID_REFERENCE");
    }
    const prefix: SpecNode[] = [];
    for (const node of tx.inserts) {
      checkUnicode(node.value);
      const view = this.#view([...dependencies, { ...tx, inserts: prefix }]);
      const leftIndex = node.left === START ? -1 : view.all.findIndex((n) => n.id === node.left);
      const actualRight = view.all[leftIndex + 1]?.id ?? END;
      const hasRight = view.all.some((n) => n.parent === node.left && n.side === "R");
      if ([...node.value].length !== 1 || node.creator !== tx.id ||
        node.id !== `${tx.id}/${String(prefix.length).padStart(6, "0")}` ||
        (node.left !== START && !view.visible.some((n) => n.id === node.left)) ||
        node.right !== actualRight || node.parent !== (hasRight ? actualRight : node.left) ||
        node.side !== (hasRight ? "L" : "R")) {
        throw new Error("INVALID_REFERENCE");
      }
      prefix.push(node);
    }
  }

  receive(incoming: readonly SpecTransaction[], missing: "reject" | "defer" = "reject"):
    "accepted" | "duplicate" | "pending" {
    const candidate = new Map([...this.#accepted, ...this.#pending]);
    for (const tx of incoming) {
      if (tx.base !== this.#initial) throw new Error("BASE_MISMATCH");
      const old = candidate.get(tx.id);
      if (old && canonical(old) !== canonical(tx)) throw new Error("IDENTITY_CONFLICT");
      candidate.set(tx.id, immutable(JSON.parse(JSON.stringify(tx)) as SpecTransaction));
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("INVALID_CAUSAL_GRAPH");
      if (visited.has(id) || !candidate.has(id)) return;
      visiting.add(id);
      candidate.get(id)!.depends.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    candidate.forEach((_, id) => visit(id));
    const incomplete = [...candidate.values()].some((tx) =>
      tx.depends.some((id) => !candidate.has(id)));
    if (incomplete) {
      if (this.#mutant.ignoreMissing) {
        incoming.forEach((tx) => this.#accepted.set(tx.id, tx));
        return "accepted";
      }
      if (missing === "reject") throw new Error("MISSING_DEPENDENCIES");
      this.#pending = new Map([...candidate].filter(([id]) => !this.#accepted.has(id)));
      return "pending";
    }
    const ordered = topological([...candidate.values()]);
    for (const tx of ordered) this.#validate(tx, ordered);
    const duplicate = candidate.size === this.#accepted.size;
    ordered.forEach((tx) => this.#accepted.set(tx.id, tx));
    this.#pending.clear();
    return duplicate ? "duplicate" : "accepted";
  }

  anchor(offsetUtf16: number, affinity: "before" | "after", at = this.revision()): Anchor {
    const view = this.#view(this.history(at));
    const index = scalarBoundary(view.visible.map((node) => node.value).join(""), offsetUtf16);
    return immutable(affinity === "before"
      ? { guard: view.visible[index - 1]?.id ?? START, edge: "right" }
      : { guard: view.visible[index]?.id ?? END, edge: "left" });
  }

  resolve(anchor: Anchor, at = this.revision()): Resolution {
    const view = this.#view(this.history(at));
    if (anchor.guard === START) return { status: "present", offsetUtf16: 0 };
    if (anchor.guard === END) return { status: "present", offsetUtf16: this.text(at).length };
    const index = view.all.findIndex((node) => node.id === anchor.guard);
    if (index < 0) return { status: "not-yet-created" };
    const visible = new Set(view.visible.map((node) => node.id));
    const offset = view.all.slice(0, index).filter((node) => visible.has(node.id))
      .reduce((sum, node) => sum + node.value.length, 0);
    if (!visible.has(anchor.guard)) {
      return { status: "deleted", beforeUtf16: offset, afterUtf16: offset };
    }
    return {
      status: "present",
      offsetUtf16: offset + (anchor.edge === "right" ? view.all[index]!.value.length : 0),
    };
  }
}
