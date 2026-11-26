[English](../sharing.md) | Deutsch

# Teilen

Zeig ein Dashboard Menschen ohne Konto: Ein **öffentlicher Link** zeigt es live, ein **Snapshot**
hält seine Panels so fest, wie sie gerade sind. API: [Teilen](../../api/sharing.md). Für
Menschen in deiner Organisation gibst du Zugriff oder kopierst die Adresse des Dashboards; sie
melden sich an und brauchen wie immer Leserechte (siehe [Dashboards](dashboards.md)).

Die Oberfläche dafür folgt in einer späteren Version; bis dahin gibt es die Funktionen über die
API.

## Einschalten

Öffentliches Teilen ist aus, bis ein Server-Admin es einschaltet: **Einstellungen > Teilen**,
*Öffentliche Links und Snapshots* (`sharing.public_enabled`). Eine Organisation kann es für sich
wieder ausschalten (`sharing.org_public_enabled` unter **Einstellungen > Teilen in der
Organisation**). Im Abschnitt des Servers stehen auch die längste Laufzeit (Standard 365 Tage) und
die größte Snapshot-Größe (Standard 10 MB). Änderungen gelten sofort: Ist Teilen aus, antwortet
kein öffentlicher Link und kein öffentlicher Snapshot mehr; nach dem Einschalten wieder.

Geteilt wird am Dashboard über **Teilen**. [**Verwaltung > Freigaben**](app:/admin/shares) zeigt den Admins der
Organisation jeden öffentlichen Link und Snapshot, mit Status und Grund, wenn einer ausgesetzt
ist; **Einstellungen > Meine Freigaben** zeigt die eigenen.

Öffentliche Links und Snapshots anlegen braucht das Recht `dashboards:public`. Admins und
Eigentümer haben es; eigene Rollen können es bekommen.

## Öffentliche Links

Ein öffentlicher Link zeigt das Dashboard mit aktuellen Daten. Wer den Link hat, sieht das
Dashboard und darf einen Zeitraum innerhalb des Fensters wählen, das du festlegst (Standard: die
letzten 7 Tage); die Variablen bleiben auf den Werten, die du gewählt hast. Besucher können keine
eigenen Abfragen ausführen und sehen weder Abfragetexte noch Namen von Datenquellen,
Annotationen oder Links zu anderen Dashboards und Seiten.

- Ein Link läuft immer ab (Standard nach 30 Tagen, höchstens nach der längsten Laufzeit des
  Servers). Die Laufzeit kannst du später ändern.
- Die Abfragen der Panels laufen mit **deinen** Rechten in dem Moment, in dem jemand den Link
  öffnet. Verlierst du das Recht, das Leserecht am Dashboard oder das Abfragerecht an einer seiner
  Datenquellen, oder verlässt du die Organisation, ist der Link **ausgesetzt**; er geht wieder,
  sobald sich das ändert, bis er abläuft. Ausgesetzt ist er auch, solange das Dashboard im
  Papierkorb liegt oder öffentliches Teilen aus ist.
- Besucher eines Links, der nicht geht, sehen nur „nicht verfügbar“, nie den Grund.
- **Widerrufen** beendet einen Link endgültig. Widerrufene und abgelaufene Links bleiben 30 Tage in
  der Liste.
- Jeder Link zählt seine Seitenaufrufe. Sonst wird nichts über Besucher gespeichert: keine
  Adresse, kein Browser.

## Snapshots

Ein Snapshot speichert die Ergebnisse aller Panels für einen Zeitraum und die gewählten Werte der
Variablen in Kalzits Datenbank, in ihrer eigenen Form (Tabelle, Dokumente oder Graph). Beim
Öffnen wird keine Datenquelle mehr gefragt.

- Einen **internen** Snapshot sehen Mitglieder deiner Organisation, die das Dashboard lesen
  dürfen. Anlegen braucht das Recht, das Dashboard zu teilen (`dashboards:share`).
- Ein **öffentlicher** Snapshot hat einen Link wie ein öffentlicher Link, braucht
  `dashboards:public` und hört in denselben Fällen auf.
- Ein Snapshot darf höchstens so groß sein, wie der Server erlaubt (Standard 10 MB), und läuft
  immer ab.

## Verwalten

Admins der Organisation sehen alle öffentlichen Links und Snapshots der Organisation mit ihrem
Status (aktiv, ausgesetzt mit Grund, abgelaufen, widerrufen), können die Laufzeit ändern und sie
widerrufen. Alle anderen sehen und verwalten ihre eigenen. Anlegen, Laufzeit ändern und
Widerrufen stehen im [Audit-Log](administration.md#audit-log).
