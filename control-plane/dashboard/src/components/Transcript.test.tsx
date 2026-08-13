import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom';
import type { EventRecord } from '@/api/client';
import { Transcript } from './Transcript';

function event(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: 1,
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: '{}',
    ...overrides,
  };
}

describe('Transcript', () => {
  it('renders two incoming WS events without duplicating or dropping them', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { part: { id: 'p1', text: 'Hel' } },
        }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { part: { id: 'p2', text: 'World' } },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    expect(screen.getByText('Hel')).toBeInTheDocument();
    expect(screen.getByText('World')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows a reload message on an invalid wsToken, not a silent disconnect', () => {
    render(<Transcript events={[]} status="closed" invalidToken={true} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/reload/i);
  });

  it('shows a reconnecting message while status is reconnecting', () => {
    render(
      <Transcript events={[]} status="reconnecting" invalidToken={false} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
  });

  it('coalesces multiple delta chunks for the same message into one growing bubble', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { part: { id: 'p1', messageID: 'm1', text: 'Hel' } },
        }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { part: { id: 'p1', messageID: 'm1', text: 'Hello' } },
        }),
      }),
      event({
        id: 3,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: {
            part: { id: 'p1', messageID: 'm1', text: 'Hello world' },
          },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('hides pure lifecycle events by default and reveals them via the raw-events toggle', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({ type: 'session.updated', properties: {} }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({ type: 'session.idle', properties: {} }),
      }),
      event({
        id: 3,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { part: { id: 'p1', messageID: 'm1', text: 'hi' } },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    expect(screen.queryByText('session.updated')).not.toBeInTheDocument();
    expect(screen.queryByText('session.idle')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /show raw events/i });
    fireEvent.click(toggle);

    expect(screen.getByText('session.updated')).toBeInTheDocument();
    expect(screen.getByText('session.idle')).toBeInTheDocument();
  });

  it('visually distinguishes user prompts from assistant replies via role test-ids', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'u1',
              messageID: 'mu',
              text: 'What is 2+2?',
              role: 'user',
            },
          },
        }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { part: { id: 'a1', messageID: 'ma', text: '4' } },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    expect(screen.getByTestId('transcript-message-user')).toHaveTextContent(
      'What is 2+2?',
    );
    expect(
      screen.getByTestId('transcript-message-assistant'),
    ).toHaveTextContent('4');
  });
});
