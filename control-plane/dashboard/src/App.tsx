import { useEffect, useState } from 'react';
import { RouterProvider, useRoute } from '@/lib/router';
import { NewSession } from '@/routes/NewSession';
import { SessionDetail } from '@/routes/SessionDetail';
import { SessionList } from '@/routes/SessionList';

/** Header connection indicator — reflects `navigator.onLine`, updated live (UI.md §1/§3). */
function ConnectionIndicator() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const setOn = () => setOnline(true);
    const setOff = () => setOnline(false);
    window.addEventListener('online', setOn);
    window.addEventListener('offline', setOff);
    return () => {
      window.removeEventListener('online', setOn);
      window.removeEventListener('offline', setOff);
    };
  }, []);

  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${online ? 'text-green-600' : 'text-red-600'}`}
    >
      <span aria-hidden="true">●</span>
      {online ? 'Connected' : 'Disconnected'}
    </span>
  );
}

function RouteView() {
  const route = useRoute();
  switch (route.name) {
    case 'sessionList':
      return <SessionList />;
    case 'newSession':
      return <NewSession />;
    case 'sessionDetail':
      return <SessionDetail id={route.id} />;
    default:
      return <p className="text-sm text-muted-foreground">Not found.</p>;
  }
}

/**
 * Application shell — header chrome plus the three declared routes (`/`, `/sessions/new`,
 * `/sessions/:id`, ARCHITECTURE.md §5 / UI.md).
 * @returns {JSX.Element} The app shell.
 */
function App() {
  return (
    <RouterProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <h1 className="text-lg font-semibold">Agent Control Plane</h1>
          <ConnectionIndicator />
        </header>
        <main className="p-6">
          <RouteView />
        </main>
      </div>
    </RouterProvider>
  );
}

export default App;
