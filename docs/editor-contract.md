# Editor library: independent behavior contract

Status: draft for public API review; not a claim of implemented functionality.

This document is the allowed handoff to an independent implementation
conversation. It states product requirements, observable behavior and
acceptance criteria. It contains no reference implementation code, translated
algorithms or copied tests.

## 1. Purpose and boundaries

Build an embeddable TypeScript code-editor library with:

- A self-owned CRDT and accessible causal edit history.
- Public, renderer-independent multiple-cursor and selection APIs.
- Editable projections containing excerpts from multiple source documents.
- Incremental syntax highlighting and an LSP client integration.
- Real font shaping and vgpu-backed rendering.
- Genuine IBM Plex Mono as the default code font.
- A runnable playground and independently authored tests.

Yjs and wrappers around Yjs are prohibited. A current-text-only sync adapter is
not an adequate replacement for the required history APIs. Do not substitute
Monaco, CodeMirror or another complete editor for this implementation.

The library supplies primitives that a product can use to build isolated
editable copies, historical views and merges. The product owns thread/project/
worktree orchestration, conversation history, durable storage, networking,
permissions, identity authentication and Git integration. No Delta-specific
product model or Git client belongs in the editor core.

## 2. Independent implementation boundary

The implementation conversation may read this document, the editor repository's
manifest and toolchain, user instructions and public dependency/standards
documentation. It must not read the reference repository, its tests, source
excerpts, research notes, or the research-side `.context` directory. Do not
request algorithms or pseudocode from the source researcher.

Write implementation and test cases independently from the requirements and
public standards. Record new dependencies, their selected versions, licenses
and public documentation. Separate-context tooling alone is not a legal
certification of clean-room development.

## 3. Ownership and coordinate rules

The headless model must be usable without a browser, GPU, network connection or
language server. Rendering and language-service connections subscribe to it,
rather than maintaining competing mutable text stores.

Distinguish:

- Logical document identity, independent of a filename, view or replica.
- Historical revision identity and the causal ancestors it includes.
- A mutable editing head selecting a revision.
- A version-relative text offset.
- An edit-stable position with explicit insertion affinity.
- An occurrence in a multi-document projection.
- A visual point after shaping and wrapping.

Offset APIs must name their units. JavaScript UTF-16 offsets, UTF-8 bytes,
Unicode scalar boundaries, grapheme boundaries and glyph clusters are not
interchangeable. Conversion uses a specified immutable source revision.
Malformed ranges fail explicitly; editing must not split a surrogate pair or
silently normalize Unicode. Line-ending behavior must be documented.

Public snapshots and event payloads are immutable to consumers. A snapshot of
an older revision never changes when a live head is edited or merged.

## 4. Native history and CRDT

The library owns its history representation and text-conflict integration.
Select and document a CRDT algorithm using public references, then specify its
concurrency semantics before implementing it. The product-facing history
contract must not force a particular internal per-character storage layout.

Required behavior:

1. Edits have persistent identities and explicit causal dependencies. Revision
   identity is not a wall-clock timestamp, array index or mutable counter local
   to one editor instance.
2. A product can supply immutable initial content and an opaque external base
   identity. A filename or Git commit is not inferred by the library.
3. A product can inspect causal revisions, materialize retained historical text
   and derive an isolated editable head from a selected revision.
4. A local batch is evaluated against one declared base revision and published
   as one transaction. Validate every edit before mutating any source.
5. Independent replicas converge for the same accepted history regardless of
   transport delivery order and duplicate delivery. Missing dependencies are
   reported or retained as pending; they are never interpreted as latest-state
   offsets.
6. Conflicting payloads under the same operation identity, invalid references,
   invalid causal graphs and unknown document/base identities fail explicitly.
7. Products can export history missing from a known causal version, import
   history, merge selected revisions and pin a merge to an exact source
   revision. Transport framing is separate from conflict integration.
8. Products can associate actor identity, transaction origin and opaque
   attribution metadata with edits and query surviving text provenance.
   Metadata is not treated as authenticated merely because it is present.
9. Products can translate a retained historical position into another retained
   revision and distinguish unavailable history from a deleted position.
10. Undo/redo operates on declared local transaction groups without removing
    unrelated remote edits. Historical inspection, moving a head, undo and a
    new compensating edit are distinct operations.
11. Serialization is versioned and validated, with documented limits and
    explicit errors. Retained/pinned revisions and exported positions must
    remain valid across supported compaction; unsupported compaction must not
    silently destroy them.

