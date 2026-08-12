/**
 * Session detail — `/sessions/:id` (UI.md §3). Overview panel + transcript + prompt composer,
 * scoped to what Phase 1's backend actually provides (no Participants/Artifacts/Diagnostics/Logs
 * yet — those endpoints don't exist this phase, UI.md's design goal of never rendering an unbacked
 * panel).
 */
import { useModels, useSendPrompt, useSession } from '@/api/client';
import { PromptComposer } from '@/components/PromptComposer';
import { type DockerPhase, StatusBadge } from '@/components/StatusBadge';
import { Transcript } from '@/components/Transcript';
import { Link } from '@/lib/router';

export function SessionDetail({ id }: { id: string }) {
  const { data: session, isLoading, isError, error } = useSession(id);
  const { data: modelsData } = useModels();
  const sendPrompt = useSendPrompt(id);

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError || !session) {
    const notFound = error?.status === 404;
    return (
      <div className="rounded-md border p-4 text-sm">
        <p className="text-red-600">
          {notFound
            ? 'This session does not exist or has been removed.'
            : 'Something went wrong loading this session.'}
        </p>
        <Link
          to="/"
          className="mt-2 inline-block text-muted-foreground hover:underline"
        >
          ← Back to sessions
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Link to="/" className="text-sm text-muted-foreground hover:underline">
        ← Sessions
      </Link>
      <div className="mt-1 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{session.title}</h2>
          <p className="text-sm text-muted-foreground">
            {session.repoOwner}/{session.repoName} · {session.model} ·{' '}
            {session.reasoningEffort}
          </p>
        </div>
        <StatusBadge
          sessionStatus={session.status}
          dockerPhase={session.phase as DockerPhase}
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="col-span-2 rounded-md border">
          <div className="max-h-[60vh] overflow-y-auto p-4">
            <Transcript sessionId={id} />
          </div>
          {sendPrompt.isError && (
            <p role="alert" className="px-4 text-sm text-red-600">
              {sendPrompt.error.message}
            </p>
          )}
          <PromptComposer
            models={modelsData?.models ?? []}
            defaultModel={session.model ?? undefined}
            defaultReasoningEffort={session.reasoningEffort ?? undefined}
            disabled={sendPrompt.isPending}
            onSubmit={(input) => sendPrompt.mutate(input)}
          />
        </div>

        <aside className="rounded-md border p-4 text-sm">
          <h3 className="mb-2 font-medium">Overview</h3>
          <dl className="space-y-2">
            <div>
              <dt className="text-muted-foreground">Sandbox</dt>
              <dd>{session.containerName ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">OpenCode session</dt>
              <dd>{session.opencodeSessionId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{session.updatedAt}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
