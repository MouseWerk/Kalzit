import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { Dialog } from "../admin/components/Dialog";
import { LoadState } from "../admin/components/Section";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason } from "../datasources/reasons";
import { addKey, listKeys, type PluginList, pluginKeys, removeKey, type TrustedKey } from "./api";
import { CatalogKeyCell } from "./CatalogKey";
import { keyBase64, keyIdOf, parsePublicKey } from "./fingerprint";
import { useHostSwitch } from "./hooks";
import { TableScroll } from "./parts";
import { groupedKeyId } from "./status";
import "./plugins.css";

/** The name typed to confirm a risky switch: the host this page was opened on. */
export function serverName(): string {
  return window.location.hostname || "kalzit";
}

/**
 * Signatur und Vertrauen (board frame 6): the trusted publisher keys with their fingerprints and
 * the plugins they signed, adding a key after comparing its fingerprint, removing one with the
 * plugins it stops; and the switches for unsigned plugins and for Linux hosts without Landlock,
 * each turned on only after a warning and the typed server name.
 */
export function TrustTab({
  list,
  compareKeyId,
  onCompared,
}: {
  list: PluginList;
  /** A key id from a refused package: the add dialog opens and compares with it. */
  compareKeyId: string | null;
  onCompared: () => void;
}) {
  const { t, language } = useI18n();
  const keys = useQuery({ queryKey: pluginKeys.keys, queryFn: ({ signal }) => listKeys(signal) });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TrustedKey | null>(null);
  const titleId = useId();
  const hostSwitch = useHostSwitch();
  const [asking, setAsking] = useState<"unsigned" | "landlock" | null>(null);
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
  const kalzitPlugins = list.items.filter((plugin) => plugin.signer === "kalzit").length;
  const linux = list.platform?.startsWith("linux") === true;

  useEffect(() => {
    if (compareKeyId !== null) {
      setAdding(true);
    }
  }, [compareKeyId]);

  return (
    <div className="plugins">
      <section className="plugins-card" aria-labelledby={titleId}>
        <div className="plugins-card__head">
          <div className="plugins-card__title">
            <h3 id={titleId}>{t("plugins.trust.keys.title")}</h3>
            <p className="plugins-hint">{t("plugins.trust.keys.lead")}</p>
          </div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" />
            {t("plugins.trust.add")}
          </button>
        </div>
        {keys.data === undefined ? (
          <div className="plugins-card__body">
            <LoadState error={keys.error} onRetry={() => void keys.refetch()} />
          </div>
        ) : (
          <TableScroll title={t("plugins.trust.keys.title")}>
            <table className="plugins-table">
              <thead>
                <tr>
                  <th scope="col">{t("plugins.trust.column.publisher")}</th>
                  <th scope="col">{t("plugins.trust.column.fingerprint")}</th>
                  <th scope="col">{t("plugins.trust.column.added")}</th>
                  <th scope="col">{t("plugins.trust.column.plugins")}</th>
                  <th scope="col">{t("plugins.trust.column.catalog")}</th>
                  <th scope="col" className="plugins-table__actions">
                    <span className="visually-hidden">{t("plugins.column.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t("plugins.trust.kalzit")}</th>
                  <td className="plugins-muted">{t("plugins.trust.builtIn")}</td>
                  <td className="plugins-muted">{t("plugins.trust.builtInAdded")}</td>
                  <td>{kalzitPlugins}</td>
                  <td className="plugins-muted">{t("plugins.trust.catalog.always")}</td>
                  <td className="plugins-table__actions plugins-muted plugins-small">
                    {t("plugins.trust.notRemovable")}
                  </td>
                </tr>
                {keys.data.map((key) => (
                  <tr key={key.keyId}>
                    <th scope="row">{key.name}</th>
                    <td>
                      <span className="plugins-mono" translate="no">
                        ed25519 {groupedKeyId(key.keyId)}
                      </span>
                    </td>
                    <td>{key.addedAt > 0 ? dateFormat.format(key.addedAt) : ""}</td>
                    <td>
                      {key.plugins.length === 0 ? (
                        <span className="plugins-muted">0</span>
                      ) : (
                        <span title={key.plugins.join(", ")}>{key.plugins.length}</span>
                      )}
                    </td>
                    <td>
                      <CatalogKeyCell trustedKey={key} />
                    </td>
                    <td className="plugins-table__actions">
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("plugins.trust.removeNamed", { name: key.name })}
                        onClick={() => setRemoving(key)}
                      >
                        {t("plugins.trust.remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section className="plugins-card" aria-labelledby={`${titleId}-unsigned`}>
        <div className="plugins-card__body">
          <div className="plugin-switch">
            <div className="plugin-switch__text">
              <h3 className="plugin-switch__title" id={`${titleId}-unsigned`}>
                {t("plugins.trust.unsigned.title")}
              </h3>
              <p className="plugins-hint">{t("plugins.trust.unsigned.lead")}</p>
            </div>
            <input
              type="checkbox"
              role="switch"
              aria-labelledby={`${titleId}-unsigned`}
              checked={list.allowUnsigned}
              aria-checked={list.allowUnsigned}
              aria-disabled={hostSwitch.isPending}
              onChange={(event) => {
                if (hostSwitch.isPending) return;
                if (event.currentTarget.checked) {
                  setAsking("unsigned");
                } else {
                  hostSwitch.mutate({ allowUnsigned: false });
                }
              }}
            />
          </div>
          <p className="plugins-note plugins-note--danger">
            <Icon name="alert" />
            <span>
              <strong>{t("plugins.trust.unsigned.risk")}</strong>{" "}
              {t("plugins.trust.unsigned.riskText")}
            </span>
          </p>
        </div>
      </section>

      {linux ? (
        <section className="plugins-card" aria-labelledby={`${titleId}-landlock`}>
          <div className="plugins-card__body">
            <div className="plugin-switch">
              <div className="plugin-switch__text">
                <h3 className="plugin-switch__title" id={`${titleId}-landlock`}>
                  {t("plugins.trust.landlock.title")}
                </h3>
                <p className="plugins-hint">
                  {list.landlockAvailable
                    ? t("plugins.trust.landlock.available")
                    : t("plugins.trust.landlock.missing")}
                </p>
              </div>
              <input
                type="checkbox"
                role="switch"
                aria-labelledby={`${titleId}-landlock`}
                checked={list.allowWithoutLandlock}
                aria-checked={list.allowWithoutLandlock}
                aria-disabled={hostSwitch.isPending}
                onChange={(event) => {
                  if (hostSwitch.isPending) return;
                  if (event.currentTarget.checked) {
                    setAsking("landlock");
                  } else {
                    hostSwitch.mutate({ allowWithoutLandlock: false });
                  }
                }}
              />
            </div>
            <p className="plugins-note plugins-note--danger">
              <Icon name="alert" />
              <span>
                <strong>{t("plugins.trust.unsigned.risk")}</strong>{" "}
                {t("plugins.trust.landlock.riskText")}
              </span>
            </p>
          </div>
        </section>
      ) : null}

      {adding ? (
        <AddKeyDialog
          compareKeyId={compareKeyId}
          onClose={() => {
            setAdding(false);
            onCompared();
          }}
        />
      ) : null}
      {removing === null ? null : (
        <RemoveKeyDialog trustedKey={removing} onClose={() => setRemoving(null)} />
      )}
      {asking === null ? null : (
        <RiskDialog
          which={asking}
          busy={hostSwitch.isPending}
          onClose={() => setAsking(null)}
          onConfirm={() =>
            hostSwitch.mutate(
              asking === "unsigned" ? { allowUnsigned: true } : { allowWithoutLandlock: true },
              { onSuccess: () => setAsking(null) },
            )
          }
        />
      )}
    </div>
  );
}

/**
 * The confirmation before a risky switch: what it means, and the server's name typed out. Focus
 * starts on Cancel; the switch turns on with the server's answer.
 */
function RiskDialog({
  which,
  busy,
  onClose,
  onConfirm,
}: {
  which: "unsigned" | "landlock";
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const textId = useId();
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const name = serverName();
  const matches = typed.trim() === name;
  return (
    <Dialog
      open
      title={
        which === "unsigned" ? t("plugins.risk.unsignedTitle") : t("plugins.risk.landlockTitle")
      }
      onClose={onClose}
      initialFocus={cancelRef}
      describedBy={textId}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--danger"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              if (!matches) {
                setWrong(true);
                return;
              }
              onConfirm();
            }}
          >
            {t("plugins.risk.allow")}
          </button>
        </>
      }
    >
      <div className="plugin-dialog">
        <div id={textId} className="plugin-dialog">
          <p className="plugins-hint">{t("plugins.risk.scope")}</p>
          <ul className="plugin-grants">
            {which === "unsigned" ? (
              <>
                <li>{t("plugins.risk.unsignedMarked")}</li>
                <li>{t("plugins.risk.unsignedBanner")}</li>
              </>
            ) : (
              <li>{t("plugins.risk.landlockText")}</li>
            )}
            <li>{t("plugins.risk.audit")}</li>
          </ul>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={inputId}>
            {t("plugins.risk.type")}{" "}
            <strong className="plugins-mono" translate="no">
              {name}
            </strong>
          </label>
          <input
            id={inputId}
            className="input input--mono"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            aria-invalid={wrong && !matches}
            onChange={(event) => {
              setTyped(event.currentTarget.value);
              setWrong(false);
            }}
          />
          {wrong && !matches ? (
            <p className="field__error" role="alert">
              {t("plugins.risk.mismatch")}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Adds a publisher key: the key as pasted, its fingerprint computed here to compare with the
 * publisher's (and with the key id of a refused package), and one Save after the comparison is
 * confirmed. The server's refusals land at their field.
 */
function AddKeyDialog({
  compareKeyId,
  onClose,
}: {
  compareKeyId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const nameId = useId();
  const keyId = useId();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [compared, setCompared] = useState(false);
  const [tried, setTried] = useState(false);
  const parsed = text.trim() === "" ? null : parsePublicKey(text);
  const fingerprint = parsed === null ? null : keyIdOf(parsed);
  const add = useMutation({
    mutationFn: () => addKey(name.trim(), keyBase64(parsed ?? new Uint8Array())),
    onSuccess: (key) => {
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      showToast({ message: t("plugins.trust.added", { name: key.name }) });
      onClose();
    },
  });
  const serverField = isApiError(add.error) ? add.error.field : undefined;
  const reason = errorReason(add.error);
  const nameError =
    tried && name.trim() === ""
      ? t("plugins.trust.nameRequired")
      : serverField === "name"
        ? errorMessage(t, add.error)
        : undefined;
  const keyError =
    tried && text.trim() === ""
      ? t("plugins.trust.keyRequired")
      : text.trim() !== "" && parsed === null
        ? t("plugins.trust.keyInvalid")
        : serverField === "publicKey" || reason?.reason === "plugin.key_exists"
          ? errorMessage(t, add.error)
          : undefined;
  const otherError =
    add.error !== null && nameError === undefined && keyError === undefined
      ? errorMessage(t, add.error)
      : undefined;
  const differs =
    compareKeyId !== null && fingerprint !== null && fingerprint !== compareKeyId.toLowerCase();

  return (
    <Dialog
      open
      title={t("plugins.trust.addTitle")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            // A key other than the one that signed the refused package is never added from here.
            disabled={differs}
            aria-disabled={add.isPending}
            onClick={() => {
              setTried(true);
              if (add.isPending || differs || name.trim() === "" || parsed === null || !compared) {
                return;
              }
              add.mutate();
            }}
          >
            {t("plugins.trust.add")}
          </button>
        </>
      }
    >
      <div className="plugin-dialog">
        <p className="plugins-hint">{t("plugins.trust.addLead")}</p>
        <div className="field">
          <label className="field__label" htmlFor={nameId}>
            {t("plugins.trust.name")}
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            aria-invalid={nameError !== undefined}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {nameError === undefined ? null : (
            <p className="field__error" role="alert">
              {nameError}
            </p>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={keyId}>
            {t("plugins.trust.publicKey")}
          </label>
          <textarea
            id={keyId}
            className="input input--mono"
            rows={3}
            spellCheck={false}
            value={text}
            aria-invalid={keyError !== undefined}
            aria-describedby={`${keyId}-hint`}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setCompared(false);
            }}
          />
          <span className="field__hint" id={`${keyId}-hint`}>
            {t("plugins.trust.publicKeyHint")}
          </span>
          {keyError === undefined ? null : (
            <p className="field__error" role="alert">
              {keyError}
            </p>
          )}
        </div>
        {fingerprint === null ? null : (
          <div className="plugin-fingerprint">
            <span className="plugin-dialog__heading">{t("plugins.trust.fingerprint")}</span>
            <span className="plugin-fingerprint__value" translate="no">
              {groupedKeyId(fingerprint)}
            </span>
            <span className="plugins-hint">{t("plugins.trust.compare")}</span>
            {compareKeyId === null ? null : differs ? (
              <p className="plugins-note plugins-note--danger" role="alert">
                <Icon name="alert" />
                <span>{t("plugins.trust.differs", { keyId: groupedKeyId(compareKeyId) })}</span>
              </p>
            ) : (
              <p className="plugins-note" role="status">
                <Icon name="check" />
                <span>{t("plugins.trust.matchesPackage")}</span>
              </p>
            )}
          </div>
        )}
        <label className="plugin-check">
          <input
            type="checkbox"
            checked={compared}
            disabled={fingerprint === null}
            aria-invalid={tried && !compared}
            onChange={(event) => setCompared(event.currentTarget.checked)}
          />
          <span>{t("plugins.trust.compared")}</span>
        </label>
        {tried && !compared && fingerprint !== null ? (
          <p className="field__error" role="alert">
            {t("plugins.trust.compareFirst")}
          </p>
        ) : null}
        {otherError === undefined ? null : (
          <p className="plugins-note plugins-note--danger" role="alert">
            <Icon name="alert" />
            <span>{otherError}</span>
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Removing a key: asked first; when the server answers that plugins use it, the dialog names the
 * plugins that stop and the updates that are dropped, and a second confirmation removes it.
 */
function RemoveKeyDialog({ trustedKey, onClose }: { trustedKey: TrustedKey; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  const [inUse, setInUse] = useState<{ plugins: string[]; pending: string[] } | null>(null);
  const remove = useMutation({
    mutationFn: (confirm: boolean) => removeKey(trustedKey.keyId, confirm),
    onSuccess: (stopped) => {
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
      showToast({
        message:
          stopped.length === 0
            ? t("plugins.trust.removed", { name: trustedKey.name })
            : t("plugins.trust.removedStopped", {
                name: trustedKey.name,
                plugins: stopped.join(", "),
              }),
      });
      onClose();
    },
    onError: (error) => {
      const reason = errorReason(error);
      if (reason?.reason === "plugin.key_in_use") {
        const split = (value: string | undefined) =>
          (value ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        setInUse({
          plugins: split(reason.params?.plugins),
          pending: split(reason.params?.pending),
        });
        remove.reset();
      }
    },
  });
  const error =
    remove.error !== null && errorReason(remove.error)?.reason !== "plugin.key_in_use"
      ? errorMessage(t, remove.error)
      : undefined;
  return (
    <Dialog
      open
      title={t("plugins.trust.removeTitle", { name: trustedKey.name })}
      onClose={onClose}
      initialFocus={cancelRef}
      describedBy={textId}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--danger"
            aria-disabled={remove.isPending}
            onClick={() => {
              if (!remove.isPending) remove.mutate(inUse !== null);
            }}
          >
            {inUse === null ? t("plugins.trust.remove") : t("plugins.trust.removeAndStop")}
          </button>
        </>
      }
    >
      <div id={textId} className="plugin-dialog">
        {inUse === null ? (
          <p className="plugins-hint">
            {t("plugins.trust.removeText", { keyId: groupedKeyId(trustedKey.keyId) })}
          </p>
        ) : (
          <>
            <p className="plugins-note plugins-note--warning" role="alert">
              <Icon name="alert" />
              <span>{t("plugins.trust.inUse")}</span>
            </p>
            {inUse.plugins.length === 0 ? null : (
              <>
                <h3 className="plugin-dialog__heading">{t("plugins.trust.stops")}</h3>
                <ul className="plugin-used">
                  {inUse.plugins.map((id) => (
                    <li key={id} className="plugins-mono">
                      {id}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {inUse.pending.length === 0 ? null : (
              <>
                <h3 className="plugin-dialog__heading">{t("plugins.trust.dropsUpdates")}</h3>
                <ul className="plugin-used">
                  {inUse.pending.map((id) => (
                    <li key={id} className="plugins-mono">
                      {id}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {error === undefined ? null : (
          <p className="plugins-note plugins-note--danger" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </Dialog>
  );
}
