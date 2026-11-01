import { choice, host, int, port, POSIX, presetsOf, UNIX, url, type Preset } from './define';

const preset = presetsOf('Netzwerk', { shells: POSIX, platforms: UNIX });

export const NETWORK_PRESETS: Preset[] = [
  preset('net.listening-linux', 'Offene Ports', 'Alle lauschenden TCP- und UDP-Ports. Prozessnamen fremder Benutzer sieht nur root.', 'ss -tulpn', {
    platforms: ['linux'],
    requiredTools: ['ss'],
    tags: ['ports']
  }),
  preset('net.listening-macos', 'Offene Ports', 'Alle lauschenden TCP-Ports mit Prozess.', 'lsof -nP -iTCP -sTCP:LISTEN', {
    platforms: ['macos'],
    requiredTools: ['lsof'],
    tags: ['ports']
  }),
  preset('net.addresses', 'IP-Adressen', 'Alle Netzwerkschnittstellen mit Zustand und Adressen.', 'ip -brief address', { platforms: ['linux'], requiredTools: ['ip'] }),
  preset('net.routes', 'Routing-Tabelle', 'Die aktuellen Routen.', 'ip route show', { platforms: ['linux'], requiredTools: ['ip'] }),
  preset('net.neighbors', 'Nachbarn', 'Bekannte Nachbarn im lokalen Netz (ARP und NDP).', 'ip neigh show', { platforms: ['linux'], requiredTools: ['ip'] }),
  preset('net.socket-summary', 'Socket-Übersicht', 'Anzahl der offenen Sockets nach Art und Zustand.', 'ss -s', { platforms: ['linux'], requiredTools: ['ss'] }),
  preset('net.ping', 'Ping', 'Prüft mit einer festen Anzahl Pakete, ob ein Rechner antwortet.', 'ping -c {{count}} {{host}}', {
    requiredTools: ['ping'],
    params: [int('count', 4, 'Anzahl der Pakete', 1000), host()]
  }),
  preset('net.dns', 'DNS-Abfrage', 'Fragt einen DNS-Eintrag ab und zeigt nur die Antwort.', 'dig +short {{name}} {{type}}', {
    requiredTools: ['dig'],
    params: [host('name', 'Der gesuchte Name'), choice('type', 'A', 'Art des Eintrags', ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA'])],
    tags: ['dns']
  }),
  preset('net.http-headers', 'HTTP-Header', 'Ruft nur die Header einer Adresse ab, mit Zeitlimit.', 'curl -sSI --max-time 10 {{url}}', {
    requiredTools: ['curl'],
    params: [url()],
    tags: ['http']
  }),
  preset('net.port-check', 'Port prüfen', 'Prüft, ob ein TCP-Port erreichbar ist, ohne Daten zu senden.', 'nc -zv -w 5 {{host}} {{port}}', {
    requiredTools: ['nc'],
    params: [host(), port('port', null, 'TCP-Port')],
    tags: ['ports']
  }),
  preset('net.traceroute', 'Route verfolgen', 'Zeigt die Stationen auf dem Weg zu einem Rechner.', 'traceroute {{host}}', {
    requiredTools: ['traceroute'],
    params: [host()]
  }),
  preset(
    'net.tls-certificate',
    'TLS-Zertifikat',
    'Aussteller und Laufzeit des Zertifikats, das ein Server vorlegt.',
    'openssl s_client -connect {{host}}:{{port}} -servername {{host}} </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates',
    { requiredTools: ['openssl'], params: [host(), port('port', 443, 'TLS-Port')], tags: ['tls'] }
  )
];
