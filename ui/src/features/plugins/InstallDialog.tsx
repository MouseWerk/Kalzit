import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { Dialog } from "../admin/components/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason } from "../datasources/reasons";
import {
  approvePlugin,
  installPlugin,
  type PermissionLine,
  type Plugin,
  type PluginList,
  pluginAction,
  removePlugin,
} from "./api";
import { refreshPlugins } from "./hooks";
import { PluginMark } from "./parts";
import { groupedKeyId, permissionText, pluginReasonText, sameLine } from "./status";
import "./plugins.css";

export const STEP_IDS = [
  "package",
  "signature",
  "checksum",
  "platform",
  "version",
  "update",
  "permissions",
] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepState = "done" | "warning" | "busy" | "failed" | "skipped";

export interface Step {
  id: StepId;
  state: StepState;
  title: string;
  detail?: string | undefined;
}

/** The step a refusal belongs to (docs/api/plugins.md, "Reasons"). */
export function failedStep(reason: string | undefined): StepId {
  switch (reason) {
    case "plugin.unsigned_refused":
    case "plugin.signer_untrusted":
    case "plugin.signature_invalid":
    case "plugin.id_reserved":
      return "signature";
    case "plugin.package_invalid":
      return "checksum";
    case "plugin.platform_missing":
    case "plugin.platform_unsupported":
      return "platform";
    case "plugin.kalzit_too_old":
      return "version";
    case "plugin.update_other_id":
    case "plugin.downgrade":
    case "plugin.key_changed":
    case "plugin.kind_taken":
      return "update";
    case "plugin.target_refused":
      return "permissions";
    default:
      // Unreadable, too large, a broken manifest, an upload that broke off, or no reason at all.
      return "package";
  }
}

const STEP_TITLE: Record<StepId, { done: MessageKey; failed: MessageKey; open: MessageKey }> = {
  package: {
    done: "plugins.step.package.done",
    failed: "plugins.step.package.failed",
    open: "plugins.step.package.open",
  },
  signature: {
    done: "plugins.step.signature.done",
    failed: "plugins.step.signature.failed",
    open: "plugins.step.signature.open",
  },
  checksum: {
    done: "plugins.step.checksum.done",
    failed: "plugins.step.checksum.failed",
    open: "plugins.step.checksum.open",
  },
  platform: {
    done: "plugins.step.platform.done",
    failed: "plugins.step.platform.failed",
    open: "plugins.step.platform.open",
  },
  version: {
    done: "plugins.step.version.done",
    failed: "plugins.step.version.failed",
    open: "plugins.step.version.open",
  },
  update: {
    done: "plugins.step.update.done",
    failed: "plugins.step.update.failed",
    open: "plugins.step.update.open",
  },
  permissions: {
    done: "plugins.step.permissions.done",
    failed: "plugins.step.permissions.failed",
    open: "plugins.step.permissions.open",
  },
};

