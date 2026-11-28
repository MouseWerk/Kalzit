import type { GraphSourceSchema } from "../../../api/generated/shapes";
import { type MessageKey, type MessageParams, translate } from "../../../i18n/i18n";

/** English texts, as the tests read them. */
export const t = (key: MessageKey, params?: MessageParams) => translate("en", key, params);

/** The board's example graph (Graph083): customers, products and suppliers. */
export const SHOP_SCHEMA: GraphSourceSchema = {
  source: "procedures",
  labels: [
    {
      name: "Kunde",
      count: 5,
      properties: [
        { name: "name", types: ["string"] },
        { name: "kundennr", types: ["integer"] },
      ],
    },
    {
      name: "Produkt",
      count: 6,
      properties: [
        { name: "name", types: ["string"] },
        { name: "preis", types: ["float"] },
        { name: "aktiv", types: ["boolean"] },
      ],
    },
    { name: "Lieferant", count: 2, properties: [{ name: "name", types: ["string"] }] },
  ],
  edgeTypes: [
    { name: "KAUFT", count: 15, properties: [{ name: "betrag", types: ["float"] }] },
    { name: "LIEFERT", count: 3, properties: [] },
    { name: "EMPFAHL", count: 3, properties: [] },
  ],
  links: [
    { from: "Kunde", type: "KAUFT", to: "Produkt", count: 15 },
    { from: "Lieferant", type: "LIEFERT", to: "Produkt", count: 3 },
    { from: "Kunde", type: "EMPFAHL", to: "Kunde", count: 3 },
  ],
  truncated: false,
  readAt: Date.UTC(2026, 10, 27, 9, 12),
};
