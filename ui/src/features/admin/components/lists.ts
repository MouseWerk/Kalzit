import { type QueryKey, useInfiniteQuery } from "@tanstack/react-query";
import type { ListPage } from "../api";

/**
 * A server list read page by page (`Page<T>` with an opaque cursor); "Show more" loads the next
 * page and the items of all loaded pages are shown together.
 */
export function usePagedList<T>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined) => Promise<ListPage<T>>,
  enabled = true,
) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
  const items = query.data?.pages.flatMap((page) => page.items);
  return {
    query,
    /** The loaded items as picker options, with the paging a picker needs. */
    picker: (option: (item: T) => { id: string; label: string }) => ({
      options: items?.map(option),
      error: query.error,
      onRetry: () => void query.refetch(),
      hasMore: query.hasNextPage,
      onMore: () => void query.fetchNextPage(),
      loadingMore: query.isFetchingNextPage,
    }),
    items,
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  };
}
