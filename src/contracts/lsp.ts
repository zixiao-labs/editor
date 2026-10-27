import type {
  CancellationSignal, Disposable, EditingHead, HeadCheckpoint, RevisionEntry, SourceEdit,
  TextPoint, TextRange,
} from "./core.js";
import type { DocumentId, Opaque, RevisionId } from "../identity.js";
import type { JsonValue } from "../errors.js";

export type JsonRpcId = number | string;
export type JsonRpcParams = readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonRpcMessage =
  | Readonly<{
    jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: JsonRpcParams;
    result?: never; error?: never;
  }>
  | Readonly<{
    jsonrpc: "2.0"; method: string; params?: JsonRpcParams;
    id?: never; result?: never; error?: never;
  }>
  | Readonly<{
    jsonrpc: "2.0"; id: JsonRpcId | null; result: JsonValue; error?: never; method?: never;
  }>
  | Readonly<{
    jsonrpc: "2.0"; id: JsonRpcId | null; result?: never; method?: never;
    error: Readonly<{ code: number; message: string; data?: JsonValue }>;
  }>;
export interface RpcTransport extends Disposable {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(listener: (message: unknown) => void): Disposable;
  onClose(listener: (cause?: Error) => void): Disposable;
}
export interface LspInitializationOptions {
  readonly rootUri: string | null;
  readonly workspaceFolders?: readonly Readonly<{ uri: string; name: string }>[] | null;
  readonly initializationOptions?: JsonValue;
  readonly clientInfo?: Readonly<{ name: string; version?: string }>;
}
export type LspPositionEncoding = "utf-8" | "utf-16" | "utf-32";
export type LspDocumentVersion = Opaque<number, "LspDocumentVersion">;
export type ConnectionGeneration = Opaque<number, "ConnectionGeneration">;
export interface LspStamp extends RevisionEntry {
  readonly uri: string;
  readonly version: LspDocumentVersion;
  readonly generation: ConnectionGeneration;
}
export type LspRequestResult<T> =
  | Readonly<{ status: "ready"; stamp: LspStamp; value: T }>
  | Readonly<{ status: "stale"; stamp: LspStamp }>;
// External locations and unversioned diagnostics deliberately retain protocol coordinates.
export interface LspPosition { readonly line: number; readonly character: number }
export interface LspRange { readonly start: LspPosition; readonly end: LspPosition }
export interface ExternalLocation {
  readonly uri: string;
  readonly range: LspRange;
  readonly encoding: LspPositionEncoding;
}
export interface MarkupContent {
  readonly kind: "plaintext" | "markdown";
  readonly value: string; // Untrusted server data; never an HTML rendering permission.
}
export interface Hover { readonly contents: MarkupContent; readonly range?: TextRange }
export interface SourceEditProposal {
  readonly expect: HeadCheckpoint;
  readonly edits: readonly SourceEdit[];
}
export interface CompletionItem {
  readonly label: string;
  readonly detail?: string;
  readonly documentation?: MarkupContent;
  readonly insertText?: string;
  readonly edit?: SourceEditProposal;
}
export interface CompletionList {
  readonly isIncomplete: boolean;
  readonly items: readonly CompletionItem[];
}
export interface SemanticToken {
  readonly range: TextRange;
  readonly type: string;
  readonly modifiers: readonly string[];
}
export interface LspDiagnostic {
  readonly range: LspRange;
  readonly message: string;
  readonly severity?: 1 | 2 | 3 | 4;
  readonly code?: number | string;
  readonly source?: string;
}
export interface SourceDiagnostic extends Omit<LspDiagnostic, "range"> {
  readonly range: TextRange;
}
export type DiagnosticsEvent =
  | Readonly<{
    status: "ready" | "stale"; stamp: LspStamp; diagnostics: readonly SourceDiagnostic[];
  }>
  | Readonly<{
    status: "unversioned"; document: DocumentId; uri: string; generation: ConnectionGeneration;
    encoding: LspPositionEncoding; diagnostics: readonly LspDiagnostic[];
  }>;
export interface LspTextEdit { readonly range: LspRange; readonly newText: string }
// Text-only subset. Resource operations must be rejected by the runtime decoder.
export interface LspWorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly LspTextEdit[]>>;
  readonly documentChanges?: readonly Readonly<{
    textDocument: Readonly<{ uri: string; version: LspDocumentVersion | null }>;
    edits: readonly LspTextEdit[];
  }>[];
}
export interface LanguageRequest {
  readonly at: RevisionId;
  readonly position: TextPoint;
  readonly signal?: CancellationSignal;
}
export interface LanguageBinding extends Disposable {
  sync(input: { at: RevisionId; signal?: CancellationSignal }): Promise<void>;
  hover(input: LanguageRequest): Promise<LspRequestResult<Hover | null>>;
  completion(input: LanguageRequest): Promise<LspRequestResult<CompletionList>>;
  definition(input: LanguageRequest): Promise<LspRequestResult<readonly ExternalLocation[]>>;
  semanticTokens(input: {
    at: RevisionId; signal?: CancellationSignal;
  }): Promise<LspRequestResult<readonly SemanticToken[]>>;
  onDiagnostics(listener: (event: DiagnosticsEvent) => void): Disposable;
}
export interface LanguageCapabilities {
  readonly positionEncoding: LspPositionEncoding;
  readonly synchronization: "none" | "full" | "incremental";
  readonly hover: boolean;
  readonly completion: boolean;
  readonly definition: boolean;
  readonly semanticTokens: boolean;
}
export interface LanguageClient extends Disposable {
  readonly generation: ConnectionGeneration;
  readonly capabilities: LanguageCapabilities;
  bindDocument(input: {
    head: EditingHead; document: DocumentId; uri: string; language: string;
  }): LanguageBinding;
  // Captured stamps are mandatory even for unversioned wire edits; no guessing "latest".
  prepareWorkspaceEdit(input: {
    head: EditingHead; edit: LspWorkspaceEdit; at: readonly LspStamp[];
  }): SourceEditProposal;
  shutdown(): Promise<void>;
}
export interface LspFactories {
  connectLanguageServer(input: {
    transport: RpcTransport; initialization: LspInitializationOptions;
    requestTimeoutMs?: number; unversionedDiagnostics?: "report-only";
  }): Promise<LanguageClient>;
}
