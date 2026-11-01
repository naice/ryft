export const RISK_LEVELS = ['safe', 'caution', 'danger'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskAssessment {
  level: RiskLevel;
  /** Why, for the person about to run it. Empty only when the level is safe. */
  reasons: string[];
}

const FILES = 'Ändert oder löscht Dateien';
const SERVICES = 'Betrifft Dienste oder Prozesse';
const PRIVILEGE = 'Läuft mit erhöhten Rechten';
const REMOTE_CODE = 'Führt Code aus einer fremden Quelle aus';
const SYSTEM = 'Betrifft das ganze System';
const GIT = 'Ändert das Git-Repository';
const CONTAINERS = 'Ändert Container, Images oder Volumes';
const REMOTE = 'Verbindet sich mit einem anderen Rechner';
const NESTED = 'Führt weitere Befehle aus';
const NETWORK = 'Ändert Netzwerk oder Firewall';
const PACKAGES = 'Ändert installierte Pakete';
const UNCLASSIFIED = 'Nicht eingestuft, bitte selbst prüfen';

type Rule = readonly [pattern: RegExp, reason: string];

/** Tested against a whole command with its quotes intact. */
const DANGER_ANYWHERE: readonly Rule[] = [
  [/\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|python\d?|perl|ruby|iex|invoke-expression)\b/i, REMOTE_CODE],
  [/>\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk)/, SYSTEM]
];

/** Tested against one command with its wrappers removed, starting at the command name. */
const DANGER: readonly Rule[] = [
  [/^(?:rm|shred|wipefs|srm)(?:\s|$)/, FILES],
  [/^(?:dd|mkfs(?:\.\w+)?|fdisk|parted|sfdisk|format|diskpart)(?:\s|$)/, SYSTEM],
  [/^(?:shutdown|reboot|poweroff|halt|stop-computer|restart-computer|format-volume|clear-disk|initialize-disk)(?:\s|$)/, SYSTEM],
  [/^init\s+[06](?:\s|$)/, SYSTEM],
  [/^(?:chmod|chown|chgrp)\s(?:.*\s)?(?:-[A-Za-z]*R[A-Za-z]*|--recursive)(?:\s|$)/, FILES],
  [/^git\s+reset\s(?:.*\s)?--hard(?:\s|$)/, GIT],
  [/^git\s+clean(?!.*\s(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)(?:\s|$))/, GIT],
  [/^git\s+restore(?!.*\s--staged(?:\s|$))/, GIT],
  [/^git\s+checkout\s(?:.*\s)?--(?:\s|$)/, GIT],
  [/^git\s+push\s(?:.*\s)?(?:-f|--force|--force-with-lease|--delete|\+\S*)(?:\s|$)/, GIT],
  [/^git\s+branch\s(?:.*\s)?-D(?:\s|$)/, GIT],
  [/^git\s+stash\s+(?:drop|clear)(?:\s|$)/, GIT],
  [/^docker\s+(?:rm|rmi)(?:\s|$)/, CONTAINERS],
  [/^docker\s+(?:container|image|volume|network)\s+rm(?:\s|$)/, CONTAINERS],
  [/^docker\s+(?:\w+\s+)?prune(?:\s|$)/, CONTAINERS],
  [/^docker\s+compose\s+(?:down|rm)(?:\s|$)/, CONTAINERS],
  [/^kubectl\s+delete(?:\s|$)/, CONTAINERS],
  [/^find\s(?:.*\s)?-delete(?:\s|$)/, FILES],
  [/^(?:remove-item|ri|del|erase|rd|rmdir|clear-content|clear-recyclebin)(?:\s|$)/i, FILES],
  [/^remove-\w+(?:\s|$)/i, SYSTEM],
  [/^(?:iex|invoke-expression)(?:\s|$)/i, 'Führt beliebigen Text als Befehl aus']
];

/** Read-only commands. Anything not listed is not assumed harmless. */
const SAFE_COMMANDS = new Set([
  'uptime', 'free', 'df', 'ps', 'head', 'tail', 'cat', 'uname', 'lscpu', 'lsblk', 'who', 'w', 'last', 'vmstat', 'iostat',
  'dig', 'nslookup', 'ping', 'traceroute', 'tracepath', 'ls', 'grep', 'wc', 'tr', 'cut', 'printf',
  'echo', 'du', 'stat', 'file', 'sha256sum', 'shasum', 'md5sum', 'lsof', 'pgrep', 'which', 'id', 'whoami',
  'column', 'getent', 'sw_vers', 'pwd',
  // PowerShell
  'select-object', 'sort-object', 'where-object', 'measure-object', 'group-object', 'select-string', 'test-connection',
  'test-netconnection', 'resolve-dnsname', 'format-table', 'format-list', 'out-string', 'test-path'
]);

