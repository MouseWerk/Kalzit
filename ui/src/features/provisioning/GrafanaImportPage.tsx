import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import type { ImportReport } from "../../api/generated/shapes";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { STACK_ROLES } from "../../components/stackTable";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { writePreference } from "../../lib/storage";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { DASHBOARDS_KEY, foldersQuery } from "../dashboards/api";
import { FolderPicker } from "../dashboards/ToolDialogs";
import { errorMessage } from "../dashboards/ui/errors";
import { datasourcesQuery } from "../datasources/api";
import { errorReason } from "../datasources/reasons";
import { importGrafana } from "./api";
import {
  type GrafanaFile,
  type GrafanaProblem,
  type GrafanaSource,
  MAX_IMPORT_BYTES,
  readGrafana,
  type Suggestion,
  suggestSource,
  withTitle,
} from "./grafana";
import { panelCounts, ReportView } from "./ImportReport";
import { noticeKey } from "./importNotice";
import "../admin/admin.css";
import "./provisioning.css";

/** Spelled out like the other roles of the stacking table (components/stackTable.ts). */
const ROW_HEADER = { role: "rowheader" } as const;

const STEPS = ["file", "sources", "report", "done"] as const;
type Step = (typeof STEPS)[number];

const STEP_LABEL: Record<Step, MessageKey> = {
  file: "provisioning.import.stepFile",
  sources: "provisioning.import.stepSources",
  report: "provisioning.import.stepReport",
  done: "provisioning.import.stepDone",
};

const PROBLEM_TEXT: Record<GrafanaProblem | "tooLarge" | "unreadable", MessageKey> = {
  json: "provisioning.import.notJson",
  notDashboard: "provisioning.import.notDashboard",
  tooLarge: "provisioning.import.tooLarge",
  unreadable: "provisioning.import.unreadable",
};

const SUGGESTION_TEXT: Record<Suggestion, MessageKey> = {
  sameName: "provisioning.import.sameName",
  sameKind: "provisioning.import.sameKind",
  none: "provisioning.import.noSource",
};

/** The oldest schema the import reads without approximating much more. */
const OLD_SCHEMA = 16;

