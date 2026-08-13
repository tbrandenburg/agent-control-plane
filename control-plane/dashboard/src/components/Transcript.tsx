/**
 * Live transcript — WebSocket-driven via {@link useSessionSocket} (ARCHITECTURE.md §6),
 * replacing Phase 1's 1s-poll {@code useSessionTranscript} outright (deletion, not layering, per
 * this phase's plan). The **content** contract is unchanged from Phase 1: `message.part.delta`
 * frames render as incremental text; every other frame renders as a compact type marker so
 * nothing is silently dropped from the verbatim-stored stream.
 *
 * The socket itself is owned by `SessionDetail` (lifted so its header's connection indicator and
 * this body share one live connection instead of opening two) and passed down as props.
 *
 * Presentation layer (issue #16): pure lifecycle frames (`session.updated`, `session.status`,
 * `session.diff`, `session.idle`, and any `message.updated`/`message.part.updated` carrying no
 * visible text) are hidden from the default view behind a "Show raw events" toggle, since they
 * carry no user-facing conversational content. Text-bearing frames are grouped by message
 * (`messageID`, falling back to the part `id` when absent) so streaming deltas coalesce into one
 * growing bubble, and are labelled by role (`user` vs the default `assistant`) when the
 * underlying frame exposes one.
 */
import { useMemo, useState } from 'react';
import type { EventRecord } from '@/api/client';
import { Button } from '@/components/ui/button';
import type { SocketStatus } from '@/hooks/useSessionSocket';
import { cn } from '@/lib/utils';

type Role = 'user' | 'assistant';

/**
 * Real opencode SSE frame shapes actually observed on the wire (verified live against
 * `opencode/big-pickle`, not assumed from docs — see issue #16's follow-up fix):
 * - `message.updated` carries the message's role at `properties.info.{id,role}` — this is the
 *   *only* place role ever appears; individual `part`/`delta` frames never carry a role field.
 * - `message.part.updated` carries a part's current (possibly empty/seed) text at
 *   `properties.part.{id,messageID,text}`.
 * - `message.part.delta` carries only an *incremental* text chunk at
 *   `properties.{messageID,partID,delta}` — there is no `properties.part` on this frame type at
 *   all, so it must be handled as its own distinct shape, not folded into the `part.text` case.
 */
interface ParsedFrame {
  type?: string;
  properties?: {
    part?: { id?: string; messageID?: string; text?: string };
    info?: { id?: string; role?: Role };
    messageID?: string;
    partID?: string;
    delta?: string;
  };
}

interface MessageEntry {
  key: string;
  timestamp: string;
  text: string;
  role: Role;
}

interface RawEntry {
  key: string;
  timestamp: string;
  type: string;
}

function parsePayload(payload: string): ParsedFrame | null {
  try {
    return JSON.parse(payload) as ParsedFrame;
  } catch {
    return null;
  }
}

/**
 * Splits raw event rows into conversational message bubbles (grouped/coalesced by message id,
 * with delta chunks appended onto a running per-message text) and hidden lifecycle rows (no
 * visible content). Two passes: first collect every message's role (from `message.updated`) and
 * every part's owning message id (from `message.part.updated`), then build/append text in event
 * order using that lookup — a delta can otherwise arrive referencing a `partID` whose owning
 * message was only established moments earlier by a `part.updated` frame.
 */
function toEntries(events: EventRecord[]): {
  messages: MessageEntry[];
  raw: RawEntry[];
} {
  const roleByMessage = new Map<string, Role>();
  const messageByPart = new Map<string, string>();

  for (const event of events) {
    const frame = parsePayload(event.payload);
    const info = frame?.properties?.info;
    if (info?.id && info.role) roleByMessage.set(info.id, info.role);
    const part = frame?.properties?.part;
    if (part?.id && part.messageID) messageByPart.set(part.id, part.messageID);
  }

  const messages: MessageEntry[] = [];
  const groupIndex = new Map<string, number>();
  const raw: RawEntry[] = [];

  const upsert = (groupId: string, text: string, timestamp: string) => {
    const existingIndex = groupIndex.get(groupId);
    const role = roleByMessage.get(groupId) ?? 'assistant';
    if (existingIndex !== undefined) {
      const existing = messages[existingIndex];
      existing.text = text;
      existing.timestamp = timestamp;
      existing.role = role;
      return;
    }
    groupIndex.set(groupId, messages.length);
    messages.push({ key: groupId, timestamp, text, role });
  };

  for (const event of events) {
    const frame = parsePayload(event.payload);
    const part = frame?.properties?.part;

    if (typeof part?.text === 'string' && part.messageID) {
      upsert(part.messageID, part.text, event.timestamp);
      continue;
    }

    const delta = frame?.properties?.delta;
    if (typeof delta === 'string') {
      const partID = frame?.properties?.partID;
      const messageID =
        frame?.properties?.messageID ??
        (partID ? messageByPart.get(partID) : undefined) ??
        partID;
      if (messageID) {
        const existingIndex = groupIndex.get(messageID);
        const priorText =
          existingIndex !== undefined ? messages[existingIndex].text : '';
        upsert(messageID, priorText + delta, event.timestamp);
        continue;
      }
    }

    raw.push({
      key: String(event.id),
      timestamp: event.timestamp,
      type: frame?.type ?? 'event',
    });
  }

  return { messages, raw };
}

export function Transcript({
  events,
  status,
  invalidToken,
}: {
  events: EventRecord[];
  status: SocketStatus;
  invalidToken: boolean;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const { messages, raw } = useMemo(() => toEntries(events), [events]);

  return (
    <div>
      {invalidToken && (
        <p role="alert" className="mb-2 text-xs text-red-600">
          Live updates aren't available in this browser tab (no valid session
          token found here). You can still view session details — return to the
          sessions list or reopen this session from the tab where it was
          created.
        </p>
      )}
      {!invalidToken && status === 'reconnecting' && (
        <p role="status" className="mb-2 text-xs text-amber-600">
          Reconnecting…
        </p>
      )}
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="transcript-entries">
          {messages.map((entry) => (
            <li
              key={entry.key}
              data-testid={`transcript-message-${entry.role}`}
              className={cn(
                'rounded-md border p-2 text-sm',
                entry.role === 'user'
                  ? 'bg-secondary/50 border-secondary'
                  : 'bg-muted/40 border-transparent',
              )}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {entry.role === 'user' ? 'You' : 'Agent'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.timestamp}
                </span>
              </div>
              <span className="whitespace-pre-wrap">{entry.text}</span>
            </li>
          ))}
        </ul>
      )}

      {raw.length > 0 && (
        <div className="mt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowRaw((value) => !value)}
          >
            {showRaw ? 'Hide raw events' : `Show raw events (${raw.length})`}
          </Button>
          {showRaw && (
            <ul className="mt-2 space-y-1" data-testid="transcript-raw-entries">
              {raw.map((entry) => (
                <li key={entry.key} className="text-xs text-muted-foreground">
                  <span className="mr-2">{entry.timestamp}</span>
                  <span>{entry.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
