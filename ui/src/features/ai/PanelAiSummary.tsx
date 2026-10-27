import { useEffect, useEffectEvent, useState } from "react";
import type { TimeRange } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { useAiNotice } from "./AiNotice";
import { SummaryCard } from "./ExploreAi";
import { useAiCall } from "./useAiCall";
import "./ai-calls.css";

/**
 * "Summarize" from a panel's menu (board frame 9): the summary of the panel's stored queries as
 * the server runs them for the person, in a dialog. Asks for the first-use notice first; closing
 * the dialog stops a running call.
 */
export function PanelAiSummary({
  orgId,
  dashboardId,
  panelId,
  title,
  range,
  variables,
  intervalMs,
  onClose,
}: {
  orgId: string;
  dashboardId: string;
  panelId: string;
  title: string;
  range: TimeRange;
  variables: Record<string, unknown>;
  intervalMs?: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const call = useAiCall(orgId);
  const notice = useAiNotice(orgId);
  const [shown, setShown] = useState(false);

  const begin = useEffectEvent(() => {
    notice.guard(
      "summarize",
      () => {
        setShown(true);
        call.start({
          kind: "summarizePanel",
          dashboardId,
          panelId,
          timeRange: range,
          variables,
          ...(intervalMs === undefined ? {} : { intervalMs }),
        });
      },
      onClose,
    );
  });
  useEffect(() => begin(), []);

  function close() {
    call.stop();
    onClose();
  }

  return (
    <>
      {notice.dialog}
      {shown ? (
        <Dialog open title={t("ai.call.summaryTitle", { title })} onClose={close} wide>
          <SummaryCard call={call} title={title} onClose={close} />
        </Dialog>
      ) : null}
    </>
  );
}
