import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { PromptComposer } from './PromptComposer';

const MODELS = [{ id: 'opencode/big-pickle', name: 'Big Pickle' }];

describe('PromptComposer', () => {
  it('preserves typed text and re-enables Send when the send fails', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error('SANDBOX_UNAVAILABLE'));
    render(<PromptComposer models={MODELS} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'do the thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText('Prompt')).toHaveValue('do the thing');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('clears the textbox once the send succeeds', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<PromptComposer models={MODELS} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'do the thing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await vi.waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue(''),
    );
  });
});