const SAFE_WHEN: readonly RegExp[] = [
  /^get-\w+(?:\s|$)/i,
  // Each of these only reads, unless an option or a second argument makes it write or set something.
  /^command\s+-[vV]\s/,
  /^sort(?=\s|$)(?!.*\s(?:-[A-Za-z]*o\S*|--output\S*)(?:\s|$))/,
  /^uniq(?:\s+-\S+)*(?:\s+\S+)?\s*$/,
  /^date(?:\s+(?:-u|-R|-I\S*|\+\S+))*\s*$/,
  /^hostname(?:\s+-[A-Za-z]+)*\s*$/,
  /^ss(?=\s|$)(?!.*\s(?:-[A-Za-z]*K[A-Za-z]*|--kill)(?:\s|$))/,
  /^ip\s+(?:-\w+\s+)*(?:a|addr|address|r|route|n|neigh|neighbor|neighbour|l|link)(?:\s+show(?:\s.*)?)?$/,
  /^systemctl\s+(?:status|show|is-active|is-enabled|is-failed|list-\S+|--failed|cat)(?:\s|$)/,
  /^journalctl(?!.*\s--(?:vacuum|rotate|flush|sync|relinquish))/,
  /^dmesg(?!.*\s(?:-[A-Za-z]*[cCDE][A-Za-z]*|--clear|--read-clear|--console\S*)(?:\s|$))/,
  /^timedatectl(?:\s+(?:status|show))?\s*$/,
  /^resolvectl(?:\s+(?:status|query|dns|domain))?(?:\s|$)/,
  /^find(?!.*\s-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)(?:\s|$))/,
  /^awk(?!.*(?:system\s*\(|getline|print[^|]*[>|]))/,
  /^sed(?!.*\s(?:-[A-Za-z]*i\S*|--in-place\S*)(?:\s|$))(?!.*[/\s][ew]\s)/,
  /^tar\s+-?t[A-Za-z]*(?:\s|$)/,
  /^rsync\s(?:.*\s)?(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)(?:\s|$)/,
  /^nc\s+-z[A-Za-z]*(?:\s|$)/,
  /^openssl\s+(?:s_client|x509|version)(?:\s|$)/,
  /^curl(?!.*\s(?:-[A-Za-z]*[odFTKJOXbcu][A-Za-z]*|--output\S*|--remote-name\S*|--data\S*|--form\S*|--upload\S*|--request\S*|--cookie-jar\S*|--config\S*|--json\S*)(?:\s|$))/,
  /^invoke-webrequest\s(?:.*\s)?-method\s+head(?:\s|$)(?!.*\s-outfile(?:\s|$))/i,
  /^ssh-keygen\s+-(?:l|F)/,
  /^ssh-add\s+-[lL](?:\s|$)/,
  /^ssh-keyscan(?:\s|$)/,
  /^ssh\s+-G(?:\s|$)/,
  /^git\s+(?:status|log|diff|show|blame|shortlog|rev-parse|describe|ls-files|cat-file|grep)(?:\s|$)/,
  /^git\s+remote(?:\s+-v)?\s*$/,
  /^git\s+reflog(?:\s+(?:-n\s*\S+|show(?:\s.*)?))?\s*$/,
  /^git\s+branch(?:\s+-[av]+)*\s*$/,
  /^git\s+tag\s*$/,
  /^git\s+stash\s+(?:list|show)(?:\s|$)/,
  /^git\s+clean\s(?:.*\s)?(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)(?:\s|$)/,
  /^docker\s+(?:ps|images|logs|stats|top|inspect|version|info|port|diff|history)(?:\s|$)/,
  /^docker\s+system\s+df(?:\s|$)/,
  /^docker\s+(?:network|volume|image|container)\s+(?:ls|list|inspect)(?:\s|$)/,
  /^docker\s+compose\s+(?:ps|logs|top|config|ls)(?:\s|$)/
];

