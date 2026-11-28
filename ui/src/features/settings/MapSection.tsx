import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { hasMessage, type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { forgetMapInfo } from "../../panels/map/source";
import { formatDateTime } from "../admin/components/format";
import { useNotice } from "../admin/components/Notice";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import { errorReason, type Reason, reasonText } from "../datasources/reasons";
import {
  getMapAdmin,
  type MapAdminView,
  type MapField,
  type MapTestResult,
  mapAdminKey,
  saveMapSource,
  switchMapImages,
  type TileSourceFields,
  testMapSource,
} from "./mapApi";
import { RowFrame } from "./rows";
import "./settings.css";
import "./mail.css";
import "./settings075.css";
import "./mapSection.css";

/**
 * Verwaltung > Karte (board docs/design/blueprint/Graph081.dc.html, frame 17): the source of the
 * map images, for the whole server. Off after installation: maps then draw coordinates over the
 * bundled outlines and Kalzit asks no map service. Switching on opens a form of dependent fields
 * with a test and one explicit Save (as for the mail server); the server stores it only after it
 * loaded an image with exactly these values. Switching off applies at once, with undo.
 */
export function MapSection() {
  const view = useQuery({ queryKey: mapAdminKey, queryFn: getMapAdmin });
  if (view.data === undefined) {
    return <LoadState error={view.error} onRetry={() => void view.refetch()} />;
  }
  return <MapCards view={view.data} />;
}

interface Draft {
  urlTemplate: string;
  attribution: string;
  /** As typed. */
  maxZoom: string;
  cacheMaxMb: string;
  cacheTtlDays: string;
  /** Empty keeps the stored key (same host). */
  key: string;
}

const DEFAULTS: TileSourceFields = {
  urlTemplate: "",
  attribution: "",
  maxZoom: 14,
  cacheMaxMb: 2048,
  cacheTtlDays: 7,
};

function toDraft(source: TileSourceFields | null): Draft {
  const s = source ?? DEFAULTS;
  return {
    urlTemplate: s.urlTemplate,
    attribution: s.attribution,
    maxZoom: String(s.maxZoom),
    cacheMaxMb: String(s.cacheMaxMb),
    cacheTtlDays: String(s.cacheTtlDays),
    key: "",
  };
}

/** A whole number as typed; -1 for anything else, which the server refuses at its field. */
function whole(text: string): number {
  const trimmed = text.trim();
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : -1;
}

function fromDraft(draft: Draft): TileSourceFields {
  return {
    urlTemplate: draft.urlTemplate.trim(),
    attribution: draft.attribution.trim(),
    maxZoom: whole(draft.maxZoom),
    cacheMaxMb: whole(draft.cacheMaxMb),
    cacheTtlDays: whole(draft.cacheTtlDays),
  };
}

const FIELDS: readonly (keyof TileSourceFields)[] = [
  "urlTemplate",
  "attribution",
  "maxZoom",
  "cacheMaxMb",
  "cacheTtlDays",
];
const ERROR_FIELDS: readonly MapField[] = [...FIELDS, "key"];

/** Number fields the browser could not send as numbers are named by the request, not the field. */
const NUMBER_PROBLEMS: Partial<Record<keyof TileSourceFields, MessageKey>> = {
  maxZoom: "map.reason.map.max_zoom_invalid",
  cacheMaxMb: "map.reason.map.cache_size_invalid",
  cacheTtlDays: "map.reason.map.cache_ttl_invalid",
};
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  maxZoom: { min: 0, max: 22 },
  cacheMaxMb: { min: 16, max: 102400 },
  cacheTtlDays: { min: 1, max: 365 },
};

/** The text of a reason of the map routes, else of the shared ones (targets, connections). */
function mapReasonText(t: Translate, reason: Reason): string | undefined {
  const key = `map.reason.${reason.reason}`;
  if (hasMessage(key)) {
    return t(key as MessageKey, reason.params ?? {});
  }
  return reasonText(t, reason);
}

interface Problem {
  field: MapField | undefined;
  text: string;
}

function problemOf(t: Translate, error: unknown): Problem {
  const reason = errorReason(error);
  const text = (reason === undefined ? undefined : mapReasonText(t, reason)) ?? errorText(t, error);
  const field = isApiError(error) ? ERROR_FIELDS.find((f) => f === error.field) : undefined;
  return { field, text };
}

