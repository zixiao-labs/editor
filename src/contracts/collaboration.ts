import type {
  Disposable, HistoryBundle, HistoryImportReport, HistoryStore, RevisionSet,
  SelectionSnapshot, SourceEndpoint,
} from "./core.js";
import type {
  DocumentId, ExternalBaseId, PresenceScopeId, SelectionId,
} from "../identity.js";
import type { EditorError, JsonValue } from "../errors.js";

export interface HistoryOfferDescriptor {
  readonly target: RevisionSet;
  readonly documents: readonly Readonly<{ document: DocumentId; base: ExternalBaseId; digest: string }>[];
  readonly format: string;
  readonly algorithm: string;
}
export interface PeerKnowledge { readonly revisions: RevisionSet }
export type HistoryReceiveEvent =
  | Readonly<{ status: "accepted" | "duplicate"; availableRevisions: RevisionSet }>
  | Readonly<{ status: "rejected"; error: EditorError }>;
export interface HistorySyncOffer extends Disposable {
  readonly descriptor: HistoryOfferDescriptor;
  exportMissing(input: { known: PeerKnowledge }): HistoryBundle;
}
export interface HistorySyncPort extends Disposable {
  offer(input: { target: RevisionSet }): HistorySyncOffer;
  receive(input: { bundle: HistoryBundle; missing?: "reject" | "defer" }): HistoryImportReport;
  onReceive(listener: (event: HistoryReceiveEvent) => void): Disposable;
}
export interface PresenceSender {
  readonly participant: string;
  readonly session: string;
  readonly epoch: string;
}
export interface PresenceSelection {
  readonly id: SelectionId;
  readonly anchor: SourceEndpoint;
  readonly head: SourceEndpoint;
}
export interface PresencePacket {
  readonly schemaVersion: 1;
  readonly scope: PresenceScopeId;
  readonly sender: PresenceSender;
  readonly sequence: number;
  readonly at: RevisionSet;
  readonly selections: readonly PresenceSelection[];
  readonly primary: SelectionId | null;
  readonly metadata?: JsonValue;
}
export type PresenceReceiveResult = Readonly<{ status: "accepted" | "ignored" | "unresolved" }>;
export interface RemotePresence {
  readonly packet: PresencePacket;
  readonly status: "resolved" | "unresolved";
  readonly expiresAt: number;
}
export interface RemotePresenceSnapshot { readonly items: readonly RemotePresence[] }
export interface RemotePresenceEvent {
  readonly reason: "receive" | "expire" | "remove";
  readonly snapshot: RemotePresenceSnapshot;
}
export interface PresencePort extends Disposable {
  publish(input: { at: RevisionSet; selections: SelectionSnapshot; metadata?: JsonValue }): PresencePacket;
  receive(input: { packet: PresencePacket; sender: PresenceSender }): PresenceReceiveResult;
  snapshot(): RemotePresenceSnapshot;
  onChange(listener: (event: RemotePresenceEvent) => void): Disposable;
  expire(): void;
  remove(input: { sender: PresenceSender }): void;
}
export interface CollaborationFactories {
  createHistorySyncPort(input: { store: HistoryStore; documents: readonly DocumentId[] }): HistorySyncPort;
  createPresencePort(input: {
    store: HistoryStore; documents: readonly DocumentId[]; scope: PresenceScopeId;
    local: PresenceSender; clock: { now(): number }; ttlMs?: number;
  }): PresencePort;
}
