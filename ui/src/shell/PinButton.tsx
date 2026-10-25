import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconButton } from "../components/IconButton";
import { useI18n } from "../i18n/i18n";
import { showErrorToast } from "../lib/toasts";
import { pinsQuery, setPinned } from "./homeApi";
import { apiErrorText } from "./shellErrors";

/**
 * Pins the dashboard to the sidebar or takes it off: a toggle (`aria-pressed`), shown pressed by
 * the neutral tint of a pressed control, never an accent frame.
 */
export function PinButton({ orgId, dashboardId }: { orgId: string; dashboardId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const pins = useQuery(pinsQuery(orgId));
  const toggle = useMutation({
    mutationFn: (next: boolean) => setPinned(orgId, dashboardId, next),
    onError: (error) => showErrorToast(apiErrorText(t, error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: pinsQuery(orgId).queryKey }),
  });
  if (pins.data === undefined) {
    return null;
  }
  const pinned = pins.data.items.some((entry) => entry.id === dashboardId);
  return (
    <IconButton
      icon="pin"
      label={t("shell.pins.pinHere")}
      aria-pressed={pinned}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!pinned)}
    />
  );
}
