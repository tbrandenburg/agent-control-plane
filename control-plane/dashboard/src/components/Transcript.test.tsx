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
          properties: { messageID: 'm1', partID: 'p1', delta: 'Hel' },
        }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { messageID: 'm2', partID: 'p2', delta: 'World' },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    expect(screen.getByText('Hel')).toBeInTheDocument();
    expect(screen.getByText('World')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows an accurate message on an invalid wsToken, not a silent disconnect', () => {
    render(<Transcript events={[]} status="closed" invalidToken={true} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /live updates aren't available/i,
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/reload/i);
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
          properties: { messageID: 'm1', partID: 'p1', delta: 'Hel' },
        }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { messageID: 'm1', partID: 'p1', delta: 'lo' },
        }),
      }),
      event({
        id: 3,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { messageID: 'm1', partID: 'p1', delta: ' world' },
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
          properties: { messageID: 'm1', partID: 'p1', delta: 'hi' },
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
          type: 'message.updated',
          properties: { info: { id: 'mu', role: 'user' } },
        }),
      }),
      event({
        id: 2,
        payload: JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: { id: 'u1', messageID: 'mu', text: 'What is 2+2?' },
          },
        }),
      }),
      event({
        id: 3,
        payload: JSON.stringify({
          type: 'message.updated',
          properties: { info: { id: 'ma', role: 'assistant' } },
        }),
      }),
      event({
        id: 4,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: { messageID: 'ma', partID: 'a1', delta: '4' },
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

  it('renders a session.error event as an always-visible alert with a readable message', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'session.error',
          properties: {
            sessionID: 's1',
            error: {
              name: 'UnknownError',
              data: { message: 'Model not found: opencode/stub-model' },
            },
          },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    const alerts = screen.getAllByRole('alert');
    const errorAlert = alerts.find((el) =>
      el.textContent?.includes('Model not found: opencode/stub-model'),
    );
    expect(errorAlert).toBeDefined();
    // Must be visible without needing to toggle "Show raw events".
    expect(
      screen.queryByRole('button', { name: /show raw events/i }),
    ).toBeNull();
  });

  it('falls back to the error name when no data.message is present', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'session.error',
          properties: { error: { name: 'MessageAbortedError', data: {} } },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    expect(screen.getByText('MessageAbortedError')).toBeInTheDocument();
  });

  it('renders markdown formatting (bold, fenced code) as real elements, not literal text', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: {
            messageID: 'm1',
            partID: 'p1',
            delta: '**bold** text\n\n```js\nconst x = 1;\n```',
          },
        }),
      }),
    ];

    render(<Transcript events={events} status="open" invalidToken={false} />);

    const bold = screen.getByText('bold');
    expect(bold.tagName).toBe('STRONG');
    const code = screen.getByText('const x = 1;');
    expect(code.tagName).toBe('CODE');
  });

  it('does not crash on a mid-stream, unclosed markdown fence/bold marker', () => {
    const events: EventRecord[] = [
      event({
        id: 1,
        payload: JSON.stringify({
          type: 'message.part.delta',
          properties: {
            messageID: 'm1',
            partID: 'p1',
            delta: 'Here is some **bold and a ```unterminated code',
          },
        }),
      }),
    ];

    expect(() =>
      render(<Transcript events={events} status="open" invalidToken={false} />),
    ).not.toThrow();
  });
});
