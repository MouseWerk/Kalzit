import { useI18n } from "../../../i18n/i18n";
import type { ResultRecord } from "./api";
import "./chat.css";

/** Rows, documents or nodes shown of one result; the rest is counted. */
const SHOWN = 50;

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Field {
  name: string;
  values: unknown[];
}

function fieldsOf(data: Record<string, unknown>): Field[] {
  const fields = Array.isArray(data.fields) ? data.fields : [];
  return fields.filter(isRecord).map((field) => ({
    name: typeof field.name === "string" ? field.name : "",
    values: Array.isArray(field.values) ? field.values : [],
  }));
}

/**
 * One result of a tool call in its own shape, as it went to the model (excluded values replaced,
 * cut to the row limit): a frame as a table, documents as JSON, a graph as its nodes. Text only;
 * nothing in it is run or followed.
 */
export function ResultView({ result }: { result: ResultRecord }) {
  const { t } = useI18n();
  const data = result.data;
  if (data === undefined) {
    return null;
  }
  const notes = (
    <>
      {result.truncated ? (
        <p className="ask-result__note">{t("ai.chat.truncated", { rows: result.rows })}</p>
      ) : null}
      {result.excludedValues > 0 ? (
        <p className="ask-result__note">
          {t("ai.chat.excluded", { count: result.excludedValues })}
        </p>
      ) : null}
    </>
  );
  if (data.shape === "frame") {
    const fields = fieldsOf(data);
    const rows = Math.max(0, ...fields.map((field) => field.values.length));
    if (rows === 0) {
      return (
        <div className="ask-result">
          <p className="ask-result__note">{t("ai.chat.result.empty")}</p>
          {notes}
        </div>
      );
    }
    const shown = Array.from({ length: Math.min(rows, SHOWN) }, (_, index) => index);
    return (
      <div className="ask-result">
        <div className="ask-result__scroll">
          <table className="ask-result__table">
            <caption className="visually-hidden">
              {t("ai.chat.result.caption", { ref: result.refId })}
            </caption>
            <thead>
              <tr>
                {fields.map((field, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns may share a name.
                  <th key={index} scope="col">
                    {field.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row}>
                  {fields.map((field, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns may share a name.
                    <td key={index}>{cell(field.values[row])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows > SHOWN ? (
          <p className="ask-result__note">{t("ai.chat.result.more", { count: rows - SHOWN })}</p>
        ) : null}
        {notes}
      </div>
    );
  }
  if (data.shape === "documents") {
    const documents = Array.isArray(data.documents) ? data.documents : [];
    return (
      <div className="ask-result">
        <p className="ask-result__note">
          {t("ai.chat.result.documents", { count: documents.length })}
        </p>
        {documents.slice(0, SHOWN).map((document, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: documents are shown in their order.
          <pre key={index} className="ask-result__document">
            {JSON.stringify(document, null, 2)}
          </pre>
        ))}
        {documents.length > SHOWN ? (
          <p className="ask-result__note">
            {t("ai.chat.result.more", { count: documents.length - SHOWN })}
          </p>
        ) : null}
        {notes}
      </div>
    );
  }
  if (data.shape === "graph") {
    const nodes = (Array.isArray(data.nodes) ? data.nodes : []).filter(isRecord);
    const edges = Array.isArray(data.edges) ? data.edges : [];
    return (
      <div className="ask-result">
        <p className="ask-result__note">
          {t("ai.chat.result.graph", { nodes: nodes.length, edges: edges.length })}
        </p>
        <div className="ask-result__scroll">
          <table className="ask-result__table">
            <caption className="visually-hidden">
              {t("ai.chat.result.caption", { ref: result.refId })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("ai.chat.result.labels")}</th>
                <th scope="col">{t("ai.chat.result.properties")}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.slice(0, SHOWN).map((node, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: nodes are shown in their order.
                <tr key={index}>
                  <td>{Array.isArray(node.labels) ? node.labels.join(", ") : ""}</td>
                  <td>{cell(node.properties)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nodes.length > SHOWN ? (
          <p className="ask-result__note">
            {t("ai.chat.result.more", { count: nodes.length - SHOWN })}
          </p>
        ) : null}
        {notes}
      </div>
    );
  }
  return null;
}