const CAUTION: readonly Rule[] = [
  [/^(?:mv|cp|ln|mkdir|touch|chmod|chown|chgrp|tee|truncate|install|tar|unzip|gzip|gunzip|rsync|scp|sed)(?:\s|$)/, FILES],
  [/^(?:copy-item|move-item|rename-item|new-item|set-content|add-content|out-file|compress-archive|expand-archive|set-acl)(?:\s|$)/i, FILES],
  [/^(?:systemctl|service|launchctl|kill|pkill|killall|stop-service|start-service|restart-service|set-service|suspend-service|stop-process|start-process)(?:\s|$)/i, SERVICES],
  [/^git(?:\s|$)/, GIT],
  [/^docker(?:\s|$)/, CONTAINERS],
  [/^(?:ssh|sftp|ssh-copy-id|mosh|telnet|enter-pssession|invoke-command)(?:\s|$)/i, REMOTE],
  [/^(?:ssh-keygen|ssh-add|sshd)(?:\s|$)/, FILES],
  [/^(?:ip|ifconfig|route|ufw|iptables|nft|firewall-cmd|netsh|set-net\w*|new-net\w*)(?:\s|$)/i, NETWORK],
  [/^(?:apt|apt-get|dnf|yum|pacman|zypper|apk|brew|snap|pip\d?|npm|winget|choco|install-\w+|uninstall-\w+)(?:\s|$)/i, PACKAGES],
  [/^(?:mount|umount|sysctl|crontab|useradd|userdel|passwd|usermod|groupadd|set-\w+|enable-\w+|disable-\w+)(?:\s|$)/i, SYSTEM],
  [/^(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|nc|ncat)(?:\s|$)/i, REMOTE]
];

/** Commands which run other commands, whose arguments therefore cannot be judged by position. */
const WRAPPER = /^(?:xargs|bash|sh|zsh|dash|ksh|eval|exec|iex|invoke-expression|watch|ssh|parallel|foreach-object|%|cmd|powershell|pwsh|wsl)(?:\s|$)|^find\s(?:.*\s)?-(?:exec|execdir|ok|okdir)(?:\s|$)/i;
// ssh -G only prints configuration and is listed as read-only above.
const WRAPPER_EXEMPT = /^ssh\s+-G(?:\s|$)/;

const PREFIXES =
  /^(?:(?:sudo|doas)(?:\s+-[ugpCThURD]\s+\S+|\s+--\w[\w-]*=\S+|\s+-\w+)*|nohup|time|exec|builtin|busybox|command(?!\s+-[vV])|nice(?:\s+-n\s+\S+|\s+-\d+)?|ionice(?:\s+-\w+\s+\d+)*|timeout(?:\s+-\w+\s+\S+|\s+--\w[\w-]*(?:=\S+)?)*\s+\S+|env(?:\s+-[iu0](?:\s+[A-Z_]\w*)?)*|\w+=\S*)\s+/;
const ELEVATED = /^(?:sudo|doas|su|runas)(?:\s|$)|^start-process\s.*-verb\s+runas/i;

/** PowerShell constructs which only compute values for a column or a filter, so cannot run anything. */
const INERT_POWERSHELL: readonly RegExp[] = [
  /@\{\s*n(?:ame)?\s*=\s*'[^']*'\s*;\s*e(?:xpression)?\s*=\s*\{\s*(?:\[math\]::round\(\$_\.\w+(?:\s*[-/*+]\s*(?:\$_\.\w+|[\d.]+\w*))*(?:\s*,\s*\d+)?\)|\$_\.\w+)\s*\}\s*\}/gi,
  /@\{[^{}()$`|&]*\}/g
];

/** What remains of a PowerShell expression once the parentheses around commands are cut away. */
const INERT_EXPRESSION = /^(?:[-+/*.,]\s*\S*\s*$|-(?:split|join)\s+\S+\s*$|\$psversiontable(?:\.\w+)*\s*$|\$env:path(?:\s+-split\s+\S+)?\s*$|\.\w+(?:\.\w+)*\s*$)/i;

function raise(current: RiskAssessment, level: RiskLevel, reason: string): void {
  if (RISK_LEVELS.indexOf(level) > RISK_LEVELS.indexOf(current.level)) current.level = level;
  if (!current.reasons.includes(reason)) current.reasons.push(reason);
}

/** Splits at everything which starts another command, and never inside quotes. */
function segmentsOf(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  const cut = () => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
    } else if (char === '\\' && next !== undefined && next !== '\n') {
      current += char + next;
      index += 1;
    } else if (quote === '"') {
      // A substitution inside double quotes still runs.
      if (char === '$' && next === '(') {
        cut();
        index += 1;
      } else if (char === '`') {
        cut();
      } else {
        current += char;
        if (char === '"') quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === '&' && (command[index - 1] === '>' || next === '>')) {
      current += char;
    } else if (';|&\n\r`()'.includes(char)) {
      cut();
    } else if ((char === '$' || char === '<') && next === '(') {
      cut();
      index += 1;
    } else {
      current += char;
    }
  }
  cut();
  return segments;
}

