import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { errorMessage } from "../dashboards/ui/errors";
import { KINDS_KEY } from "../datasources/api";
import { type HostSwitches, type PluginList, patchHostSwitches, pluginKeys } from "./api";

/**
 * Reads the plugins again after a change, and the data source kinds, which gain or lose a plugin
 * kind when it is approved, turned on or off, or removed.
 */
export function refreshPlugins(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
  void queryClient.invalidateQueries({ queryKey: [KINDS_KEY] });
}

/** Changes a host switch; the page shows the server's answer, never the click alone. */
export function useHostSwitch() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: patchHostSwitches,
    onSuccess: (switches: HostSwitches, patch) => {
      queryClient.setQueryData<PluginList>(pluginKeys.list, (old) =>
        old === undefined ? old : { ...old, ...switches },
      );
      refreshPlugins(queryClient);
      const message =
        patch.allowUnsigned === true
          ? t("plugins.trust.unsigned.allowed")
          : patch.allowUnsigned === false
            ? t("plugins.trust.unsigned.refused")
            : patch.allowWithoutLandlock === true
              ? t("plugins.trust.landlock.allowed")
              : t("plugins.trust.landlock.required");
      showToast({ message });
    },
    onError: (error) => showToast({ message: errorMessage(t, error), error: true }),
  });
}
