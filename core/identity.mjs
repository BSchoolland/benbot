import { q } from './db.mjs';
import { OWNER_IDS } from './config.mjs';

// Every input the agent sees is prefixed by this line. It is the only place
// authority is declared; skills never widen it.
export function header({ discordId, displayName, guildId, guildName, channelName, isDM }) {
  const row = q.identity.get(discordId);
  const where = isDM ? 'DM' : `#${channelName} in ${guildName}`;
  if (!row) {
    return { known: false, line: `[from: ${displayName} · ${where} · unknown] ${q.dflt.get('stranger').note}` };
  }
  const override = guildId ? q.override.get(discordId, guildId) : null;
  const role = OWNER_IDS.includes(discordId) ? 'owner' : 'known';
  return { known: true, line: `[from: ${row.name} · ${where} · ${role}] ${override?.note ?? row.note}` };
}

export function systemHeader(source) {
  return `[from: system · ${source}] ${q.dflt.get('system').note}`;
}

export function reportHeader(source) {
  return `[from: ${source} · report to the conductor] ${q.dflt.get('system').note}`;
}
