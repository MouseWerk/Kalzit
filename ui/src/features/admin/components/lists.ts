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
  return {
    query,
    items: query.data?.pages.flatMap((page) => page.items),
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  };
}
