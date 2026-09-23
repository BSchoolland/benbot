import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { OWNER_IDS } from './config.mjs';
import { q } from './db.mjs';
import { systemHeader } from './identity.mjs';
import { enqueue } from './queue.mjs';

// Secrets never touch a message or an agent transcript. A message carrying a 🔐 button (posted by
// scripts/discord-secret) opens a modal; the submitted value goes straight into the credentials file
// and the thread's agent is told only the key name.
export const SECRETS_FILE = process.env.SECRETS_FILE || path.join(os.homedir(), '.budget', 'credentials.env');
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function store(key, value) {
  const lines = fs.existsSync(SECRETS_FILE) ? fs.readFileSync(SECRETS_FILE, 'utf8').split('\n') : [];
  const line = `${key}=${value}`;
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  const replaced = i >= 0;
  if (replaced) lines[i] = line;
  else { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); lines.push(line, ''); }
  fs.writeFileSync(SECRETS_FILE, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
  return replaced;
}

export async function handleInteraction(interaction) {
  const isButton = interaction.isButton() && interaction.customId.startsWith('secret:');
  const isModal = interaction.isModalSubmit() && interaction.customId.startsWith('secret-modal:');
  if (!isButton && !isModal) return;
  const key = interaction.customId.split(':')[1];
  if (!KEY_RE.test(key)) throw new Error(`secret: bad key in customId ${interaction.customId}`);
  if (!OWNER_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: 'Only Ben can store secrets.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (isButton) {
    const modal = new ModalBuilder().setCustomId(`secret-modal:${key}`).setTitle(`Store ${key}`.slice(0, 45));
    const input = new TextInputBuilder().setCustomId('value').setLabel('Value (saved on the homeserver, never shown)')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4000);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  const value = interaction.fields.getTextInputValue('value').trim();
  const replaced = store(key, value);
  await interaction.reply({ content: `${replaced ? 'Replaced' : 'Stored'} ${key} (${value.length} chars) in ${SECRETS_FILE}.`, flags: MessageFlags.Ephemeral });
  const msg = interaction.message;
  if (msg) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`secret-done:${key}`).setLabel(`✅ ${key} stored`).setStyle(ButtonStyle.Success).setDisabled(true));
    await msg.edit({ components: [row] }).catch((e) => console.error('secret: could not update button message:', e.message));
  }
  const threadKey = interaction.channel?.isDMBased?.() ? `dm:${interaction.channelId}` : interaction.channelId;
  if (q.thread.get(threadKey)) {
    enqueue(threadKey, { text: `${systemHeader('secret')}\n${replaced ? 'Replaced' : 'Stored'} ${key} in ${SECRETS_FILE} (${value.length} chars). Parse the file in code; never print the value.` });
  }
  console.log(`[secret] ${replaced ? 'replaced' : 'stored'} ${key} for ${interaction.user.id}`);
}
