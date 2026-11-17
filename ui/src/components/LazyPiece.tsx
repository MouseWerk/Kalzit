import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";

/**
 * A piece of a page that loads on first use (a dialog, a badge, a section's body) and may fail
 * to: a deploy replaced its chunk, the network dropped. Without a boundary of its own such a
 * failure reaches the root error page and takes the whole page with it. Here the piece alone
 * falls back, the page is told, and the next attempt fetches again, since `lazy` alone keeps a
 * failed import for good.
 */

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

/** Where a piece comes from, and its current import (replaced after a failure). */
export interface PieceSource<P> {
  load: Loader<P>;
  current: LazyExoticComponent<ComponentType<P>>;
}

/** Names a piece once, at module level, as `lazy` does: `const DIALOG = pieceSource(() => import(...))`. */
export function pieceSource<P>(load: Loader<P>): PieceSource<P> {
  // A failed import is forgotten at once, also when nothing is mounted to catch it any more (the
  // dialog was closed while it loaded): the next mount imports anew.
  const again: Loader<P> = () =>
    load().catch((error: unknown) => {
      source.current = lazy(again);
      throw error;
    });
  const source: PieceSource<P> = { load: again, current: lazy(again) };
  return source;
}

interface BoundaryProps {
  onError: (error: unknown) => void;
  fallback: ReactNode;
  children: ReactNode;
}

class PieceBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Draws a lazily loaded piece inside its own boundary. A failure shows `failed` (or nothing) in
 * its place and never leaves the page; mounting the piece again, or `retry`, imports it anew.
 */
export function LazyPiece<P extends object>({
  source,
  props,
  pending = null,
  onLoadError,
  failed,
}: {
  source: PieceSource<P>;
  props: P;
  /** Shown while the piece loads; nothing when left out. */
  pending?: ReactNode;
  /** Told when the piece could not load or draw, after it fell back. */
  onLoadError?: (error: unknown) => void;
  /** What takes the piece's place after a failure; `retry` loads it again. Nothing when left out. */
  failed?: (retry: () => void) => ReactNode;
}) {
  // Counts the attempts: a new one mounts a fresh boundary around a fresh import.
  const [attempt, setAttempt] = useState(0);
  const Loaded = source.current;
  const retry = () => {
    source.current = lazy(source.load);
    setAttempt((count) => count + 1);
  };
  return (
    <PieceBoundary
      key={attempt}
      fallback={failed === undefined ? null : failed(retry)}
      onError={(error) => {
        // The failed import is forgotten, so the next mount of the piece tries again.
        source.current = lazy(source.load);
        onLoadError?.(error);
      }}
    >
      <Suspense fallback={pending}>
        <Loaded {...props} />
      </Suspense>
    </PieceBoundary>
  );
}
