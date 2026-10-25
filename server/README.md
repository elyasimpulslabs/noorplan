# Noorplan Push Server

Kleiner Cloudflare Worker, der die Gebetserinnerungen zur richtigen Minute als Web Push ans Handy schickt, auch wenn die App geschlossen ist.

* Die App berechnet die Erinnerungen der nächsten 3 Wochen und schickt sie an `/sync`.
* Ein Durable Object speichert sie und stellt seinen Wecker auf die nächste Erinnerung.
* Die VAPID Schlüssel erzeugt der Server beim ersten Start selbst; die App holt den öffentlichen Schlüssel über `/vapid`.
* Keine externen Pakete; Verschlüsselung nach RFC 8291, geprüft mit dem offiziellen Testvektor.

Einrichtung: In Cloudflare unter Workers ein Projekt aus diesem Repository importieren, Root Verzeichnis `server`.
