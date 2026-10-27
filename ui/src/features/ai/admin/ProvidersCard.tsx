import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { LoadState } from "../../admin/components/Section";
import {
  type AiProvider,
  type AiScope,
  aiAdminKeys,
  listAiProviders,
  providerHost,
} from "../adminApi";
import { kindLabel, ProviderDialog } from "./ProviderDialog";
import "../../datasources/datasources.css";
import "./ai-admin.css";

/** The status of a provider from its last test, as the data source list shows a source's. */
function providerStatus(
  t: Translate,
  provider: AiProvider,
): { status: "connected" | "unreachable" | "untested"; text: string } {
  const test = provider.lastTest;
  if (test === undefined) {
    return { status: "untested", text: t("ai.admin.status.untested") };
  }
  if (test.ok) {
    return { status: "connected", text: t("ai.admin.status.ready") };
  }
  if (test.reason === "ai.provider_unauthorized" || test.reason === "ai.key_unreadable") {
    return { status: "unreachable", text: t("ai.admin.status.keyRefused") };
  }
  if (test.reason === "ai.provider_unreachable" || test.reason === "ai.provider_timeout") {
    return { status: "unreachable", text: t("ai.admin.status.unreachable") };
  }
  return { status: "unreachable", text: t("ai.admin.status.failed") };
}

/** Whether a provider passed its connection test since its last change. */
export function isReady(provider: AiProvider): boolean {
  return provider.lastTest?.ok === true;
}

export function useAiProviders(scope: AiScope) {
  return useQuery({
    queryKey: aiAdminKeys.providers(scope),
    queryFn: ({ signal }) => listAiProviders(scope, signal),
  });
}

type Editing = { mode: "add" } | { mode: "edit"; provider: AiProvider } | null;

/**
 * The providers of the server or of one organization (board frames 1 and 2): name, kind, base
 * URL, model, the host data goes to and the status of the last test, with "Add provider" and
 * "Edit" in a dialog. Without providers the card says what to connect.
 */
export function ProvidersCard({
  scope,
  canWrite,
  addAllowed = true,
  notAllowedText,
  onNotAllowed,
}: {
  scope: AiScope;
  canWrite: boolean;
  /** False when the server forbids own providers of organizations: no "Add". */
  addAllowed?: boolean;
  /** Said instead of "Add" while adding is not allowed. */
  notAllowedText?: string;
  onNotAllowed?: () => void;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const providers = useAiProviders(scope);
  const [editing, setEditing] = useState<Editing>(null);
  const timeFormat = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" });
  const mayAdd = canWrite && addAllowed;
  const addButton = mayAdd ? (
    <button
      type="button"
      className="button button--secondary"
      onClick={() => setEditing({ mode: "add" })}
    >
      <Icon name="plus" />
      {t("ai.admin.providers.add")}
    </button>
  ) : null;

  let body: ReactNode;
  if (providers.data === undefined) {
    body = (
      <div className="ai-card__body">
        <LoadState error={providers.error} onRetry={() => void providers.refetch()} />
      </div>
    );
  } else if (providers.data.length === 0) {
    body = (
      <div className="ai-empty">
        <span className="ai-empty__icon" aria-hidden="true">
          <Icon name="activity" />
        </span>
        <h4 className="ai-empty__title">{t("ai.admin.providers.emptyTitle")}</h4>
        <p className="ai-empty__text">
          {scope.kind === "server"
            ? t("ai.admin.providers.emptyText")
            : t("ai.org.providers.emptyText")}
        </p>
        {addAllowed || notAllowedText === undefined ? null : (
          <p className="ai-empty__text">{notAllowedText}</p>
        )}
        {mayAdd ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => setEditing({ mode: "add" })}
          >
            <Icon name="plus" />
            {t("ai.admin.providers.add")}
          </button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="ai-table-wrap">
        <table className="ai-table">
          <thead>
            <tr>
              <th scope="col">{t("ai.admin.providers.name")}</th>
              <th scope="col">{t("ai.admin.providers.kind")}</th>
              <th scope="col">{t("ai.admin.providers.baseUrl")}</th>
              <th scope="col">{t("ai.admin.providers.model")}</th>
              <th scope="col">{t("ai.admin.providers.host")}</th>
              <th scope="col">{t("ai.admin.providers.status")}</th>
              {canWrite ? (
                <th scope="col">
                  <span className="visually-hidden">{t("ai.admin.providers.actions")}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {providers.data.map((provider) => {
              const status = providerStatus(t, provider);
              return (
                <tr key={provider.id}>
                  <td>
                    <span className="ai-table__name">
                      <span>{provider.name}</span>
                      {provider.isDefault ? (
                        <span className="ai-chip">{t("ai.admin.providers.default")}</span>
                      ) : null}
                    </span>
                  </td>
                  <td>{kindLabel(t, provider.kind)}</td>
                  <td>
                    <span className="ai-mono ai-muted" translate="no">
                      {provider.baseUrl}
                    </span>
                  </td>
                  <td>
                    <span className="ai-mono" translate="no">
                      {provider.model}
                    </span>
                  </td>
                  <td>
                    <span className="ai-mono" translate="no">
                      {providerHost(provider.baseUrl)}
                    </span>
                  </td>
                  <td>
                    <span className="ai-table__status">
                      <span className="ds-status" data-status={status.status}>
                        <span className="ds-status__dot" aria-hidden="true" />
                        <span>{status.text}</span>
                      </span>
                      {provider.lastTest === undefined ? null : (
                        <span className="ai-muted ai-small">
                          {timeFormat.format(provider.lastTest.at)}
                        </span>
                      )}
                    </span>
                  </td>
                  {canWrite ? (
                    <td className="ai-table__actions">
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("ai.admin.providers.editNamed", { name: provider.name })}
                        onClick={() => setEditing({ mode: "edit", provider })}
                      >
                        {t("ai.admin.providers.edit")}
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <div className="ai-card__head">
        <div className="ai-card__title">
          <h3 id={titleId}>{t("ai.admin.providers.title")}</h3>
          <p className="settings-hint">{t("ai.admin.providers.lead")}</p>
          {!addAllowed && notAllowedText !== undefined && (providers.data?.length ?? 0) > 0 ? (
            <p className="settings-hint">{notAllowedText}</p>
          ) : null}
        </div>
        {(providers.data?.length ?? 0) > 0 ? addButton : null}
      </div>
      {body}
      {editing === null ? null : (
        <ProviderDialog
          scope={scope}
          provider={editing.mode === "edit" ? editing.provider : undefined}
          onClose={() => setEditing(null)}
          {...(onNotAllowed === undefined ? {} : { onNotAllowed })}
        />
      )}
    </section>
  );
}
