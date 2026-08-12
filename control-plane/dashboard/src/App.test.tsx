import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom';
import App from './App';

describe('App', () => {
  it('renders the header text', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'Agent Control Plane' }),
    ).toBeInTheDocument();
  });
});