function sizeText(bytes: number, language: string): string {
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  return bytes >= 1024 * 1024
    ? `${format.format(bytes / (1024 * 1024))} MB`
    : `${format.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

/**
 * "Grafana-Dashboard importieren" (board Provisioning.dc.html, frames 9 to 12): the file, a
 * Kalzit data source for each one the file names, then the report of what is converted,
 * approximated and skipped. Nothing is created before the last step; the server only reads the
 * description, runs nothing and installs nothing.
 */
export function GrafanaImportPage() {
  const { t, language } = useI18n();
  const ids = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const permissions = useOrgPermissions();
  const search = useSearch({ strict: false }) as { folder?: string };
  const folders = useQuery({ ...foldersQuery(orgId), enabled: orgId !== "" });
  const sources = useQuery({ ...datasourcesQuery(orgId), enabled: orgId !== "" });
  const available = (sources.data ?? []).map((s) => ({ id: s.id, kind: s.kind, name: s.name }));

  const [step, setStep] = useState<Step>("file");
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [read, setRead] = useState<GrafanaFile | null>(null);
  const [problem, setProblem] = useState<keyof typeof PROBLEM_TEXT | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(search.folder ?? null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const title = t("provisioning.import.title");
  const documentTitle = t("app.documentTitle", { page: title });
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);
  // Each step starts at its heading, so keyboard and screen reader users land where it begins.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  function take(text: string, from: { name: string; size: number } | null) {
    const result = readGrafana(text);
    if (typeof result === "string") {
      setProblem(result);
      setRead(null);
      setFile(null);
      return;
    }
    setProblem(null);
    setRead(result);
    setFile(from);
    setName(result.title);
    setMapping(
      Object.fromEntries(
        result.sources.map((source) => [source.key, suggestSource(source, available).id]),
      ),
    );
    setReport(null);
  }

  async function takeFile(picked: File | undefined) {
    if (picked === undefined) return;
    if (picked.size > MAX_IMPORT_BYTES) {
      setProblem("tooLarge");
      setRead(null);
      return;
    }
    take(await picked.text(), { name: picked.name, size: picked.size });
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setOver(false);
    void takeFile(event.dataTransfer.files[0]);
  }

  const request = (dryRun: boolean) => ({
    dashboard: withTitle(read?.document, name.trim() === "" ? (read?.title ?? "") : name.trim()),
    datasources: Object.fromEntries(Object.entries(mapping).filter(([, id]) => id !== "")),
    ...(folder === null ? {} : { folderId: folder }),
    dryRun,
  });

  const preview = useMutation({
    mutationFn: () => importGrafana(orgId, request(true)),
    onSuccess: (answer) => {
      setReport(answer.report);
      setStep("report");
    },
    onError: (error) => {
      if (errorReason(error)?.reason === "dashboards.import_unreadable") {
        setProblem("unreadable");
        setStep("file");
      }
    },
  });

  const create = useMutation({
    mutationFn: () => importGrafana(orgId, request(false)),
    onSuccess: async (answer) => {
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY] });
      if (answer.dashboardId === null) return;
      const panels = panelCounts(answer.report);
      writePreference(noticeKey(answer.dashboardId), JSON.stringify({ at: Date.now(), ...panels }));
      void navigate({
        to: "/dashboards/$dashboardId",
        params: { dashboardId: answer.dashboardId },
        search: {},
      });
    },
  });

  const canWriteTop = permissions.has("dashboards:write");
  const folderName =
    folder === null
      ? t("dashboards.folders.none")
      : (folders.data?.find((f) => f.id === folder)?.name ?? "");
  const mapped = read?.sources.filter((source) => (mapping[source.key] ?? "") !== "").length ?? 0;
  const left = (read?.sources.length ?? 0) - mapped;
  const stepIndex = STEPS.indexOf(step);
  const failure = (error: unknown) =>
    isApiError(error, "forbidden")
      ? t("provisioning.import.forbidden", { folder: folderName })
      : errorMessage(t, error);

  return (
    <div className="page prov-page">
      <Breadcrumbs
        crumbs={[
          { label: t("dashboards.title"), link: { to: "/dashboards", search: {} } },
          { label: title },
        ]}
      />
      <ol className="prov-steps" aria-label={t("provisioning.import.steps")}>
        {STEPS.map((id, index) => (
          <li
            key={id}
            className="prov-steps__step"
            aria-current={id === step ? "step" : undefined}
            data-done={index < stepIndex ? "" : undefined}
          >
            <span className="prov-steps__mark" aria-hidden="true">
              {index < stepIndex ? <Icon name="check" /> : index + 1}
            </span>
            <span>{t(STEP_LABEL[id])}</span>
            {index < stepIndex ? (
              <span className="visually-hidden">{t("provisioning.import.stepDoneMark")}</span>
            ) : null}
          </li>
        ))}
      </ol>

      {step === "file" ? (
        <section className="prov-card" aria-labelledby={`${ids}-file`}>
          <h1 id={`${ids}-file`} ref={headingRef} tabIndex={-1} className="prov-card__title">
            {title}
          </h1>
          <p className="prov-card__lead">{t("provisioning.import.lead")}</p>
          <fieldset className="admin-segmented">
            <legend className="visually-hidden">{t("provisioning.import.mode")}</legend>
            {(["upload", "paste"] as const).map((value) => (
              <label key={value} className="admin-segmented__option">
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${ids}-mode`}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                {t(value === "upload" ? "provisioning.import.upload" : "provisioning.import.paste")}
              </label>
            ))}
          </fieldset>
          {mode === "upload" ? (
            <>
              <input
                ref={inputRef}
                type="file"
                accept="application/json,.json"
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  void takeFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                className="prov-drop"
                data-over={over ? "" : undefined}
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
              >
                <Icon name="upload" />
                {file === null ? (
                  <span>{t("provisioning.import.drop")}</span>
                ) : (
                  <span className="prov-drop__file">
                    <strong>{file.name}</strong>
                    <span>
                      {t("provisioning.import.fileRead", { size: sizeText(file.size, language) })}
                    </span>
                  </span>
                )}
                <span className="prov-drop__hint">
                  {file === null
                    ? t("provisioning.import.dropHint")
                    : t("provisioning.import.otherFile")}
                </span>
              </button>
            </>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-json`}>
                {t("provisioning.import.json")}
              </label>
              <textarea
                id={`${ids}-json`}
                className="input input--mono prov-json"
                spellCheck={false}
                value={pasted}
                aria-invalid={problem === null ? undefined : true}
                aria-describedby={problem === null ? undefined : `${ids}-problem`}
                onChange={(event) => setPasted(event.currentTarget.value)}
              />
              <div>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={pasted.trim() === ""}
                  onClick={() => take(pasted, null)}
                >
                  {t("provisioning.import.readJson")}
                </button>
              </div>
            </div>
          )}
          {problem === null ? null : (
            <p className="notice notice--danger" role="alert" id={`${ids}-problem`}>
              {t(PROBLEM_TEXT[problem])}
            </p>
          )}
          {read === null ? null : (
            <>
              <div className="prov-found">
                <h2 className="prov-found__title">{t("provisioning.import.found")}</h2>
                <ul className="prov-found__list">
                  <li>{t("provisioning.import.foundTitle", { title: read.title })}</li>
                  {read.schemaVersion === null ? null : (
                    <li>{t("provisioning.import.foundSchema", { version: read.schemaVersion })}</li>
                  )}
                  <li>
                    {t("provisioning.import.foundPanels", { panels: read.panels, rows: read.rows })}
                  </li>
                  <li>{t("provisioning.import.foundVariables", { count: read.variables })}</li>
                  <li>{t("provisioning.import.foundSources", { count: read.sources.length })}</li>
                  <li>{t("provisioning.import.foundAnnotations", { count: read.annotations })}</li>
                </ul>
              </div>
              {read.libraryPanels > 0 ? (
                <p className="prov-hint">
                  {t("provisioning.import.libraryPanels", { count: read.libraryPanels })}
                </p>
              ) : null}
              {read.schemaVersion !== null && read.schemaVersion < OLD_SCHEMA ? (
                <p className="prov-hint">
                  {t("provisioning.import.oldSchema", { version: read.schemaVersion })}
                </p>
              ) : null}
              <div className="prov-fields">
                <div className="field">
                  <label className="field__label" htmlFor={`${ids}-name`}>
                    {t("provisioning.import.name")}
                  </label>
                  <input
                    id={`${ids}-name`}
                    className="input"
                    value={name}
                    maxLength={200}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                </div>
                <FolderPicker
                  folders={folders.data ?? []}
                  value={folder}
                  onChange={setFolder}
                  label={t("provisioning.import.folder")}
                  topLevel={canWriteTop}
                />
              </div>
              <p className="prov-card__note">{t("provisioning.import.rights")}</p>
            </>
          )}
          <div className="prov-card__actions">
            <Link to="/dashboards" search={{}} className="button button--secondary">
              {t("dashboards.dialog.cancel")}
            </Link>
            <button
              type="button"
              className="button button--primary"
              disabled={read === null}
              onClick={() =>
                setStep(read !== null && read.sources.length > 0 ? "sources" : "report")
              }
            >
              {t("provisioning.import.next")}
            </button>
          </div>
        </section>
      ) : null}

      {step === "sources" && read !== null ? (
        <section className="prov-card" aria-labelledby={`${ids}-sources`}>
          <h1 id={`${ids}-sources`} ref={headingRef} tabIndex={-1} className="prov-card__title">
            {t("provisioning.import.sourcesTitle")}
          </h1>
          <p className="prov-card__lead">{t("provisioning.import.sourcesLead")}</p>
          <div className="admin-table-card">
            {/* The rows stack on a phone; the roles are spelled out so they stay a table. */}
            <table className="admin-table prov-map" {...STACK_ROLES.table}>
              <thead {...STACK_ROLES.rowgroup}>
                <tr {...STACK_ROLES.row}>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("provisioning.import.inFile")}
                  </th>
                  <th scope="col" className="prov-map__num" {...STACK_ROLES.columnheader}>
                    {t("provisioning.import.uses")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("provisioning.import.inKalzit")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("provisioning.import.state")}
                  </th>
                </tr>
              </thead>
              <tbody {...STACK_ROLES.rowgroup}>
                {read.sources.map((source: GrafanaSource) => {
                  const chosen = mapping[source.key] ?? "";
                  const suggested = suggestSource(source, available);
                  const label =
                    source.key === "default"
                      ? t("provisioning.import.defaultSource")
                      : source.label;
                  return (
                    <tr key={source.key} {...STACK_ROLES.row}>
                      <th scope="row" className="prov-map__source" {...ROW_HEADER}>
                        <span className="prov-map__name">{label}</span>
                        <span className="prov-map__sub">
                          {[source.type, source.key === "default" ? "" : source.key]
                            .filter((part) => part !== "" && part !== label)
                            .join(" · ")}
                        </span>
                      </th>
                      <td
                        className="prov-map__num"
                        data-label={t("provisioning.import.uses")}
                        {...STACK_ROLES.cell}
                      >
                        {source.uses}
                      </td>
                      <td data-label={t("provisioning.import.inKalzit")} {...STACK_ROLES.cell}>
                        <Select
                          value={chosen}
                          aria-label={t("provisioning.import.sourceFor", { name: label })}
                          onChange={(id) =>
                            setMapping((current) => ({ ...current, [source.key]: id }))
                          }
                        >
                          <option value="">{t("provisioning.import.leaveOut")}</option>
                          {available.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td
                        className="prov-map__state"
                        data-label={t("provisioning.import.state")}
                        {...STACK_ROLES.cell}
                      >
                        {chosen === ""
                          ? t(
                              suggested.why === "none"
                                ? "provisioning.import.noSource"
                                : "provisioning.import.leftOut",
                            )
                          : source.variable
                            ? t("provisioning.import.becomesFixed")
                            : chosen === suggested.id
                              ? t(SUGGESTION_TEXT[suggested.why])
                              : t("provisioning.import.chosen")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {left > 0 ? <p className="prov-hint">{t("provisioning.import.leftOutHint")}</p> : null}
          {read.sources.some((source) => source.variable) ? (
            <p className="prov-hint">{t("provisioning.import.variableHint")}</p>
          ) : null}
          {preview.isError ? (
            <p className="notice notice--danger" role="alert">
              {failure(preview.error)}
            </p>
          ) : null}
          <div className="prov-card__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setStep("file")}
            >
              {t("provisioning.import.back")}
            </button>
            <span className="prov-card__summary">
              {t("provisioning.import.mapped", { mapped, total: read.sources.length, left })}
            </span>
            <button
              type="button"
              className="button button--primary"
              disabled={preview.isPending}
              onClick={() => preview.mutate()}
            >
              {t("provisioning.import.showReport")}
            </button>
          </div>
        </section>
      ) : null}

      {step === "report" && read !== null ? (
        <section className="prov-card" aria-labelledby={`${ids}-report`}>
          <h1 id={`${ids}-report`} ref={headingRef} tabIndex={-1} className="prov-card__title">
            {t("provisioning.import.reportOf", { title: name.trim() === "" ? read.title : name })}
          </h1>
          <p className="prov-card__lead">{t("provisioning.import.reportLeadBefore")}</p>
          {report === null ? (
            preview.isError ? (
              <p className="notice notice--danger" role="alert">
                {failure(preview.error)}
              </p>
            ) : (
              <ReportLoader run={() => preview.mutate()} pending={preview.isPending} />
            )
          ) : (
            <ReportView report={report} />
          )}
          {create.isError ? (
            <p className="notice notice--danger" role="alert">
              {failure(create.error)}
            </p>
          ) : null}
          <div className="prov-card__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setStep(read.sources.length > 0 ? "sources" : "file")}
            >
              {t("provisioning.import.back")}
            </button>
            {report === null ? null : (
              <span className="prov-card__summary">
                {t(
                  folder === null
                    ? "provisioning.import.createsTop"
                    : "provisioning.import.creates",
                  {
                    count: panelCounts(report).converted + panelCounts(report).approximated,
                    folder: folderName,
                  },
                )}
              </span>
            )}
            <button
              type="button"
              className="button button--primary"
              disabled={report === null || create.isPending}
              onClick={() => create.mutate()}
            >
              {t("provisioning.import.run")}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** A file without data sources skips the mapping: its report is asked for when the step opens. */
function ReportLoader({ run, pending }: { run: () => void; pending: boolean }) {
  const { t } = useI18n();
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      run();
    }
  }, [run]);
  return (
    <p className="loading" role="status">
      {pending ? t("common.loading") : ""}
    </p>
  );
}
