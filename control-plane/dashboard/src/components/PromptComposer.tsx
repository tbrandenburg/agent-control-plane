/**
 * Prompt composer — UI.md §3: a textarea, model dropdown, and reasoning-effort buttons that
 * submit to `POST /api/sessions/:id/prompt` (`{content, model?, reasoningEffort?}`).
 */
import { useState } from 'react';
import type { ModelOption } from '@/api/client';
import { Button } from '@/components/ui/button';

const REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export function PromptComposer({
  models,
  defaultModel,
  defaultReasoningEffort,
  disabled,
  onSubmit,
}: {
  models: ModelOption[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  disabled?: boolean;
  onSubmit: (input: {
    content: string;
    model: string;
    reasoningEffort: string;
  }) => void;
}) {
  const [content, setContent] = useState('');
  const [model, setModel] = useState(defaultModel ?? models[0]?.id ?? '');
  const [reasoningEffort, setReasoningEffort] = useState(
    defaultReasoningEffort ?? 'high',
  );

  function handleSubmit() {
    if (!content.trim() || !model) return;
    onSubmit({ content, model, reasoningEffort });
    setContent('');
  }

  return (
    <div className="border-t p-4">
      <textarea
        aria-label="Prompt"
        className="w-full rounded-md border p-2 text-sm"
        placeholder="Ask the agent to inspect, change, or explain the code..."
        rows={3}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={disabled}
      />
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <select
            aria-label="Model"
            className="rounded-md border p-1 text-sm"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {REASONING_EFFORTS.map((effort) => (
            <button
              key={effort}
              type="button"
              disabled={disabled}
              onClick={() => setReasoningEffort(effort)}
              className={`rounded-md border px-2 py-1 text-xs capitalize ${
                reasoningEffort === effort
                  ? 'bg-primary text-primary-foreground'
                  : ''
              }`}
            >
              {effort}
            </button>
          ))}
        </div>
        <Button onClick={handleSubmit} disabled={disabled || !content.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}
