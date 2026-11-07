[English](../account-security.md) | Deutsch

# Anmeldung und Sicherheit

Wie du dein Konto mit einem zweiten Faktor schützt und wie Admins einen verlangen. Die API dazu
steht in [docs/api/access.md](../../api/access.md#second-factor).

## Dein zweiter Faktor

Öffne **Einstellungen > Anmeldung und Sicherheit**. Mit einem zweiten Faktor meldet dein
Passwort allein niemanden mehr an: Nach dem Passwort fragt Kalzit nach einer dieser Methoden.

- **Passkey** (empfohlen): dein Fingerabdruck, dein Gesicht, die PIN deines Geräts oder ein
  Sicherheitsschlüssel. Wähle **Passkey hinzufügen**, gib ihm einen Namen, den du wiedererkennst
  (etwa „Büro-Laptop“), und folge dem Dialog deines Browsers oder Geräts. Du kannst mehrere
  hinzufügen, sie in ihrer Zeile umbenennen (Eingabe speichert, Esc bricht ab) und entfernen.
  Passkeys funktionieren unter der Adresse, unter der du sie hinzugefügt hast; Kalzit muss über
  einen Hostnamen geöffnet werden, nicht über eine IP-Adresse.
- **Authenticator-App**: eine App auf deinem Handy, die alle 30 Sekunden einen sechsstelligen
  Code zeigt. Wähle **Einrichten**, scanne den QR-Code (oder tipp den Schlüssel von Hand ein, oder
  öffne auf dem Handy den Link in der App) und gib den ersten Code ein. Die Codes wechseln alle
  30 Sekunden; wird einer abgelehnt, warte auf den nächsten und prüfe, ob die Uhrzeit deines
  Handys stimmt.
- **Wiederherstellungscodes**: zehn Codes, von denen jeder einmal deinen zweiten Faktor ersetzt,
  zum Beispiel wenn dein Handy verloren ist. Du bekommst sie mit deiner ersten Methode und siehst
  sie nur dann: Lade sie herunter, kopiere oder drucke sie, bewahre sie getrennt von deinem
  Passwort auf und setze den Haken bei „Ich habe die Codes sicher abgelegt“, um weiterzumachen.
  **Neu erstellen** ersetzt den ganzen Satz.

Deine erste Methode fragt zuerst nach deinem Passwort, damit niemand, der einen deiner
angemeldeten Browser übernommen hat, einen eigenen zweiten Faktor einrichten kann. Meldest du dich
nur über einen Anbieter oder einen Verzeichnisdienst an und hast kein Passwort, bittet sie dich
zuerst, dich erneut anzumelden, außer du hast dich in den letzten fünf Minuten angemeldet. Das
Einrichten meldet dich auf allen anderen Geräten und Browsern ab; melde dich dort mit dem neuen
zweiten Faktor wieder an.

Eine Methode entfernen, neue Wiederherstellungscodes erstellen, eine weitere Methode hinzufügen
und dein Passwort ändern verlangen zuerst eine Bestätigung mit einer Methode, die du hast (einem
Passkey, einem Code aus der App oder einem Wiederherstellungscode). Eine Bestätigung gilt fünf
Minuten, und die Anmeldung mit dem zweiten Faktor zählt als eine. Solange für dein Konto ein
zweiter Faktor Pflicht ist, lässt sich die letzte Methode nicht entfernen; richte zuerst eine
weitere ein.

Eine Organisation, die einen zweiten Faktor verlangt, lässt einen Browser erst herein, wenn er
deinen nachgewiesen hat: durch die Anmeldung damit, durch das Einrichten dort oder durch eine
Bestätigung. Zeigt die Organisation „Diese Organisation verlangt einen zweiten Faktor“, obwohl du
einen hast, wähle **Zweiten Faktor bestätigen**.

## Anmelden

Nach E-Mail-Adresse und Passwort bittet dich die Seite zu bestätigen, dass du es bist. Mit einem
Passkey wählst du **Mit Passkey bestätigen**; mit der App tippst du den sechsstelligen Code ein
(er wird abgeschickt, sobald alle sechs Ziffern dastehen); ohne beides wählst du
**Wiederherstellungscode verwenden**. Nach einem Wiederherstellungscode sagt die Seite, wie viele
noch übrig sind.

Fünf falsche Codes innerhalb von 15 Minuten sperren den zweiten Schritt deines Kontos für
15 Minuten, egal von welchem Gerät sie kamen; die Seite zeigt, bis wann. Passkeys werden nicht
gesperrt. Kannst du keine deiner Methoden mehr nutzen, bitte einen Admin, deinen zweiten Faktor
zurückzusetzen.

Der zweite Schritt muss innerhalb von fünf Minuten abgeschlossen sein; bis dahin bist du nicht
angemeldet.

## Einen zweiten Faktor verlangen (Admins)

Server-Admins legen die Regel für den ganzen Server unter **Einstellungen > Anmeldung** fest:

- **Zweiter Faktor Pflicht**: Aus, Für Admins (Server-Admins und die Admins jeder Organisation)
  oder Für alle. Das ist das Minimum für jede Organisation.
- **Erlaubte Methoden**: Passkeys und App, nur Passkeys oder nur die Authenticator-App.
  Wiederherstellungscodes gehören immer dazu. Eine abgeschaltete Methode funktioniert weiter für
  alle, die sie haben.

Admins einer Organisation können für ihre Organisation unter **Einstellungen > Organisation**
strenger sein: Wie Server, Für Admins oder Für alle. Lockerer als der Server können sie nicht
sein. Die Tabelle **Je Organisation** auf der Seite des Servers zeigt für jede Organisation ihre
Regel, was dort gilt und wie viele Mitglieder noch keinen zweiten Faktor haben.

Es gibt keine Schonfrist: Wer einen zweiten Faktor haben muss und keinen hat, richtet bei der
nächsten Anmeldung einen ein, in drei Schritten (Methode, Einrichtung, Wiederherstellungscodes),
bevor Kalzit sich öffnet. Wer schon angemeldet ist, behält seine Sitzung, bis sie endet. Eine
Regel aus der Umgebung oder aus `kalzit.toml` gilt auch für die Einrichtung beim ersten Start: Der
erste Eigentümer richtet einen zweiten Faktor ein, bevor Kalzit sich öffnet.

## Den zweiten Faktor einer Person zurücksetzen (Admins)

Hat jemand seine Methoden verloren, öffne **Verwaltung > Mitglieder** (oder als Server-Admin
**Benutzer**) und wähle in der Zeile der Person **Zweiten Faktor zurücksetzen…**. Die Liste zeigt
die Methoden jeder Person, „Fehlt“, wenn einer Pflicht ist und nicht eingerichtet wurde, und eine
laufende Sperre.

Ein Zurücksetzen entfernt App, Passkeys und Wiederherstellungscodes der Person und meldet sie
überall ab; bei ihrer nächsten Anmeldung richtet sie einen neuen zweiten Faktor ein, wenn einer
Pflicht ist. Du bestätigst zuerst mit deinem eigenen zweiten Faktor, und du brauchst einen, um
andere zurückzusetzen. Gib einen Grund für das Audit-Log an. Das Zurücksetzen wird im Audit-Log
festgehalten, und die Person bekommt eine E-Mail, sobald ein Mailserver eingerichtet ist. Admins
einer Organisation können Mitglieder zurücksetzen, die nur zu ihrer Organisation gehören und
keine Server-Admins sind; für alle anderen braucht es einen Server-Admin. Niemand kann auf diesem
Weg seinen eigenen zweiten Faktor zurücksetzen.
