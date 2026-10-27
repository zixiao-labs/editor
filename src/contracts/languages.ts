import type {
  CancellationSignal, Disposable, EditingHead, RevisionEntry, SourceEdit, TextRange, TextSnapshot,
} from "./core.js";
import type { DocumentId, Opaque, RevisionId } from "../identity.js";

export type GrammarGeneration = Opaque<number, "GrammarGeneration">;
export interface SyntaxAsset {
  readonly source: string;
  readonly version: string;
  readonly license: string;
  readonly digest: string;
}
export interface SyntaxMetadata {
  readonly runtime: Readonly<{ name: string; version: string }>;
  readonly grammar: SyntaxAsset;
  readonly queries: readonly SyntaxAsset[];
}
// Semantic classifications, never theme colors.
export interface Classification {
  readonly range: TextRange;
  readonly type: string;
  readonly modifiers: readonly string[];
}
export interface SyntaxTree extends Disposable, RevisionEntry {
  readonly classifications: readonly Classification[];
}
export interface SyntaxChange {
  readonly before: TextSnapshot;
  readonly after: TextSnapshot;
  // Same-base source edits; the parser adapter converts its own coordinate units.
  readonly edits: readonly SourceEdit[];
}
export interface SyntaxParser extends Disposable {
  parse(input: {
    source: TextSnapshot;
    previous?: Readonly<{ tree: SyntaxTree; changes: readonly SyntaxChange[] }>;
    signal?: CancellationSignal;
  }): Promise<SyntaxTree>;
}
export interface SyntaxPlugin {
  readonly metadata: SyntaxMetadata;
  createParser(): Promise<SyntaxParser>;
}
export interface LanguageRegistry extends Disposable {
  register(input: { id: string; syntax: SyntaxPlugin }): Disposable;
}
export interface SyntaxClassification extends RevisionEntry {
  readonly language: string;
  readonly grammarGeneration: GrammarGeneration;
  readonly classifications: readonly Classification[];
}
// Both sides are classified as complete retained source documents, not isolated hunks.
export interface DiffSyntaxProvider {
  classify(input: {
    document: DocumentId; revision: RevisionId; signal?: CancellationSignal;
  }): Promise<SyntaxClassification>;
}
export interface SyntaxService extends Disposable, DiffSyntaxProvider {
  setLanguage(input: { document: DocumentId; language: string }): void;
}
export interface LanguageFactories {
  createLanguageRegistry(): LanguageRegistry;
  attachSyntax(input: { head: EditingHead; languages: LanguageRegistry }): SyntaxService;
}
