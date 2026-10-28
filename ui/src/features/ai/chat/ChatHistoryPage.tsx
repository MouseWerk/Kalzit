import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { EmptyState } from "../../../components/EmptyState";
import { FormAlert } from "../../../components/FormAlert";
import { Icon } from "../../../components/Icon";
import { Page, PageActions } from "../../../components/Page";
import { useI18n } from "../../../i18n/i18n";
import { useDocumentTitle } from "../../../lib/useDocumentTitle";
import { useCurrentOrg } from "../../../org/useOrg";
import { ConfirmDialog } from "../../admin/components/Dialog";
import { errorMessage } from "../../dashboards/ui/errors";
import { useWhen } from "./AskPage";
import { CHATS_KEY, type ChatSummary, chatsQuery, deleteAllChats, deleteChat } from "./api";
import { daysLeft } from "./turn";
import "./chat.css";

/** What a confirmation deletes: one chat, the chosen ones, or all. */
type Pending = { kind: "one"; chat: ChatSummary } | { kind: "selected" } | { kind: "all" };

/**
 * "Fragen > Verlauf" (board AI.dc.html, frame 11): the person's own chats, newest use first,
 * each with when it is deleted; search, open, delete one, the chosen or all.
 */
export function ChatHistoryPage() {
  const { t } = useI18n();
  useDocumentTitle("ai.chat.history");
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const queryClient = useQueryClient();
  const when = useWhen();
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const list = useQuery({ ...chatsQuery(orgId, search), enabled: org !== undefined });
  const remove = useMutation({
    mutationFn: async (what: Pending) => {
      if (what.kind === "all") {
        await deleteAllChats(orgId);
      } else if (what.kind === "one") {
        await deleteChat(orgId, what.chat.id);
      } else {
        for (const id of chosen) {
          await deleteChat(orgId, id);
        }
      }
    },
    onSuccess: async () => {
      setPending(null);
      setChosen(new Set());
      await queryClient.invalidateQueries({ queryKey: [CHATS_KEY, orgId] });
    },
  });
  const items = list.data?.items ?? [];
  const days = list.data?.retentionDays;
  const lead =
    days === undefined
      ? undefined
      : days === 0
        ? t("ai.chat.historyLeadNone")
        : t("ai.chat.historyLead", { days });
  const now = Date.now();

  function toggle(id: string) {
    const next = new Set(chosen);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setChosen(next);
  }

  const confirmTitle =
    pending === null
      ? ""
      : pending.kind === "one"
        ? t("ai.chat.confirmDelete.title")
        : pending.kind === "all"
          ? t("ai.chat.confirmDeleteAll.title")
          : t("ai.chat.confirmDeleteMany.title", { count: chosen.size });
  const confirmText =
    pending?.kind === "one"
      ? t("ai.chat.confirmDelete.text", { title: pending.chat.title || t("ai.chat.newChat") })
      : t("ai.chat.confirmDeleteMany.text");

  return (
    <Page title={t("ai.chat.history")} {...(lead === undefined ? {} : { lead })}>
      <Breadcrumbs
        crumbs={[
          { label: t("ai.chat.title"), link: { to: "/ask", search: {} } },
          { label: t("ai.chat.history") },
        ]}
      />
      <PageActions>
        {chosen.size > 0 ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setPending({ kind: "selected" })}
          >
            <Icon name="trash" />
            {t("ai.chat.deleteSelected", { count: chosen.size })}
          </button>
        ) : null}
        {items.length > 0 ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setPending({ kind: "all" })}
          >
            <Icon name="trash" />
            {t("ai.chat.deleteAll")}
          </button>
        ) : null}
        <Link to="/ask" search={{}} className="button button--secondary">
          <Icon name="plus" />
          {t("ai.chat.newChat")}
        </Link>
      </PageActions>
      <div className="ask-history-page">
        <label className="ask-history-page__search">
          <Icon name="search" />
          <span className="visually-hidden">{t("ai.chat.search")}</span>
          <input
            type="search"
            className="ask-history-page__input"
            placeholder={t("ai.chat.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {list.isError ? <FormAlert>{errorMessage(t, list.error)}</FormAlert> : null}
        {list.isSuccess && items.length === 0 ? (
          search.trim() === "" ? (
            <EmptyState icon="history" title={t("ai.chat.historyEmpty")}>
              {lead ?? ""}
            </EmptyState>
          ) : (
            <p className="ask-result__note">{t("ai.chat.noMatch")}</p>
          )
        ) : null}
        {items.length === 0 ? null : (
          <table className="ask-history-page__table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">{t("ai.chat.column.select")}</span>
                </th>
                <th scope="col">{t("ai.chat.column.chat")}</th>
                <th scope="col">{t("ai.chat.column.deletedIn")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("ai.chat.column.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((chat) => {
                const title = chat.title || t("ai.chat.newChat");
                const left = daysLeft(chat.expiresAt, now);
                return (
                  <tr key={chat.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={chosen.has(chat.id)}
                        onChange={() => toggle(chat.id)}
                        aria-label={t("ai.chat.selectChat", { title })}
                      />
                    </td>
                    <td>
                      <Link
                        to="/ask"
                        search={{ chat: chat.id }}
                        className="ask-history-page__title"
                      >
                        {title}
                      </Link>
                      <div className="ask-result__note">
                        {[when(chat.updatedAt), ...chat.datasources.map((s) => s.name)].join(" · ")}
                      </div>
                    </td>
                    <td className="ask-result__note">
                      {left === 0
                        ? t("ai.chat.lessThanDay")
                        : left === 1
                          ? t("ai.chat.dayLeft")
                          : t("ai.chat.daysLeft", { count: left })}
                    </td>
                    <td className="ask-history-page__actions">
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("ai.chat.deleteChat", { title })}
                        title={t("ai.chat.deleteChat", { title })}
                        onClick={() => setPending({ kind: "one", chat })}
                      >
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={confirmTitle}
        confirmLabel={t("ai.chat.confirmDelete.confirm")}
        busy={remove.isPending}
        error={remove.isError ? errorMessage(t, remove.error) : null}
        onConfirm={() => pending !== null && remove.mutate(pending)}
        onClose={() => setPending(null)}
      >
        {confirmText}
      </ConfirmDialog>
    </Page>
  );
}