Do not implement a server, filesystem CRDT, Git rebase policy, branch UI,
conversation rollback or global history-retention service.

## 5. Public multiple-selection API

A selection belongs to an editing session, not to the renderer or the global
document history. Two sessions may view the same document with different
selections. Local selections and remote presence are separate.

Consumers must be able to:

- Enumerate and replace the full selection set.
- Add, update and remove a selection using a stable session-local identity.
- Read and explicitly choose the primary selection.
- Represent collapsed carets and directional ranges using stable source
  positions; retain source document and projection occurrence identity.
- Observe immutable selection changes with an origin/reason and a disposable
  subscription.
- Apply the same replacement at every selection or a different replacement per
  selection in one public transaction API.
- Save and restore selections and associate selection metadata with undo/redo.
- Use the API headlessly and render product-owned cursor decorations.

The API review must fix the policy for overlapping selections, duplicate
carets, adjacent ranges, deterministic application order and primary selection
survival. Do not leave this behavior dependent on array order or UI internals.
Reject ambiguous conflicting replacements before committing any edit.

Remote history integration updates positions without overwriting the session's
selection set. Products decide if and how local selections are broadcast.
Callbacks must not expose partially committed text/selection state.

## 6. Editable multiple-document projections

A projection consists of ordered, identified excerpts of source documents.
It is not a mutable concatenation that loses source identity.

- Edits are routed to the corresponding source document revisions.
- Source updates are reflected in every relevant occurrence.
- Projection-to-source mapping identifies document, excerpt and stable position.
- Source-to-projection mapping may have multiple results.
- Excerpt boundaries and non-source headers are explicit presentation objects.
  They are never inserted into source files or submitted to a language server.
- Boundary insertion affinity is explicit.
- Overlapping/repeated excerpts must not accidentally apply one source edit
  twice. Conflicting alias edits are rejected before any source changes.
- Cross-excerpt replacement behavior must be specified during API review.
  A safe first default is rejecting a single replacement spanning distinct
  excerpts while supporting separate selections in multiple excerpts.
- One user transaction spanning several documents must have a coherent
  transaction-group/undo contract. State whether atomicity is local only;
  do not imply distributed cross-document atomicity.

The product owns excerpt discovery, search results, review UI and filesystem
layout. The library owns source mapping correctness.

## 7. Highlighting and language services

Provide a language registration boundary; do not hardcode all token rules into
the renderer.

Syntax highlighting:

- Use incremental parsing with a selected parser/runtime and independently
  sourced, license-reviewed grammars and queries.
- Preserve source revision information across asynchronous parsing.
- Reuse a previous parse correctly after edits; discard invalid late results.
- Keep syntax classifications separate from theme colors.
- Implement a documented precedence between syntax and semantic styling.
- A regex colorizer alone is not evidence of incremental syntax support.

LSP:

- Keep transport replaceable. Browser code must not pretend it can spawn native
  language-server processes.
- Implement JSON-RPC requests/responses/notifications, initialization, capability
  checks, cancellation, timeouts, disposal and disconnect error propagation.
- Support source-document open/change/close synchronization. Honor the
  negotiated full/incremental mode and position encoding.
- Send source URIs and source positions, never projected concatenations.
- Synchronize a revision before requesting language features for it.
- Tie replies to the relevant source revision and connection generation. Drop
  or explicitly remap stale results; never paint them at current raw offsets.
- Supply diagnostics, completion, hover, definition and semantic highlighting
  for the initial supported server. Only advertise implemented capabilities.
- Treat returned markup as untrusted. Do not inject server HTML into the page.

A development-only native server bridge, if supplied, must bind locally by
default and restrict server commands and workspace access. It is not a
production remote-execution service.

Initial proposed coverage is TypeScript/JavaScript and JSON syntax, with one
real TypeScript language-server integration. Confirm this scope before claiming
broader language coverage. Protocol fixtures complement, not replace, the real
server workflow.

## 8. Shaping, rendering and input

Use vgpu for drawing editor content. Font shaping is a separate responsibility;
do not assume vgpu provides a complete text layout engine.

- Shape runs with a real font shaper or a verified browser shaping path.
- Preserve associations among source text, glyph clusters, caret stops,
  hit-testing and selection geometry.
- Allow OpenType features to be configured and toggled at runtime.
- Never change source text to Unicode arrows or other substituted characters
  to simulate programming ligatures.
- Use genuine IBM Plex Mono as the default. It does not supply programming
  ligatures; do not silently rename another font or claim a CSS setting creates
  missing font features.
