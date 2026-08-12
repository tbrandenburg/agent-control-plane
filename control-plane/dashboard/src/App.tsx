import { Button } from '@/components/ui/button';

/**
 * Application shell — header chrome only. Phase 1 adds the session list/detail
 * content area; this step establishes the SPA bootstrap and routing surface.
 * @returns {JSX.Element} The app shell.
 */
function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Agent Control Plane</h1>
        <Button variant="outline" size="sm">
          New Session
        </Button>
      </header>
      <main className="p-6">
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      </main>
    </div>
  );
}

export default App;