/** The size of the package in the UI's language: "18.4 MB". */
function sizeText(language: string, bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(mb)} MB`;
}

/** Titles of the refused signature step by reason; the board names each case. */
const SIGNATURE_FAILED: Record<string, MessageKey> = {
  "plugin.signature_invalid": "plugins.step.signature.invalid",
  "plugin.signer_untrusted": "plugins.step.signature.untrusted",
  "plugin.unsigned_refused": "plugins.step.signature.unsigned",
  "plugin.id_reserved": "plugins.step.signature.reserved",
};

/** The steps while the server checks the package: the first is read, the rest wait. */
export function checkingSteps(t: Translate, packageText: string): Step[] {
  return STEP_IDS.filter((id) => id !== "update").map((id, index) => ({
    id,
    state: index === 0 ? "done" : index === 1 ? "busy" : "skipped",
    title: t(index === 0 ? STEP_TITLE[id].done : STEP_TITLE[id].open),
    ...(index === 0 ? { detail: packageText } : {}),
  }));
}

/** The steps of a refused package: the ones before the refusal passed, the rest were skipped. */
export function refusedSteps(
  t: Translate,
  error: unknown,
  packageText: string,
  platform: string | undefined,
): Step[] {
  const reason = errorReason(error);
  const failed = failedStep(reason?.reason);
  const at = STEP_IDS.indexOf(failed);
  return STEP_IDS.filter((id) => id !== "update" || failed === "update").map((id) => {
    const index = STEP_IDS.indexOf(id);
    if (index < at) {
      return {
        id,
        state: "done" as const,
        title: t(STEP_TITLE[id].done),
        ...(id === "package" ? { detail: packageText } : {}),
      };
    }
    if (index > at) {
      return { id, state: "skipped" as const, title: t(STEP_TITLE[id].open) };
    }
    const title =
      id === "signature" && reason !== undefined && SIGNATURE_FAILED[reason.reason] !== undefined
        ? t(SIGNATURE_FAILED[reason.reason] as MessageKey)
        : t(STEP_TITLE[id].failed);
    const params = { ...(reason?.params ?? {}) };
    if (reason?.reason === "plugin.platform_missing" && params.platform === undefined && platform) {
      params.platform = platform;
    }
    return {
      id,
      state: "failed" as const,
      title,
      detail:
        reason === undefined ? errorMessage(t, error) : pluginReasonText(t, { ...reason, params }),
    };
  });
}

/** The steps of an accepted package, from the server's answer. */
export function passedSteps(
  t: Translate,
  plugin: Plugin,
  prior: Plugin | undefined,
  packageText: string,
  platform: string | undefined,
): Step[] {
  const signer = plugin.pending?.signer ?? plugin.signer;
  const keyId = plugin.pending?.keyId ?? plugin.keyId;
  const key = keyId === undefined ? "" : groupedKeyId(keyId);
  const signature: Step =
    signer === "unsigned"
      ? {
          id: "signature",
          state: "warning",
          title: t("plugins.step.signature.none"),
          detail: t("plugins.step.signature.noneText"),
        }
      : {
          id: "signature",
          state: "done",
          title: t(STEP_TITLE.signature.done),
          detail:
            signer === "kalzit"
              ? t("plugins.step.signature.kalzit", { key })
              : t("plugins.step.signature.publisher", {
                  publisher: plugin.publisher ?? t("plugins.publisher.unknown"),
                  key,
                }),
        };
  const steps: Step[] = [
    { id: "package", state: "done", title: t(STEP_TITLE.package.done), detail: packageText },
    signature,
    {
      id: "checksum",
      state: "done",
      title: t(STEP_TITLE.checksum.done),
      detail: t("plugins.step.checksum.text"),
    },
    {
      id: "platform",
      state: "done",
      title: t(STEP_TITLE.platform.done),
      detail: t("plugins.step.platform.text", {
        platforms: plugin.platforms.join(", "),
        platform: platform ?? "",
      }),
    },
    { id: "version", state: "done", title: t(STEP_TITLE.version.done) },
  ];
  if (prior !== undefined) {
    steps.push({
      id: "update",
      state: "done",
      title:
        plugin.pending === undefined
          ? t("plugins.step.update.replaces", { version: prior.version })
          : t("plugins.step.update.waits", { version: prior.version }),
      detail:
        plugin.pending === undefined
          ? t("plugins.step.update.replacesText")
          : t("plugins.step.update.waitsText", { version: prior.version }),
    });
  }
  return steps;
}

export interface Grant {
  line: PermissionLine;
  /** `new` in this version, `same` as before, or `first` on a first install. */
  change: "new" | "same" | "first";
}

/** The targets to approve, each marked as new or as before against the installed version. */
export function grantsOf(plugin: Plugin, prior: Plugin | undefined): Grant[] {
  const lines = plugin.pending?.permissions ?? plugin.permissions;
  if (prior === undefined) {
    return lines.map((line) => ({ line, change: "first" }));
  }
  const before = plugin.pending === undefined ? prior.permissions : plugin.permissions;
  return lines.map((line) => ({
    line,
    change: before.some((old) => sameLine(old, line)) ? "same" : "new",
  }));
}

export function StepList({ steps, busy }: { steps: readonly Step[]; busy: boolean }) {
  const { t } = useI18n();
  return (
    <ol className="plugin-steps" aria-busy={busy}>
      {steps.map((step) => (
        <li
          key={step.id}
          className="plugin-step"
          data-state={step.state}
          aria-busy={step.state === "busy" ? true : undefined}
        >
          <span className="plugin-step__mark">
            {step.state === "done" ? (
              <Icon name="check" />
            ) : step.state === "failed" || step.state === "warning" ? (
              <Icon name="alert" />
            ) : step.state === "busy" ? (
              <Icon name="refresh" />
            ) : (
              <Icon name="clock" />
            )}
          </span>
          <span className="plugin-step__text">
            <span className="plugin-step__title">
              {step.title}
              <span className="visually-hidden"> ({t(`plugins.step.state.${step.state}`)})</span>
            </span>
            {step.detail === undefined ? null : (
              <span className="plugin-step__detail">{step.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

type Stage =
  | { kind: "choose" }
  | { kind: "checking"; packageText: string }
  | { kind: "refused"; packageText: string; error: unknown }
  | { kind: "review"; packageText: string; plugin: Plugin; prior: Plugin | undefined };

/**
 * Install from a file (board frames 3 and 4): the package is uploaded, the server checks it,
 * and the dialog shows the checks from its answer, then the permissions to grant, marked new
 * where an update adds them. Nothing runs before the administrator grants them: a new plugin is
 * stored disabled and unapproved, and Cancel removes it again. A refused package names the step
 * and the reason.
 */
export function InstallDialog({
  list,
  onClose,
  onTrustKey,
  onAllowUnsigned,
}: {
  list: PluginList;
  onClose: () => void;
  onTrustKey: (keyId: string) => void;
  onAllowUnsigned: () => void;
}) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const inputId = useId();
  const [stage, setStage] = useState<Stage>({ kind: "choose" });
  const [over, setOver] = useState(false);
  const [granted, setGranted] = useState(false);
  const [start, setStart] = useState(true);
  const [missingGrant, setMissingGrant] = useState(false);

  const refresh = () => refreshPlugins(queryClient);

  const upload = useMutation({
    mutationFn: installPlugin,
    onSuccess: (plugin, _file) => {
      const prior = list.items.find((item) => item.id === plugin.id);
      setStage((current) => ({
        kind: "review",
        packageText: current.kind === "checking" ? current.packageText : "",
        plugin,
        prior,
      }));
      refresh();
    },
    onError: (error) => {
      setStage((current) => ({
        kind: "refused",
        packageText: current.kind === "checking" ? current.packageText : "",
        error,
      }));
    },
  });

  const confirm = useMutation({
    mutationFn: async ({ plugin, run }: { plugin: Plugin; run: boolean }) => {
      let answer = plugin;
      const version = plugin.pending?.version ?? (plugin.approved ? undefined : plugin.version);
      if (version !== undefined) {
        answer = await approvePlugin(plugin.id, version);
      }
      if (run && !answer.enabled) {
        answer = await pluginAction(plugin.id, "enable");
      }
      return answer;
    },
    onSuccess: (plugin) => {
      refresh();
      showToast({
        message: t("plugins.install.done", { name: plugin.name, version: plugin.version }),
      });
      onClose();
    },
  });

  const discard = useMutation({
    mutationFn: removePlugin,
    onSettled: () => {
      refresh();
      onClose();
    },
  });

  function pick(file: File | undefined) {
    if (file === undefined) {
      return;
    }
    const packageText = `${file.name} · ${sizeText(language, file.size)}`;
    setGranted(false);
    setMissingGrant(false);
    setStage({ kind: "checking", packageText });
    upload.mutate(file);
  }

  function cancel() {
    // A new plugin was stored only for this review: Cancel takes it back.
    if (stage.kind === "review" && stage.prior === undefined && !confirm.isPending) {
      discard.mutate(stage.plugin.id);
      return;
    }
    onClose();
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setOver(false);
    pick(event.dataTransfer.files[0]);
  }

  const choose = (
    <label
      htmlFor={inputId}
      className="plugin-drop"
      data-over={over}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <Icon name="upload" />
      <span>{t("plugins.install.drop")}</span>
      <span className="plugins-hint">{t("plugins.install.dropHint")}</span>
      <input
        id={inputId}
        className="visually-hidden"
        type="file"
        accept=".zip,.kalzit-plugin,application/zip"
        onChange={(event) => {
          pick(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );

  let body = null;
  let footer = null;
  let title = t("plugins.install.title");
  if (stage.kind === "choose") {
    body = (
      <div className="plugin-dialog">
        <p className="plugins-hint">{t("plugins.install.lead")}</p>
        {choose}
      </div>
    );
    footer = (
      <button type="button" className="button button--secondary" onClick={onClose}>
        {t("admin.common.cancel")}
      </button>
    );
  } else if (stage.kind === "checking") {
    body = (
      <div className="plugin-dialog">
        <h3 className="plugin-dialog__heading">{t("plugins.install.checking")}</h3>
        <StepList steps={checkingSteps(t, stage.packageText)} busy />
        <p className="plugins-hint">{t("plugins.install.checkingText")}</p>
      </div>
    );
    footer = (
      <button type="button" className="button button--secondary" onClick={onClose}>
        {t("admin.common.cancel")}
      </button>
    );
  } else if (stage.kind === "refused") {
    const reason = errorReason(stage.error);
    const steps = refusedSteps(t, stage.error, stage.packageText, list.platform);
    const failed = steps.find((step) => step.state === "failed");
    const keyId = reason?.params?.keyId;
    title = t("plugins.install.refusedTitle");
    body = (
      <div className="plugin-dialog">
        <p className="plugins-note plugins-note--danger" role="alert">
          <Icon name="alert" />
          <span>
            <strong>{failed?.title}</strong> {t("plugins.install.notInstalled")} {failed?.detail}
          </span>
        </p>
        <StepList steps={steps} busy={false} />
        {reason?.reason === "plugin.signature_invalid" ? (
          <p className="plugins-hint">{t("plugins.install.invalidHint")}</p>
        ) : null}
        {reason?.reason === "plugin.signer_untrusted" ? (
          <p className="plugins-hint">{t("plugins.install.untrustedHint")}</p>
        ) : null}
        {reason?.reason === "plugin.platform_missing" ? (
          <p className="plugins-hint">
            {t("plugins.install.platformHint", { platform: list.platform ?? "" })}
          </p>
        ) : null}
      </div>
    );
    footer = (
      <div className="plugin-dialog__footer">
        {reason?.reason === "plugin.signer_untrusted" && keyId !== undefined ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onTrustKey(keyId)}
          >
            {t("plugins.install.trustKey")}
          </button>
        ) : null}
        {reason?.reason === "plugin.unsigned_refused" ? (
          <button type="button" className="button button--secondary" onClick={onAllowUnsigned}>
            {t("plugins.install.toTrust")}
          </button>
        ) : null}
        <button
          type="button"
          className="button button--secondary"
          onClick={() => setStage({ kind: "choose" })}
        >
          {t("plugins.install.another")}
        </button>
        <span className="plugin-dialog__spacer" />
        <button type="button" className="button button--ghost" onClick={onClose}>
          {t("plugins.install.close")}
        </button>
      </div>
    );
  } else {
    const { plugin, prior } = stage;
    const version = plugin.pending?.version ?? plugin.version;
    const grants = grantsOf(plugin, prior);
    const nothingToApprove = plugin.approved && plugin.pending === undefined;
    const changes = grants.filter((grant) => grant.change === "new").length;
    title = t("plugins.install.reviewTitle", { name: plugin.name, version });
    body = (
      <div className="plugin-dialog">
        <div className="plugins-name">
          <PluginMark name={plugin.name} large />
          <span className="plugins-name__text">
            <span className="plugins-muted">
              {prior === undefined
                ? t("plugins.install.byPublisher", {
                    publisher: plugin.publisher ?? t("plugins.publisher.unknown"),
                  })
                : t("plugins.install.updateOf", {
                    publisher: plugin.publisher ?? t("plugins.publisher.unknown"),
                    version: prior.version,
                  })}
            </span>
          </span>
        </div>
        <h3 className="plugin-dialog__heading">{t("plugins.install.checks")}</h3>
        <StepList
          steps={passedSteps(t, plugin, prior, stage.packageText, list.platform)}
          busy={false}
        />
        <div className="live-region" role="status">
          {t("plugins.install.passed")}
        </div>
        {plugin.sandboxWarning === "landlock_missing" ? (
          <p className="plugins-note plugins-note--warning">
            <Icon name="alert" />
            <span>{pluginReasonText(t, { reason: "plugin.landlock_missing" })}</span>
          </p>
        ) : null}
        {nothingToApprove ? (
          <p className="plugins-note">
            <Icon name="check" />
            <span>{t("plugins.install.nothingToApprove")}</span>
          </p>
        ) : (
          <>
            <h3 className="plugin-dialog__heading">{t("plugins.install.grants")}</h3>
            {grants.length === 0 ? (
              <p className="plugins-hint">{t("plugins.permission.none")}</p>
            ) : (
              <ul className="plugin-grants">
                {grants.map((grant) => (
                  <li
                    key={JSON.stringify(grant.line)}
                    className="plugin-grants__item"
                    data-new={grant.change === "new"}
                  >
                    <span className="plugin-grants__target">{permissionText(t, grant.line)}</span>
                    {grant.change === "first" ? null : (
                      <span
                        className={
                          grant.change === "new"
                            ? "plugins-chip plugins-chip--strong"
                            : "plugins-chip"
                        }
                      >
                        {grant.change === "new"
                          ? t("plugins.grant.new", { version })
                          : t("plugins.grant.same")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="plugins-hint">
              {t("plugins.install.grantsText")}
              {changes > 0 ? ` ${t("plugins.install.changes", { count: changes })}` : ""}
            </p>
            <label className="plugin-check">
              <input
                type="checkbox"
                checked={granted}
                aria-invalid={missingGrant}
                onChange={(event) => {
                  setGranted(event.currentTarget.checked);
                  setMissingGrant(false);
                }}
              />
              <span>{t("plugins.install.grant")}</span>
            </label>
            {missingGrant ? (
              <p className="field__error" role="alert">
                {t("plugins.install.grantFirst")}
              </p>
            ) : null}
          </>
        )}
        {plugin.enabled ? null : (
          <label className="plugin-check">
            <input
              type="checkbox"
              checked={start}
              onChange={(event) => setStart(event.currentTarget.checked)}
            />
            <span>{t("plugins.install.start")}</span>
          </label>
        )}
        {confirm.error === null ? null : (
          <p className="plugins-note plugins-note--danger" role="alert">
            <Icon name="alert" />
            <span>{errorMessage(t, confirm.error)}</span>
          </p>
        )}
      </div>
    );
    footer = (
      <div className="plugin-dialog__footer">
        <span className="plugin-dialog__spacer" />
        <button type="button" className="button button--secondary" onClick={cancel}>
          {t("admin.common.cancel")}
        </button>
        <button
          type="button"
          className="button button--primary"
          aria-disabled={confirm.isPending}
          onClick={() => {
            if (confirm.isPending) return;
            if (!nothingToApprove && !granted) {
              setMissingGrant(true);
              return;
            }
            confirm.mutate({ plugin, run: start && !plugin.enabled });
          }}
        >
          {nothingToApprove && plugin.enabled
            ? t("plugins.install.close")
            : t("plugins.install.confirm")}
        </button>
      </div>
    );
  }

  return (
    <Dialog open title={title} onClose={cancel} wide footer={footer}>
      {body}
    </Dialog>
  );
}