/** The command without what merely runs it, and its name however it was spelled: \rm, "rm", /bin/rm. */
function normalizedHead(segment: string): string {
  let text = segment;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(PREFIXES, '');
  }
  const [first = '', ...rest] = text.split(/\s+/);
  const name = first
    .replace(/["']/g, '')
    .replace(/\\/g, '/')
    .replace(/^.*\/(?=[^/]+$)/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
  // Quotes must not hide an option from the rules, as in rm "-rf". What curl throws away is not a file it writes.
  const args = rest.map((word) => word.replace(/["'\\]/g, ''));
  const line = [name, ...args].join(' ');
  return name === 'curl' ? line.replace(/\s-o\s+\/dev\/null(?=\s|$)/, '') : line;
}

function writesToFile(segment: string): boolean {
  let quote: string | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '\\') {
      index += 1;
    } else if (char === '>') {
      const rest = segment.slice(index + 1).replace(/^>?\s*/, '');
      if (!rest.startsWith('&') && !/^(?:\/dev\/null|\$null)(?:\s|$)/i.test(rest)) return true;
    }
  }
  return false;
}

function classifySegment(segment: string, risk: RiskAssessment): void {
  if (ELEVATED.test(segment)) raise(risk, 'caution', PRIVILEGE);
  if (writesToFile(segment)) raise(risk, 'caution', FILES);

  const head = normalizedHead(segment);
  if (INERT_EXPRESSION.test(head)) return;

  let dangerous = false;
  for (const [pattern, reason] of DANGER) {
    if (pattern.test(head)) {
      raise(risk, 'danger', reason);
      dangerous = true;
    }
  }
  if (WRAPPER.test(head) && !WRAPPER_EXEMPT.test(head)) {
    raise(risk, 'caution', /^ssh(?:\s|$)/.test(head) ? REMOTE : NESTED);
    // The inner command can stand anywhere in the arguments, and in any quotes.
    const words = segment.replace(/["']/g, ' ').trim().split(/\s+/);
    for (let start = 1; start < words.length; start += 1) {
      const inner = normalizedHead(words.slice(start).join(' '));
      for (const [pattern, reason] of DANGER) if (pattern.test(inner)) raise(risk, 'danger', reason);
    }
    return;
  }
  if (dangerous) return;
  const [name = ''] = head.split(' ');
  if (SAFE_COMMANDS.has(name) || SAFE_WHEN.some((pattern) => pattern.test(head))) return;
  for (const [pattern, reason] of CAUTION) {
    if (pattern.test(head)) {
      raise(risk, 'caution', reason);
      return;
    }
  }
  raise(risk, 'caution', UNCLASSIFIED);
}

/**
 * What running a command may do. It works from a list of known read-only commands, so anything it does not
 * recognize comes out as `caution`, never as `safe`. A hint for the confirmation, not a sandbox.
 */
export function classifyCommand(command: string): RiskAssessment {
  const risk: RiskAssessment = { level: 'safe', reasons: [] };
  for (const [pattern, reason] of DANGER_ANYWHERE) if (pattern.test(command)) raise(risk, 'danger', reason);
  let text = command;
  for (const inert of INERT_POWERSHELL) text = text.replace(inert, '_');
  for (const segment of segmentsOf(text)) classifySegment(segment, risk);
  return risk;
}

export function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b;
}

export const RISK_LABEL: Record<RiskLevel, string> = { safe: 'Nur lesend', caution: 'Ändert etwas', danger: 'Gefährlich' };
