import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg } from "../../org/useOrg";
import { settingName } from "../admin/catalog";
import { useNotice } from "../admin/components/Notice";
import { errorText } from "../admin/errors";
import {
  applyBatch,
  exportSettings,
  type ImportItem,
  previewImport,
  type SettingsScope,
  undoChange,
} from "./api";
import { shownValue } from "./rows";
import { refreshLook } from "./SectionPage";
import { useSettingsAccess } from "./SettingsLayout";
import "./settings.css";

interface Pending {
  file: string;
  scope: SettingsScope;
  items: ImportItem[];
}

/**
 * Export and import of settings as JSON. Export holds only what the user may change; an import
 * shows every change against what is set now and applies them together, with undo.
 */
export function TransferSection() {
  const { t, language, timeZone } = useI18n();
  const access = useSettingsAccess();
  const org = useCurrentOrg();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const canServer = access.permissions.isServerAdmin;
  const canOrg = access.orgId !== undefined && access.permissions.has("settings:write");

  async function download(scope: SettingsScope, name: string) {
    setError(undefined);
    try {
      const document_ = await exportSettings(scope);
      const blob = new Blob([`${JSON.stringify(document_, null, 2)}\n`], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (failure) {
      setError(errorText(t, failure));
    }
  }

  async function read(file: File) {
    setError(undefined);
    setPending(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError(t("settings.transfer.notJson"));
      return;
    }
    const isOrg =
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { scope?: unknown }).scope === "org";
    if (isOrg ? !canOrg : !canServer) {
      setError(t("settings.transfer.noAccess"));
      return;
    }
    const scope: SettingsScope =
      isOrg && access.orgId !== undefined
        ? { kind: "org", orgId: access.orgId }
        : { kind: "server" };
    try {
      setPending({ file: file.name, scope, items: await previewImport(scope, parsed) });
    } catch (failure) {
      setError(errorText(t, failure));
    }
  }

  async function apply(current: Pending) {
    const changes = current.items.filter((item) => item.status === "change");
    setBusy(true);
    try {
      const saved = await applyBatch(
        current.scope,
        changes.map((item) => ({ key: item.key, value: item.imported, version: item.version })),
      );
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      refreshLook(queryClient, null);
      setPending(null);
      notice.show({
        message: t("settings.transfer.applied", { count: saved.length }),
        undo: () => {
          void applyBatch(
            current.scope,
            saved.map((setting) => {
              const item = changes.find((change) => change.key === setting.key);
              return undoChange(
                setting.key,
                { value: item?.current, source: item?.source },
                setting.version,
              );
            }),
          ).then(
            async () => {
              await queryClient.invalidateQueries({ queryKey: ["admin"] });
              refreshLook(queryClient, null);
              notice.show({ message: t("settings.transfer.undone") });
            },
            (failure: unknown) => notice.showError(errorText(t, failure)),
          );
        },
      });
    } catch (failure) {
      setError(errorText(t, failure));
    } finally {
      setBusy(false);
    }
  }

  const changeCount = pending?.items.filter((item) => item.status === "change").length ?? 0;
  const shown = (key: string, value: unknown) => shownValue(t, key, value, { language, timeZone });
  return (
    <div className="settings-transfer">
      <div className="settings-card">
        <div className="settings-card__heading">
          <h3>{t("settings.transfer.export")}</h3>
        </div>
        {canServer ? (
          <div className="settings-row">
            <div className="settings-row__text">
              <h4 className="settings-row__title">{t("settings.transfer.exportServer")}</h4>
              <p className="settings-row__description">{t("settings.transfer.exportServerHint")}</p>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void download({ kind: "server" }, "kalzit-server-settings.json")}
              >
                {t("settings.transfer.download")}
              </button>
            </div>
          </div>
        ) : null}
        {canOrg && access.orgId !== undefined ? (
          <div className="settings-row">
            <div className="settings-row__text">
              <h4 className="settings-row__title">
                {t("settings.transfer.exportOrg", { name: org?.name ?? "" })}
              </h4>
              <p className="settings-row__description">{t("settings.transfer.exportOrgHint")}</p>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                className="button button--secondary"
                onClick={() =>
                  void download(
                    { kind: "org", orgId: access.orgId ?? "" },
                    "kalzit-organization-settings.json",
                  )
                }
              >
                {t("settings.transfer.download")}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <div className="settings-card__heading">
          <h3>{t("settings.transfer.import")}</h3>
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <p className="settings-row__description" id={`${id}-hint`}>
              {t("settings.transfer.importHint")}
            </p>
            {error === undefined ? null : (
              <p className="field__error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="settings-row__control">
            <input
              ref={input}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file !== undefined) {
                  void read(file);
                }
              }}
            />
            <button
              type="button"
              className="button button--secondary"
              aria-describedby={`${id}-hint`}
              onClick={() => input.current?.click()}
            >
              {t("settings.transfer.choose")}
            </button>
          </div>
        </div>
        {pending === null ? null : (
          <div className="settings-import">
            <h4 className="settings-row__title">
              {t("settings.transfer.previewTitle", { file: pending.file })}
            </h4>
            <div className="settings-import__scroll">
              <table className="settings-import__table">
                <thead>
                  <tr>
                    <th scope="col">{t("settings.transfer.setting")}</th>
                    <th scope="col">{t("settings.transfer.current")}</th>
                    <th scope="col">{t("settings.transfer.imported")}</th>
                    <th scope="col">{t("settings.transfer.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.items.map((item) => (
                    <tr key={item.key} data-status={item.status}>
                      <th scope="row">{settingName(t, item.key)}</th>
                      <td>{item.status === "unknown" ? "" : shown(item.key, item.current)}</td>
                      <td>{shown(item.key, item.imported)}</td>
                      <td title={item.message}>{t(`settings.transfer.status.${item.status}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="settings-import__actions">
              {changeCount === 0 ? (
                <p className="settings-hint">{t("settings.transfer.nothing")}</p>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) {
                      void apply(pending);
                    }
                  }}
                >
                  {t("settings.transfer.apply", { count: changeCount })}
                </button>
              )}
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setPending(null)}
              >
                {t("settings.transfer.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
