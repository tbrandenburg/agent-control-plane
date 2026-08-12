/**
 * Live transcript — polls `GET /api/sessions/:id/events` on a 1s TanStack Query interval via
 * {@link useSessionTranscript}, appending pages by the server's `timestamp,id` cursor (no
 * client-side re-sorting, ARCHITECTURE.md §4). Renders `message.part.delta` frames as
 * incremental text; every other frame renders as a compact type marker so nothing is silently
 * dropped from the verbatim-stored stream.
 */
import { useMemo } from 'react';
import { type EventRecord, useSessionTranscript } from '@/api/client';

interface ParsedFrame {
  type?: string;
  properties?: {
    part?: { id?: string; text?: string; type?: string };
    sessionID?: string;
  };
}

function parsePayload(payload: string): ParsedFrame | null {
  try {
    return JSON.parse(payload) as ParsedFrame;
  } catch {
    return null;
  }
}

/**
 * Reduces raw event rows into display entries, merging consecutive `message.part.delta` frames
 * for the same `part.id` into one growing line of text.
 */
function toEntries(
  events: EventRecord[],
): { key: string; timestamp: string; text: string }[] {
  const entries: {
    key: string;
    timestamp: string;
    text: string;
    partId?: string;
  }[] = [];
  for (const event of events) {
    const frame = parsePayload(event.payload);
    const text = frame?.properties?.part?.text;
    const partId = frame?.properties?.part?.id;
    const isDelta =
      frame?.type === 'message.part.delta' ||
      frame?.type === 'message.part.updated';

    const last = entries.at(-1);
    if (
      isDelta &&
      typeof text === 'string' &&
      partId &&
      last?.partId === partId
    ) {
      last.text = text;
      last.timestamp = event.timestamp;
      continue;
    }
    entries.push({
      key: String(event.id),
      timestamp: event.timestamp,
      text:
        isDelta && typeof text === 'string' ? text : (frame?.type ?? 'event'),
      partId: isDelta ? partId : undefined,
    });
  }
  return entries;
}

export function Transcript({ sessionId }: { sessionId: string }) {
  const { events, reconnecting } = useSessionTranscript(sessionId);
  const entries = useMemo(() => toEntries(events), [events]);

  return (
    <div>
      {reconnecting && (
        <p role="status" className="mb-2 text-xs text-amber-600">
          Reconnecting…
        </p>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="transcript-entries">
          {entries.map((entry) => (
            <li key={entry.key} className="text-sm">
              <span className="mr-2 text-xs text-muted-foreground">
                {entry.timestamp}
              </span>
              <span className="whitespace-pre-wrap">{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
