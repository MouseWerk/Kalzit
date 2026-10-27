import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { AiGate } from "../ai/AiGate";
import { AiAccessSection } from "../ai/source/AiAccessSection";
import { mayManageAccess } from "../dashboards/accessIntegration";
import { ConfirmDialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { useLeaveGuard } from "../dashboards/ui/useLeaveGuard";
import { openWithSource } from "../explore/lastSource";
import {
  checkHealth,
  conflictingDatasource,
  DATASOURCES_KEY,
  type Datasource,
  datasourceQuery,
  deleteDatasource,
  type Health,
  kindsQuery,
  restoreDatasource,
  sourceAccess,
  testDatasource,
  updateDatasource,
} from "./api";
import { AccessSection, SHAPE_TEXT, yourAccess } from "./DataSourceDrawer";
import {
  type Conflict,
  ConflictDialog,
  type FormOutput,
  HealthResult,
  HealthWarnings,
  type SaveRequest,
  SettingsForm,
  UntestedNote,
} from "./DataSourceForm";
import { KindMark, kindSummary } from "./kindMarks";
import { StatusLabel } from "./StatusLabel";
import { forgetHealth, type HealthEntry, healthQuery, statusOf } from "./sourceStatus";
import "./datasources.css";

const editRoute = getRouteApi("/_app/data-sources/$datasourceId");

/** Data sources, then the source's name once it is loaded (the page reads the same query). */
function EditCrumbs({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const { datasourceId } = editRoute.useParams();
  const source = useQuery(datasourceQuery(orgId, datasourceId));
  return (
    <Breadcrumbs
      crumbs={[
        { label: t("datasources.title"), link: { to: "/data-sources", search: {} } },
        { label: source.data?.name ?? t("datasources.edit.title") },
      ]}
    />
  );
}

/**
 * One data source after the blueprint: a header with its mark, name, status and last test and
 * the actions on the right (Test, Open in Explore, More); the settings in the add page's
 * sections; beside them what the source is and who has access; the trash at the bottom.
 */
export function EditDataSourcePage() {
  useDocumentTitle("datasources.edit.title");
  const org = useCurrentOrg();
  // A grant on this source can allow editing without the org-wide permission, so the server
  // decides: it answers 404 for a source the caller may not see and 403 for a change they may
  // not make.
  return (
    <>
      {org === undefined ? null : <EditCrumbs orgId={org.id} />}
      <div className="page">{org === undefined ? null : <EditDataSource orgId={org.id} />}</div>
    </>
  );
}

function EditDataSource({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const { datasourceId } = editRoute.useParams();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ids = useId();
  const source = useQuery(datasourceQuery(orgId, datasourceId));
  const kinds = useQuery(kindsQuery(orgId));
  // A test run just before (on the list) shows at once.
  const [health, setHealth] = useState<Health | null>(
    () => queryClient.getQueryData(healthQuery(orgId, datasourceId).queryKey) ?? null,
  );
  const [testedAt, setTestedAt] = useState<number>(() =>
    health === null
      ? 0
      : (queryClient.getQueryState(healthQuery(orgId, datasourceId).queryKey)?.dataUpdatedAt ?? 0),
  );
  // The last test of what the form holds, saved or not (the header shows the saved source's).
  const [draft, setDraft] = useState<Health | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Bumped after a save so the form starts again from what the server stored.
  const [formKey, setFormKey] = useState(0);
  // The `updatedAt` of the source the form started from. Saves and deletes send it, so a change
  // someone else saved in the meantime is never overwritten without being shown. A background
  // refetch does not move it: the form still shows what it started from.
  const [base, setBase] = useState<number | undefined>(undefined);
  if (base === undefined && source.data?.updatedAt !== undefined) {
    setBase(source.data.updatedAt);
  }
  // A save or delete the server refused because the source changed since the form started.
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [dirty, setDirty] = useState(false);
  const leave = useLeaveGuard(dirty, t("datasources.edit.leaveText"));

  /** Starts the form again from `stored`, dropping what was typed. */
  function startFrom(stored: Datasource) {
    queryClient.setQueryData(datasourceQuery(orgId, datasourceId).queryKey, stored);
    setBase(stored.updatedAt);
    setFormKey((key) => key + 1);
  }

  const save = useMutation({
    mutationFn: ({ output, expected }: SaveRequest) =>
      updateDatasource(orgId, datasourceId, {
        name: output.name,
        secrets: output.secrets,
        ...(output.settings === undefined ? {} : { settings: output.settings }),
        ...(expected === undefined ? {} : { expectedUpdatedAt: expected }),
      }),
    onSuccess: (saved) => {
      // The last test was of the old settings.
      forgetHealth(queryClient, orgId, datasourceId);
      setHealth(null);
      setDraft(null);
      setTestedAt(0);
      void queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId], exact: true });
      startFrom(saved);
    },
    onError: (error, { output }) => {
      const stored = conflictingDatasource(error);
      if (stored !== null) {
        setConflict({ stored, retry: { kind: "save", output } });
      }
    },
  });
  const submit = (output: FormOutput) => save.mutate({ output, expected: base });
  // The header's test checks the saved source.
  const test = useMutation({
    mutationFn: () => checkHealth(orgId, datasourceId),
    onMutate: () => {
      setHealth(null);
      setDraft(null);
      testForm.reset();
    },
    onSuccess: (result) => {
      setHealth(result);
      setDraft(null);
      setTestedAt(Date.now());
      // The list shows the same result; the server kept it as the source's last test.
      queryClient.setQueryData(healthQuery(orgId, datasourceId).queryKey, result);
      void queryClient.invalidateQueries({
        queryKey: datasourceQuery(orgId, datasourceId).queryKey,
        exact: true,
      });
    },
    onError: () => setTestedAt(Date.now()),
  });
  // The form's test checks what is entered; without changes that is the saved source. Nothing
  // is saved either way, and a result for unsaved changes stays out of the header and the list.
  const testForm = useMutation({
    mutationFn: (output: FormOutput) =>
      testDatasource(orgId, {
        kind: source.data?.kind ?? "",
        datasourceId,
        settings: output.settings,
        secrets: output.secrets,
      }),
    onMutate: () => {
      setDraft(null);
      test.reset();
    },
    onSuccess: (result, output) => {
      if (output.settings === undefined && Object.keys(output.secrets).length === 0) {
        setHealth(result);
        setTestedAt(Date.now());
        queryClient.setQueryData(healthQuery(orgId, datasourceId).queryKey, result);
      } else {
        setDraft(result);
      }
    },
  });
  const remove = useMutation({
    mutationFn: (expected: number | undefined) => deleteDatasource(orgId, datasourceId, expected),
    onError: (error) => {
      const stored = conflictingDatasource(error);
      if (stored !== null) {
        remove.reset();
        setConfirmDelete(false);
        setConflict({ stored, retry: { kind: "delete" } });
      }
    },
    onSuccess: async () => {
      forgetHealth(queryClient, orgId, datasourceId);
      // The deleted source's own queries (this page, its schema) would only answer 404 now:
      // they are dropped after leaving the page instead of being loaded again.
      const ofThisSource = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey.includes(datasourceId);
      await queryClient.invalidateQueries({
        queryKey: [DATASOURCES_KEY, orgId],
        predicate: (query) => !ofThisSource(query),
      });
      showToast({
        message: t("datasources.deleted"),
        undo: () => {
          restoreDatasource(orgId, datasourceId).then(
            () => {
              forgetHealth(queryClient, orgId, datasourceId);
              return queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
            },
            (error: unknown) => showErrorToast(errorMessage(t, error)),
          );
        },
      });
      // Moved to the trash on purpose: what was typed goes with it.
      leave.release();
      await navigate({ to: "/data-sources", search: {} });
      queryClient.removeQueries({ queryKey: [DATASOURCES_KEY, orgId], predicate: ofThisSource });
    },
  });

  if (source.isPending || kinds.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (source.isError || kinds.isError) {
    return <FormAlert>{errorMessage(t, source.error ?? kinds.error)}</FormAlert>;
  }
  const kind = kinds.data.find((k) => k.kind === source.data.kind);
  if (kind === undefined) {
    return <FormAlert>{t("datasources.form.unknownKind")}</FormAlert>;
  }
  // The source's own rights (grants included), else the org role. Testing needs query, which
  // admins hold with the built-in roles; a custom role may allow changing without querying.
  const access = sourceAccess(source.data.access, permissions);
  const canTest = access.query;
  // Where the source connects needs `changeTarget`: the org-wide write or an admin grant.
  const targetLocked = !access.changeTarget;
  const canManage = mayManageAccess("datasource", access.permissions, permissions);
  const timeFormat = new Intl.DateTimeFormat(language, {
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const dateFormat = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    ...zoneOption(timeZone),
  });
  // The warnings of the newest test of the saved source: this session's, or the server's kept one.
  const stored = source.data.lastTest;
  const fresh = health !== null && (stored === undefined || testedAt >= stored.testedAt);
  const savedWarnings = fresh
    ? health.ok
      ? (health.warnings ?? [])
      : []
    : stored?.ok === true
      ? stored.warnings
      : [];
  const entry: HealthEntry | undefined =
    health === null && test.error === null && !test.isPending
      ? undefined
      : {
          health: health ?? undefined,
          error: test.error,
          pending: test.isPending,
          at: testedAt,
        };
  const status = statusOf(entry);

  const more: ToolbarMenuEntry[] = [];
  if (permissions.has("datasources:write")) {
    more.push({
      key: "duplicate",
      label: t("datasources.edit.duplicate"),
      icon: "copy",
      onSelect: () =>
        void navigate({
          to: "/data-sources/new",
          search: { kind: source.data.kind, from: datasourceId },
        }),
    });
  }
  if (access.write) {
    more.push({
      key: "trash",
      label: t("datasources.edit.trash"),
      icon: "trash",
      danger: true,
      onSelect: () => setConfirmDelete(true),
    });
  }

  return (
    <div className="ds-edit">
      <header className="ds-edit__header">
        <KindMark kind={kind.kind} />
        <div className="ds-edit__identity">
          <h1 className="ds-edit__name">{source.data.name}</h1>
          <p className="ds-edit__meta">
            <StatusLabel status={status} latencyMs={health?.latencyMs} />
            {testedAt > 0 && !test.isPending ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t("datasources.edit.testedAt", { time: timeFormat.format(testedAt) })}</span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>{kind.name}</span>
          </p>
        </div>
        <div className="ds-edit__actions">
          {canTest ? (
            <button
              type="button"
              className="button button--secondary"
              disabled={test.isPending || dirty}
              title={dirty ? t("datasources.edit.saveFirst") : undefined}
              onClick={() => test.mutate()}
            >
              <Icon name="refresh" />
              {test.isPending ? t("datasources.health.testing") : t("datasources.drawer.test")}
            </button>
          ) : null}
          {access.query ? (
            <Link
              to="/explore"
              className="button button--secondary"
              onClick={() => openWithSource(datasourceId)}
            >
              <Icon name="explore" />
              {t("datasources.drawer.explore")}
            </Link>
          ) : null}
          {more.length === 0 ? null : (
            <ToolbarMenu label={t("datasources.edit.more")} icon="more" entries={more} />
          )}
        </div>
      </header>
      <div className="ds-edit__layout">
        <div className="ds-edit__main">
          {/* The saved source's last test found something to fix: it stays in view on the page,
              from this session's test or else the one the server kept, for everyone. */}
          <HealthWarnings warnings={savedWarnings} />
          <SettingsForm
            key={formKey}
            kind={kind}
            initial={source.data}
            busy={save.isPending}
            error={conflictingDatasource(save.error) === null ? save.error : null}
            submitLabel={t("datasources.form.save")}
            title={t("datasources.edit.settings")}
            subtitle={kindSummary(t, kind.kind) ?? undefined}
            onSubmit={(output) => submit(output)}
            onDirtyChange={setDirty}
            readOnly={!access.write}
            targetLocked={targetLocked}
            // Exactly when the server allows it: the right to change this source.
            {...(access.write ? { onTest: (output: FormOutput) => testForm.mutate(output) } : {})}
            onEdited={() => {
              setDraft(null);
              testForm.reset();
            }}
            testing={test.isPending || testForm.isPending}
            saved={save.isSuccess}
            status={
              <>
                {draft === null ? null : (
                  <p className="field__hint">{t("datasources.health.testingChanges")}</p>
                )}
                <HealthResult
                  health={draft ?? health}
                  warnings={draft !== null}
                  error={testForm.error ?? test.error}
                  empty={canTest ? <UntestedNote /> : null}
                />
              </>
            }
            cancel={
              <Link to="/data-sources" search={{}} className="button button--ghost">
                {t("datasources.form.cancel")}
              </Link>
            }
          />
          {/* Only while AI is usable; with AI off the part is absent and what is set stays. */}
          <AiGate>
            <AiAccessSection orgId={orgId} datasourceId={datasourceId} canWrite={access.write} />
          </AiGate>
          {access.write ? (
            <section className="ds-danger" aria-labelledby={`${ids}-danger`}>
              <div className="ds-danger__text">
                <h2 id={`${ids}-danger`}>{t("datasources.edit.danger")}</h2>
                <p>{t("datasources.edit.dangerText")}</p>
              </div>
              <button
                type="button"
                className="button button--secondary ds-danger__button"
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" />
                {t("datasources.edit.trash")}
              </button>
            </section>
          ) : null}
        </div>
        <aside className="ds-edit__side" aria-labelledby={`${ids}-about`}>
          <section className="ds-side">
            <h2 id={`${ids}-about`} className="ds-side__title">
              {t("datasources.edit.about")}
            </h2>
            <dl className="ds-facts">
              <div>
                <dt>{t("datasources.column.kind")}</dt>
                <dd>{kind.name}</dd>
              </div>
              <div>
                <dt>{t("datasources.drawer.shapes")}</dt>
                <dd>{kind.shapes.map((shape) => t(SHAPE_TEXT[shape])).join(", ")}</dd>
              </div>
              {source.data.createdAt === undefined ? null : (
                <div>
                  <dt>{t("datasources.column.created")}</dt>
                  <dd>{dateFormat.format(source.data.createdAt)}</dd>
                </div>
              )}
              <div>
                <dt>{t("datasources.drawer.yourAccess")}</dt>
                <dd>{t(yourAccess(access))}</dd>
              </div>
            </dl>
          </section>
          {canManage ? (
            <section className="ds-side">
              <AccessSection orgId={orgId} source={source.data} />
            </section>
          ) : null}
          <p className="ds-drawer__note">
            <Icon name="shieldCheck" />
            <span>{t("datasources.drawer.note")}</span>
          </p>
        </aside>
      </div>
      {confirmDelete ? (
        <ConfirmDialog
          title={t("datasources.delete.title")}
          confirmLabel={t("datasources.delete.confirm")}
          onCancel={() => {
            remove.reset();
            setConfirmDelete(false);
          }}
          onConfirm={() => remove.mutate(base)}
          busy={remove.isPending}
          error={remove.isError ? errorMessage(t, remove.error) : undefined}
        >
          {t("datasources.delete.text", { name: source.data.name })}
        </ConfirmDialog>
      ) : null}
      {conflict === null ? null : (
        <ConflictDialog
          conflict={conflict}
          onLoadStored={() => {
            save.reset();
            startFrom(conflict.stored);
            setConflict(null);
          }}
          onOverwrite={() => {
            const { stored, retry } = conflict;
            setConflict(null);
            setBase(stored.updatedAt);
            if (retry.kind === "save") {
              // Sent again over the stored source: the server checks the change against it, so
              // a target someone else moved still asks for its secrets again.
              save.mutate({ output: retry.output, expected: stored.updatedAt });
            } else {
              remove.mutate(stored.updatedAt);
            }
          }}
        />
      )}
      {leave.dialog}
    </div>
  );
}
