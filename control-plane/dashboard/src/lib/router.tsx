/**
 * Minimal client-side router — exactly the three routes UI.md declares (`/`, `/sessions/new`,
 * `/sessions/:id`). A dependency like react-router is unnecessary weight for three static routes
 * (YAGNI); this is ~30 lines of `history`/`popstate` glue instead.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

export type Route =
  | { name: 'sessionList' }
  | { name: 'newSession' }
  | { name: 'sessionDetail'; id: string }
  | { name: 'notFound' };

function parsePath(pathname: string): Route {
  if (pathname === '/') return { name: 'sessionList' };
  if (pathname === '/sessions/new') return { name: 'newSession' };
  const match = pathname.match(/^\/sessions\/([^/]+)$/);
  if (match) return { name: 'sessionDetail', id: decodeURIComponent(match[1]) };
  return { name: 'notFound' };
}

const NavigateContext = createContext<(path: string) => void>(() => {});

export function useNavigate(): (path: string) => void {
  return useContext(NavigateContext);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parsePath(window.location.pathname),
  );

  useEffect(() => {
    const onPopState = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return route;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  return (
    <NavigateContext.Provider value={navigate}>
      {children}
    </NavigateContext.Provider>
  );
}

export function Link({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
