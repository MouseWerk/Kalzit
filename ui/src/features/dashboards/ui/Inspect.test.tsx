import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLanguage, type Language, setLanguage } from "../../../i18n/i18n";
import { Inspect } from "./Inspect";

describe("Inspect", () => {
  let before: Language;
  beforeEach(() => {
    before = getLanguage();
    setLanguage("en");
  });
  afterEach(() => setLanguage(before));

  it("shows a document result's size, notices and executed query", () => {
    render(
      <Inspect
        outcomes={[
          {
            refId: "A",
            result: {
              shape: "documents",
              documents: {
                documents: [{ a: 1 }, { a: 2 }],
                schema: [{ path: "a", coverage: 1, types: [{ name: "number", share: 1 }] }],
                truncated: { limit: 2 },
                notices: [
                  {
                    severity: "warning",
                    code: "documents.limit",
                    params: { limit: "2" },
                    text: "only the first 2 documents are shown (document limit)",
                  },
                ],
                executedQuery: "bestellungen.find({})",
              },
            },
          },
        ]}
      />,
    );
    expect(screen.getByText("2 documents, 1 field paths")).toBeTruthy();
    expect(screen.getByText(/The result was cut at 2 documents\./)).toBeTruthy();
    expect(screen.getByText("bestellungen.find({})")).toBeTruthy();
  });
});
