import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom';
import { type DockerPhase, deriveStatus, StatusBadge } from './StatusBadge';

const SESSION_STATUSES = ['active', 'archived', 'pending_bootstrap'] as const;
const DOCKER_PHASES: DockerPhase[] = [
  null,
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
];

describe('deriveStatus', () => {
  it('always returns archived once sessionStatus is archived, regardless of docker phase', () => {
    for (const phase of DOCKER_PHASES) {
      expect(deriveStatus('archived', phase)).toBe('archived');
    }
  });

  it('returns active for a non-archived session with no known docker phase', () => {
    expect(deriveStatus('active', null)).toBe('active');
    expect(deriveStatus('pending_bootstrap', null)).toBe('stopped');
  });

  it('maps a dead container to failed', () => {
    for (const sessionStatus of ['active', 'pending_bootstrap'] as const) {
      expect(deriveStatus(sessionStatus, 'dead')).toBe('failed');
    }
  });

  it('maps an exited container to stopped', () => {
    for (const sessionStatus of ['active', 'pending_bootstrap'] as const) {
      expect(deriveStatus(sessionStatus, 'exited')).toBe('stopped');
    }
  });

  it('maps every other live docker phase to running', () => {
    const livePhases: DockerPhase[] = [
      'created',
      'running',
      'paused',
      'restarting',
      'removing',
    ];
    for (const sessionStatus of ['active', 'pending_bootstrap'] as const) {
      for (const phase of livePhases) {
        expect(deriveStatus(sessionStatus, phase)).toBe('running');
      }
    }
  });

  it('covers every (sessionStatus, dockerPhase) combination with a defined result', () => {
    const expected: DerivedStatusResult[] = [];
    for (const sessionStatus of SESSION_STATUSES) {
      for (const dockerPhase of DOCKER_PHASES) {
        expected.push({
          sessionStatus,
          dockerPhase,
          result: deriveStatus(sessionStatus, dockerPhase),
        });
      }
    }
    expect(expected).toHaveLength(
      SESSION_STATUSES.length * DOCKER_PHASES.length,
    );
    for (const { result } of expected) {
      expect(['active', 'running', 'stopped', 'failed', 'archived']).toContain(
        result,
      );
    }
  });
});

interface DerivedStatusResult {
  sessionStatus: string;
  dockerPhase: DockerPhase;
  result: string;
}

describe('StatusBadge', () => {
  it('renders the running label for an active session with a running container', () => {
    render(<StatusBadge sessionStatus="active" dockerPhase="running" />);
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('renders the archived label for an archived session even if the container is running', () => {
    render(<StatusBadge sessionStatus="archived" dockerPhase="running" />);
    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('renders the failed label for a dead container', () => {
    render(<StatusBadge sessionStatus="active" dockerPhase="dead" />);
    expect(screen.getByText('failed')).toBeInTheDocument();
  });
});
