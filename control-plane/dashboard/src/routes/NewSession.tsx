/**
 * Create session — `/sessions/new` (UI.md §2). Fields map 1:1 onto `POST /api/sessions`'s body:
 * `title`, `repoOwner`+`repoName`, `model` (from `GET /api/models`), `reasoningEffort`,
 * `teamConfigRepo` (optional — overrides the default team config repo, meaningful now that real
 * bootstrap actually clones it, ARCHITECTURE.md §10). `additionalRepos`/`readOrgRepos` are still
 * omitted entirely — a permanent declared deviation (ARCHITECTURE.md §13), not this phase's scope.
 */
import { useState } from 'react';
import { storeWsToken, useCreateSession, useModels } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Link, useNavigate } from '@/lib/router';

const REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export function NewSession() {
  const { data: modelsData } = useModels();
  const createSession = useCreateSession();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [model, setModel] = useState('');
  const [teamConfigRepo, setTeamConfigRepo] = useState('');
  const [reasoningEffort, setReasoningEffort] =
    useState<(typeof REASONING_EFFORTS)[number]>('high');

  const models = modelsData?.models ?? [];
  const hasNoModels = modelsData !== undefined && models.length === 0;
  const selectedModel = model || models[0]?.id || '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !repoOwner || !repoName || !selectedModel) return;
    const result = await createSession.mutateAsync({
      title,
      repoOwner,
      repoName,
      model: selectedModel,
      reasoningEffort,
      ...(teamConfigRepo ? { teamConfigRepo } : {}),
    });
    storeWsToken(result.id, result.wsToken);
    navigate(`/sessions/${result.id}`);
  }

  return (
    <div>
      <Link to="/" className="text-sm text-muted-foreground hover:underline">
        ← Sessions
      </Link>
      <h2 className="mt-2 text-lg font-semibold">New Session</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Create a new coding-agent sandbox
      </p>

      <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium">
            Title
          </label>
          <input
            id="title"
            className="mt-1 w-full rounded-md border p-2 text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label htmlFor="repoOwner" className="block text-sm font-medium">
              Repository owner
            </label>
            <input
              id="repoOwner"
              className="mt-1 w-full rounded-md border p-2 text-sm"
              value={repoOwner}
              onChange={(e) => setRepoOwner(e.target.value)}
              required
            />
          </div>
          <div className="flex-1">
            <label htmlFor="repoName" className="block text-sm font-medium">
              Repository name
            </label>
            <input
              id="repoName"
              className="mt-1 w-full rounded-md border p-2 text-sm"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label htmlFor="model" className="block text-sm font-medium">
            Model
          </label>
          {hasNoModels ? (
            <p role="alert" className="mt-1 text-sm text-red-600">
              No models configured — check your platform config repo's{' '}
              <code>opencode.jsonc</code>.
            </p>
          ) : (
            <select
              id="model"
              className="mt-1 w-full rounded-md border p-2 text-sm"
              value={selectedModel}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <span className="block text-sm font-medium">Reasoning effort</span>
          <div className="mt-1 flex gap-2">
            {REASONING_EFFORTS.map((effort) => (
              <button
                key={effort}
                type="button"
                onClick={() => setReasoningEffort(effort)}
                className={`rounded-md border px-3 py-1 text-sm capitalize ${
                  reasoningEffort === effort
                    ? 'bg-primary text-primary-foreground'
                    : ''
                }`}
              >
                {effort}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="teamConfigRepo" className="block text-sm font-medium">
            Team config (optional)
          </label>
          <input
            id="teamConfigRepo"
            className="mt-1 w-full rounded-md border p-2 text-sm"
            placeholder="owner/repository"
            value={teamConfigRepo}
            onChange={(e) => setTeamConfigRepo(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Overrides the default team config repository
          </p>
        </div>

        {createSession.isError && (
          <p role="alert" className="text-sm text-red-600">
            {createSession.error.message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Link to="/">
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </Link>
          <Button
            type="submit"
            disabled={createSession.isPending || hasNoModels}
          >
            {createSession.isPending ? 'Creating…' : 'Create Session'}
          </Button>
        </div>
      </form>
    </div>
  );
}