/** A number the form cannot send: answered here with the words of the server's own check. */
function numberProblem(t: Translate, fields: TileSourceFields): Problem | null {
  for (const field of ["maxZoom", "cacheMaxMb", "cacheTtlDays"] as const) {
    const range = NUMBER_RANGES[field];
    const key = NUMBER_PROBLEMS[field];
    if (range !== undefined && key !== undefined && fields[field] < 0) {
      return { field, text: t(key, { min: String(range.min), max: String(range.max) }) };
    }
  }
  return null;
}

function bytesText(bytes: number, language: string): string {
  const [value, unit] =
    bytes >= 1024 * 1024 ? [bytes / (1024 * 1024), "megabyte"] : [bytes / 1024, "kilobyte"];
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
}

function MapCards({ view }: { view: MapAdminView }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const on = view.source?.enabled === true;
  const [version, setVersion] = useState(view.version);
  const [editing, setEditing] = useState(on);
  const [draft, setDraft] = useState(() => toDraft(view.source));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [tested, setTested] = useState<{ values: string; result: MapTestResult } | null>(null);
  // Saved or switched, here or elsewhere: the form shows what is stored now.
  if (version !== view.version) {
    setVersion(view.version);
    setDraft(toDraft(view.source));
    setEditing(on);
    setProblem(null);
    setTested(null);
  }
  const current = fromDraft(draft);
  const stored = view.source === null ? null : fromDraft(toDraft(view.source));
  const key = draft.key === "" ? undefined : draft.key;
  const dirty =
    !on || key !== undefined || FIELDS.some((field) => current[field] !== stored?.[field]);
  const values = JSON.stringify({ ...current, key: draft.key });

  const apply = (saved: MapAdminView) => {
    queryClient.setQueryData(mapAdminKey, saved);
    // Maps on this page ask again whether there are map images.
    forgetMapInfo();
  };
  const failed = (error: unknown) => {
    if (isApiError(error, "version_conflict")) {
      void queryClient.invalidateQueries({ queryKey: mapAdminKey });
      setProblem({ field: undefined, text: t("map.admin.conflict") });
      return;
    }
    setProblem(problemOf(t, error));
  };
  const save = useMutation({
    mutationFn: () => saveMapSource(current, key, view.version),
    onSuccess: (saved) => {
      apply(saved);
      notice.show({ message: t("map.admin.saved") });
    },
    onError: failed,
  });
  const test = useMutation({
    mutationFn: () => testMapSource(current, key),
    onMutate: () => {
      setTested(null);
      setProblem(null);
    },
    onSuccess: (result) => setTested({ values, result }),
    onError: (error) => setProblem(problemOf(t, error)),
  });
  const turn = useMutation({
    mutationFn: (enabled: boolean) => switchMapImages(enabled, view.version),
    onSuccess: (saved, enabled) => {
      apply(saved);
      if (enabled) {
        notice.show({ message: t("map.admin.switchedOn") });
      } else {
        notice.show({
          message: t("map.admin.switchedOff"),
          undo: () => void switchMapImages(true, saved.version).then(apply, failed),
        });
      }
    },
    onError: failed,
  });
  const busy = save.isPending || test.isPending || turn.isPending;

  function change(next: Partial<Draft>) {
    setDraft((now) => ({ ...now, ...next }));
    setProblem(null);
  }
  function checked(run: () => void) {
    if (busy) return;
    const wrong = numberProblem(t, current);
    if (wrong !== null) {
      setProblem(wrong);
      return;
    }
    run();
  }
  const errorFor = (field: MapField) => (problem?.field === field ? problem.text : undefined);

  function onSwitch(next: boolean) {
    if (busy) return;
    if (!next && on) {
      turn.mutate(false);
    } else if (!next) {
      // The form was only opened, nothing is stored as on.
      setEditing(false);
      setDraft(toDraft(view.source));
      setProblem(null);
      setTested(null);
    } else {
      setEditing(true);
    }
  }

  const switchId = useId();
  const header = (
    <div className="settings-row">
      <div className="settings-row__text">
        <h3 className="settings-row__title" id={switchId}>
          {t("map.admin.images")}
        </h3>
        <p className="settings-row__description" id={`${switchId}-description`}>
          {t(editing ? "map.admin.imagesOn" : "map.admin.imagesOff")}
        </p>
      </div>
      <div className="settings-row__control">
        <input
          type="checkbox"
          className="settings-switch"
          role="switch"
          checked={editing}
          aria-checked={editing}
          aria-labelledby={switchId}
          aria-describedby={`${switchId}-description`}
          onChange={(event) => onSwitch(event.currentTarget.checked)}
        />
      </div>
    </div>
  );

  if (!editing) {
    return (
      <>
        <section className="settings-card" aria-label={t("map.admin.images")}>
          {header}
          <Outlines />
        </section>
        <p className="notice">
          <Icon name="info" />
          <span>
            <b>{t("map.admin.whyOffTitle")}</b> {t("map.admin.whyOff")}
          </span>
        </p>
        <Way />
      </>
    );
  }

  return (
    <>
      <form
        className="settings-card"
        aria-label={t("map.admin.images")}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) checked(() => save.mutate());
        }}
      >
        {header}
        <Field
          id="map.urlTemplate"
          title={t("map.admin.url")}
          description={t("map.admin.urlHint")}
          error={errorFor("urlTemplate")}
        >
          {(labelled) => (
            <input
              className="input input--mono mail-field"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://karten.example.org/tiles/{z}/{x}/{y}.png"
              value={draft.urlTemplate}
              {...labelled}
              onChange={(event) => change({ urlTemplate: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field
          id="map.attribution"
          title={t("map.admin.attribution")}
          description={t("map.admin.attributionHint")}
          error={errorFor("attribution")}
        >
          {(labelled) => (
            <input
              className="input mail-field"
              autoComplete="off"
              value={draft.attribution}
              {...labelled}
              onChange={(event) => change({ attribution: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field
          id="map.maxZoom"
          title={t("map.admin.maxZoom")}
          description={t("map.admin.maxZoomHint")}
          error={errorFor("maxZoom")}
        >
          {(labelled) => (
            <input
              className="input input--mono mail-port"
              inputMode="numeric"
              autoComplete="off"
              value={draft.maxZoom}
              {...labelled}
              onChange={(event) => change({ maxZoom: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field
          id="map.key"
          title={t("map.admin.key")}
          description={t(view.hasKey ? "map.admin.keyStored" : "map.admin.keyHint")}
          error={errorFor("key")}
        >
          {(labelled) => (
            <input
              className="input mail-field"
              type="password"
              autoComplete="new-password"
              placeholder={view.hasKey ? "••••••••••••" : ""}
              value={draft.key}
              {...labelled}
              onChange={(event) => change({ key: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field
          id="map.cacheMaxMb"
          title={t("map.admin.cacheSize")}
          description={t("map.admin.cacheSizeHint")}
          error={errorFor("cacheMaxMb")}
        >
          {(labelled) => (
            <input
              className="input input--mono mail-port"
              inputMode="numeric"
              autoComplete="off"
              value={draft.cacheMaxMb}
              {...labelled}
              onChange={(event) => change({ cacheMaxMb: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field
          id="map.cacheTtlDays"
          title={t("map.admin.cacheDays")}
          description={t("map.admin.cacheDaysHint")}
          error={errorFor("cacheTtlDays")}
        >
          {(labelled) => (
            <input
              className="input input--mono mail-port"
              inputMode="numeric"
              autoComplete="off"
              value={draft.cacheTtlDays}
              {...labelled}
              onChange={(event) => change({ cacheTtlDays: event.currentTarget.value })}
            />
          )}
        </Field>
        <p className="notice map-admin__note">
          <Icon name="info" />
          <span>
            <b>{t("map.admin.proxyTitle")}</b>{" "}
            {view.proxy === null
              ? t("map.admin.proxyNone")
              : t("map.admin.proxyUsed", { proxy: view.proxy })}
          </span>
        </p>
        <div className="s75-footer">
          <div className="s75-footer__result" role="status" aria-live="polite">
            {problem !== null && problem.field === undefined ? (
              <p className="s75-danger">
                {t("map.admin.testFailed")} {problem.text} {t("map.admin.nothingSaved")}
              </p>
            ) : problem !== null ? (
              <p className="s75-danger">{t("map.admin.checkField")}</p>
            ) : tested !== null && tested.values === values ? (
              <p className="s75-ok">
                {t(tested.result.viaProxy ? "map.admin.testedProxy" : "map.admin.tested", {
                  tile: `${tested.result.z}/${tested.result.x}/${tested.result.y}`,
                  size: bytesText(tested.result.bytes, language),
                  type: tested.result.contentType,
                  ms: String(tested.result.elapsedMs),
                })}
              </p>
            ) : (
              <p className="s75-muted">{t("map.admin.saveTests")}</p>
            )}
          </div>
          <div className="s75-footer__actions">
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={busy}
              onClick={() => checked(() => test.mutate())}
            >
              {test.isPending ? t("map.admin.testing") : t("map.admin.test")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={!dirty}
              onClick={() => {
                setDraft(toDraft(view.source));
                setEditing(on);
                setProblem(null);
                setTested(null);
              }}
            >
              {t("map.admin.discard")}
            </button>
            <button
              type="submit"
              className="button button--primary"
              aria-disabled={busy}
              disabled={!dirty}
            >
              {save.isPending ? t("map.admin.saving") : t("map.admin.save")}
            </button>
          </div>
        </div>
      </form>
      {on ? (
        <section className="settings-card" aria-labelledby="map-state">
          <div className="settings-card__heading">
            <h3 id="map-state">{t("map.admin.stateTitle")}</h3>
          </div>
          <p className="settings-hint map-admin__state">
            {t("map.admin.cacheUsage", {
              count: new Intl.NumberFormat(language).format(view.cache.tiles),
              size: bytesText(view.cache.bytes, language),
            })}
          </p>
          {view.lastError === null ? null : (
            <p className="notice map-admin__note">
              <Icon name="alert" />
              <span>
                <b>
                  {t("map.admin.lastError", {
                    time: formatDateTime(view.lastError.at, language, timeZone),
                  })}
                </b>{" "}
                {mapReasonText(t, {
                  reason: view.lastError.reason,
                  params: view.lastError.params,
                  fallback: view.lastError.message,
                }) ?? view.lastError.message}
              </span>
            </p>
          )}
        </section>
      ) : null}
      <Way />
    </>
  );
}

/** The bundled outlines: always there, no setting. */
function Outlines() {
  const { t } = useI18n();
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <h3 className="settings-row__title">{t("map.admin.outlines")}</h3>
        <p className="settings-row__description">{t("map.admin.outlinesText")}</p>
      </div>
      <div className="settings-row__control">
        <span className="settings-badge">{t("map.admin.builtIn")}</span>
      </div>
    </div>
  );
}

/** The way of a map image, from the browser to the source (frame 17, bottom left). */
function Way() {
  const { t } = useI18n();
  const steps: string[] = [
    t("map.admin.way.browser"),
    "/api/map/tiles/{z}/{x}/{y}",
    t("map.admin.way.cache"),
    t("map.admin.way.proxy"),
    t("map.admin.way.source"),
  ];
  return (
    <section className="settings-card" aria-labelledby="map-way">
      <div className="settings-card__heading">
        <h3 id="map-way">{t("map.admin.way.title")}</h3>
      </div>
      <ol className="map-admin__way">
        {steps.map((step) => (
          <li key={step} className="map-admin__step">
            {step}
          </li>
        ))}
      </ol>
      <p className="settings-hint map-admin__state">{t("map.admin.way.text")}</p>
    </section>
  );
}

/** One field: its own ids for the label, description and error, handed to the control. */
function Field({
  id,
  title,
  description,
  error,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  error: string | undefined;
  children: (labelled: {
    "aria-labelledby": string;
    "aria-describedby": string;
    "aria-invalid"?: true;
  }) => ReactNode;
}) {
  const titleId = useId();
  const errorId = `${titleId}-error`;
  const labelled = {
    "aria-labelledby": titleId,
    "aria-describedby": [error === undefined ? undefined : errorId, `${titleId}-description`]
      .filter((part) => part !== undefined)
      .join(" "),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
  return (
    <RowFrame
      id={id}
      title={title}
      titleId={titleId}
      description={description}
      error={error}
      errorId={errorId}
      found={false}
    >
      {children(labelled)}
    </RowFrame>
  );
}