- Verify ligature rendering with a real, explicitly selected capable font.
  Adding a separate opt-in font fixture requires a product decision.
- Handle Chinese IME composition, paste, selection replacement and undo
  grouping. Do not make keyboard keydown the sole text-input mechanism.
- Make input/composition integration usable alongside product-owned UI.
- Provide a clear WebGPU-unavailable/device-loss state; a fallback, if offered,
  must be identified and tested, not silently substituted for GPU rendering.
- Virtualize work to the visible region, invalidate affected data deliberately
  and release owned GPU/parser/input resources on disposal.

A browser input/accessibility bridge can use DOM elements without moving the
document model into contenteditable. Do not claim screen-reader support solely
because a hidden textarea exists; verify and document supported workflows.

## 9. Playground visual direction

Audience: developers embedding and evaluating an editor library.
Tone: restrained, professional, precise; no marketing dashboard.
Proposed delivery: framework-independent TypeScript library and a vanilla
TypeScript playground.

Use a coherent token system, IBM Plex Mono for code, a clear editing focus,
compact controls, readable syntax colors and visible focus states. Provide
dark/light themes and reduced-motion behavior. Keep font/loading/error states
honest. The playground should demonstrate real edits, source projections,
multiple selections and causal-history operations, not static screenshots.

Do not enlarge toolbar targets by adding ornamental cards or animate the code
surface during typing. Responsive controls should remain accessible without
covering the editable viewport.

## 10. Toolchain and acceptance gates

Preserve the repository's selected tools:

- @lightning-js/lightning 3.1.2: runtime, type-level and browser tests.
- @nasti-toolchain/nasti 2.7.0: playground development server.
- tsdown 0.23.2: production library outputs and declarations.
- TypeScript 7.0.2; pnpm 12.15.0.

Before selecting vgpu or shaping/parser dependencies, inspect their exact
selected versions and version-matched docs. Do not copy dependency APIs from a
remembered version. Library entry points must not accidentally bundle the
playground or force DOM/GPU imports into headless consumers.

Required independently authored evidence:

1. CRDT convergence under concurrent insert/delete/replace, duplicate and
   out-of-order delivery, missing parents, reconnect and fork/merge.
2. Three-or-more-replica and seeded randomized cases, with a deliberately
   simple independent oracle where applicable. Convergence alone is not proof
   of preserving edit intent.
3. Historical snapshot immutability, history round trips, pinned merges,
   external bases, provenance, rejected invalid histories and selective undo.
4. Public multiple-cursor behavior, event ordering, overlap policy, reversed
   selections, undo restoration and remote-edit position movement.
5. Projection mapping, repeated/overlapping excerpts, boundary affinity and
   atomic rejection of invalid multi-source edits.
6. Non-ASCII offset conversions, surrogate pairs, combining marks, emoji,
   tabs, line endings and Chinese composition.
7. Incremental syntax changes, asynchronous result invalidation and real-server
   LSP synchronization/features at source-document coordinates.
8. A real browser GPU render, font loading, ligature on/off, caret/selection
   hit-testing, resize/DPR, no-WebGPU failure and disposal.
9. A runnable Nasti playground plus tsdown ESM/declaration build and a
   consumer-import smoke test of the produced package.

Name exact commands and actual outcomes in delivery notes. Protocol mocks,
typechecking, shader compilation and a build do not prove a real LSP session,
IME workflow or rendered output. Clearly label checks that could not run.

## 11. API review before implementation

Prepare a small number of coherent API alternatives and recommend one. Show
concrete usage for:

- Native history, historical snapshots, isolated editing heads and pinned merge.
- Product-controlled multiple selections and one batch edit.
- A source-mapped multi-document projection.
- LSP transport and source-document registration.
- Mounting/detaching a GPU view without transferring model ownership.

Ask only unresolved product/architectural questions. Lock confirmed signatures,
defaults, failure semantics and non-goals before runtime implementation. The
internal CRDT algorithm needs its own explicit specification and test plan;
this requirements document is not that algorithm.

## Public references

- Product motivation, not an algorithm specification:
  https://delta.dev/blog/future-of-version-control
- Product-layer scope:
  https://delta.dev/docs/concepts/core-concepts
- LSP:
  https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- Incremental parsing:
  https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html
- Font shaping:
  https://harfbuzz.github.io/shaping-and-shape-plans.html
- IBM Plex Mono:
  https://github.com/IBM/plex/tree/master/packages/plex-mono
