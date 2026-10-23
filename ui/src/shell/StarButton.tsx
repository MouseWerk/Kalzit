import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { useI18n } from "../i18n/i18n";
import { showErrorToast } from "../lib/toasts";
import { HOME_KEY, recordView, setStarred, starredQuery } from "./homeApi";
import { apiErrorText } from "./shellErrors";
import "./shellUx.css";

/**
 * Stars or unstars a dashboard for the start page. A toggle button: `aria-pressed` says whether
 * it is starred, the filled icon and weight show it, never an accent frame.
 */
export function StarButton({
  orgId,
  dashboardId,
  compact = false,
}: {
  orgId: string;
  dashboardId: string;
  /** Only the star, quiet, with its name in a tooltip: the dashboard header. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const starred = useQuery(starredQuery(orgId, dashboardId));
  const toggle = useMutation({
    mutationFn: (next: boolean) => setStarred(orgId, dashboardId, next),
    onMutate: (next) => {
      queryClient.setQueryData(starredQuery(orgId, dashboardId).queryKey, next);
    },
    onError: (error, next) => {
      queryClient.setQueryData(starredQuery(orgId, dashboardId).queryKey, !next);
      showErrorToast(apiErrorText(t, error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [HOME_KEY, orgId, "stars"] }),
  });
  if (starred.data === undefined) {
    return null;
  }
  const on = starred.data;
  if (compact) {
    return (
      <IconButton
        icon={on ? "starFilled" : "star"}
        label={on ? t("shell.star.starred") : t("shell.star.star")}
        tipAlign="start"
        className="star-button"
        aria-pressed={on}
        onClick={() => toggle.mutate(!on)}
      />
    );
  }
  return (
    <button
      type="button"
      className="button button--secondary star-button"
      aria-pressed={on}
      onClick={() => toggle.mutate(!on)}
    >
      <Icon name={on ? "starFilled" : "star"} />
      {on ? t("shell.star.starred") : t("shell.star.star")}
    </button>
  );
}

/** Records that the dashboard was opened, once per dashboard page, for the start page. */
export function useRecordView(orgId: string, dashboardId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    recordView(orgId, dashboardId).then(
      () => queryClient.invalidateQueries({ queryKey: [HOME_KEY, orgId, "recents"] }),
      // A view that was not recorded only misses from the start page; nothing to tell.
      () => undefined,
    );
  }, [orgId, dashboardId, queryClient]);
}
