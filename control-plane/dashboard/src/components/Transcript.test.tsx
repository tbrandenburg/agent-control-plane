import { render, screen } from '@testing-library/react';
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
});
