import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { expectShape, isRecord, request } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { Notice, useNotice } from "../admin/components/Notice";
import { errorText } from "../admin/errors";
import { errorReason, reasonText } from "../datasources/reasons";
import { RowFrame } from "./rows";

/**
 * The outbound proxy's password (docs/api/settings-dashboards.md, "Outbound proxy"). Address,
 * bypass list and user name are ordinary settings with undo above; the password is a secret, so
 * it is only set or removed and never shown.
 */
export interface ProxyPasswordView {
  /** Stored for the proxy address in force. */
  set: boolean;
  /** Stored for another proxy address, so not used until it is set again. */
  stale: boolean;
  /** A user name with an `http://` proxy: the sign-in travels unencrypted to the proxy. */
  clearText: boolean;
}

export const proxyPasswordKey = ["admin", "proxyPassword"] as const;

function isView(value: unknown): value is ProxyPasswordView {
  return (
    isRecord(value) &&
    typeof value.set === "boolean" &&
    typeof value.stale === "boolean" &&
    typeof value.clearText === "boolean"
  );
}

export async function getProxyPassword(): Promise<ProxyPasswordView> {
  return expectShape(
    await request("GET", "/api/admin/network/proxy-password"),
    isView,
    "proxy password",
  );
}

/** Sets the password for the proxy address in force; `null` removes it. */
export async function saveProxyPassword(password: string | null): Promise<ProxyPasswordView> {
  return expectShape(
    await request("PUT", "/api/admin/network/proxy-password", { password }),
    isView,
    "proxy password",
  );
}

export function ProxyPasswordCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const titleId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const view = useQuery({ queryKey: proxyPasswordKey, queryFn: getProxyPassword });
  const save = useMutation({
    mutationFn: (password: string | null) => saveProxyPassword(password),
    onMutate: () => setProblem(undefined),
    onSuccess: (saved, password) => {
      queryClient.setQueryData(proxyPasswordKey, saved);
      setDraft("");
      notice.show({
        message: t(
          password === null ? "settings.proxyPassword.removed" : "settings.proxyPassword.saved",
        ),
      });
    },
    onError: (error) => {
      const reason = errorReason(error);
      setProblem((reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error));
    },
  });
  if (view.data === undefined) {
    return null;
  }
  const state = view.data.set
    ? t("settings.proxyPassword.set")
    : view.data.stale
      ? t("settings.proxyPassword.stale")
      : t("settings.proxyPassword.notSet");
  return (
    <div className="settings-card">
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <RowFrame
        id="network.proxy_password"
        title={t("settings.proxyPassword.title")}
        titleId={titleId}
        description={t("settings.proxyPassword.description")}
        note={view.data.clearText ? t("settings.proxyPassword.clearText") : undefined}
        badge={state}
        error={problem}
        errorId={errorId}
        found={false}
      >
        <form
          className="settings-proxy-password"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (draft !== "" && !save.isPending) {
              save.mutate(draft);
            }
          }}
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            aria-label={t("settings.proxyPassword.input")}
            aria-describedby={problem === undefined ? undefined : errorId}
            aria-invalid={problem === undefined ? undefined : true}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setProblem(undefined);
            }}
          />
          <button
            type="submit"
            className="button button--secondary"
            disabled={draft === "" || save.isPending}
          >
            {t("settings.proxyPassword.save")}
          </button>
          {view.data.set || view.data.stale ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
            >
              {t("settings.proxyPassword.remove")}
            </button>
          ) : null}
        </form>
      </RowFrame>
    </div>
  );
}
