import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { Dialog } from "../admin/components/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { setKeyCatalog, type TrustedKey } from "./api";
import { refreshPlugins } from "./hooks";
import { groupedKeyId } from "./status";
import "./plugins.css";

/**
 * Whether a trusted publisher key may sign the catalog index (docs/api/plugins.md, "Catalog"):
 * trusting a key for plugins alone does not let it sign the catalog. Allowing asks first, since
 * the key then decides which plugins and withdrawals the catalog lists; taking it back is
 * immediate.
 */
export function CatalogKeyCell({ trustedKey }: { trustedKey: TrustedKey }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const change = useMutation({
    mutationFn: (allowed: boolean) => setKeyCatalog(trustedKey.keyId, allowed),
    onSuccess: (key) => {
      refreshPlugins(queryClient);
      setAsking(false);
      showToast({
        message: key.maySignCatalog
          ? t("plugins.trust.catalog.allowed", { name: key.name })
          : t("plugins.trust.catalog.disallowed", { name: key.name }),
      });
    },
    onError: (error) => showToast({ message: errorMessage(t, error), error: true }),
  });
  return (
    <>
      {trustedKey.maySignCatalog ? (
        <span className="plugins-stack">
          <span>{t("plugins.trust.catalog.yes")}</span>
          <button
            type="button"
            className="button button--ghost button--small"
            aria-label={t("plugins.trust.catalog.disallowNamed", { name: trustedKey.name })}
            onClick={() => change.mutate(false)}
          >
            {t("plugins.trust.catalog.disallow")}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("plugins.trust.catalog.allowNamed", { name: trustedKey.name })}
          onClick={() => setAsking(true)}
        >
          {t("plugins.trust.catalog.allow")}
        </button>
      )}
      {asking ? (
        <Dialog
          open
          title={t("plugins.trust.catalog.title", { name: trustedKey.name })}
          onClose={() => setAsking(false)}
          footer={
            <div className="plugin-dialog__footer">
              <span className="plugin-dialog__spacer" />
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setAsking(false)}
              >
                {t("admin.common.cancel")}
              </button>
              <button
                type="button"
                className="button button--primary"
                aria-disabled={change.isPending}
                onClick={() => {
                  if (!change.isPending) change.mutate(true);
                }}
              >
                {t("plugins.trust.catalog.confirm")}
              </button>
            </div>
          }
        >
          <div className="plugin-dialog">
            <p className="plugins-hint">
              {t("plugins.trust.catalog.text", { keyId: groupedKeyId(trustedKey.keyId) })}
            </p>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
