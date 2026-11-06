## Improved

- Fragen: rate each answer as "Hilfreich" or "Nicht hilfreich"; only you see your rating.
- Fragen: the result of a query is a card of its own with Tabelle and Zeitreihe, and the answer's words follow under "Kurz zusammengefasst".
- Fragen: answers show headings, lists, tables and code as formatted text; a link that would leave Kalzit shows as text with its host.
- Fragen: "Neuer Chat" sits in the top bar, and the composer shows every source it asks while none is chosen.
- Fragen: the context column says whether the model runs in your own network or in the cloud, and whose provider it is.
- Verwaltung > KI: while AI is on, the switch sits in the status strip with since when and by whom; the strip says which functions send data out of your network.
- Verwaltung > KI: the providers table shows where each provider runs and whether data leaves the server; "Welcher Anbieter wofür" and the organizations sit side by side, with each organization's AI state.
- Verwaltung > KI: "KI im Audit-Log" opens the audit log filtered to AI.
- The notice of what leaves the server now also names Fragen.
- Limits read "je Person" instead of "pro Benutzer".

## Fixed

- A provider is saved only after its connection test passes; "Verbindung testen" no longer stores anything, and a failed test no longer overwrites a working provider.

## Checklist for Windows (manual)

- Verwaltung > KI: add a provider with a wrong key, press Save: the error shows at the key and nothing is added; with the right key Save adds it as tested.
- Fragen: ask a question, rate the answer, reload: the rating stays.
