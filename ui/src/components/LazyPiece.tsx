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
 *
 * Only a failed import is handled here. A piece that loaded and then fails to draw has a bug:
 * that error goes on to the page's own error handling, never read as a lost connection.
 */

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

/** The import of a piece failed; `cause` is what the import threw. */
export class PieceLoadError extends Error {
  constructor(cause: unknown) {
    super("a lazily loaded piece could not be imported", { cause });
    this.name = "PieceLoadError";
  }
}

/** Where a piece comes from, and the import new mounts start from (replaced after a failure). */
export interface PieceSource<P> {
  load: Loader<P>;
  current: LazyExoticComponent<ComponentType<P>>;
}

/** Names a piece once, at module level, as `lazy` does: `const DIALOG = pieceSource(() => import(...))`. */
export function pieceSource<P>(load: Loader<P>): PieceSource<P> {
  // A failed import is marked as such and forgotten at once, also when nothing is mounted to
  // catch it any more (the dialog was closed while it loaded): the next mount imports anew.
  // Pieces already drawn keep the import they have.
  const again: Loader<P> = () =>
    load().catch((error: unknown) => {
      source.current = lazy(again);
      throw new PieceLoadError(error);
    });
  const source: PieceSource<P> = { load: again, current: lazy(again) };
  return source;
}

interface BoundaryProps {
  onError: (error: unknown) => void;
  fallback: ReactNode;
  children: ReactNode;
}

class PieceBoundary extends Component<BoundaryProps, { error: unknown }> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    if (error instanceof PieceLoadError) {
      this.props.onError(error.cause);
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) {
      return this.props.children;
    }
    if (error instanceof PieceLoadError) {
      return this.props.fallback;
    }
    // The piece loaded and crashed while drawing: not this boundary's to explain away.
    throw error;
  }
}

/**
 * Draws a lazily loaded piece inside its own boundary. A failed import shows `failed` (or
 * nothing) in its place and never leaves the page; mounting the piece again, or `retry`, imports
 * it anew. Each mounted piece keeps its own import, so one that fails or retries never remounts
 * another that is drawn from the same source.
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
  /** Told when the piece could not be imported, after it fell back. */
  onLoadError?: (error: unknown) => void;
  /** What takes the piece's place after a failed import; `retry` loads it again. Nothing when left out. */
  failed?: (retry: () => void) => ReactNode;
}) {
  // This mount's own import, and the attempts made: a new one mounts a fresh boundary.
  const [state, setState] = useState(() => ({ Loaded: source.current, attempt: 0 }));
  const { Loaded, attempt } = state;
  // The source already holds a fresh import after the failure; this piece takes it up.
  const retry = () => setState({ Loaded: source.current, attempt: attempt + 1 });
  return (
    <PieceBoundary
      key={attempt}
      fallback={failed === undefined ? null : failed(retry)}
      onError={(error) => onLoadError?.(error)}
    >
      <Suspense fallback={pending}>
        <Loaded {...props} />
      </Suspense>
    </PieceBoundary>
  );
}
