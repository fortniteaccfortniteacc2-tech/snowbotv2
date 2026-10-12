require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');

const {
  DISCORD_TOKEN, PANEL_CHANNEL_ID, ROBLOX_API_KEY,
  ROBLOX_UNIVERSE_ID = '10148843705',
  STAFF_ROLE_IDS = '', // can use Lookup and Kick
  ADMIN_ROLE_IDS = '', // can also use Ban, Unban, SSU
} = process.env;

for (const [k, v] of Object.entries({ DISCORD_TOKEN, PANEL_CHANNEL_ID, ROBLOX_API_KEY })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

// ---- Names that must match the game ----
const PROFILE_STORE = 'PlayerProfile';          // ProfileService store (PlayerDataHandler)
const PROFILE_KEY_PREFIX = 'Player_Snv4_v4';    // + UserId
const BAN_STORE = 'YBN:LSBanData0.13';          // AdminCommands ban store
const LEGACY_VEHICLE_STORE = 'COCRP-VehicleData__0010'; // VehicleDataCenter
const BRIDGE_TOPIC = 'DiscordAdminBridge';      // AdminCommands MessagingService topic

const ids = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const STAFF = ids(STAFF_ROLE_IDS);
const ADMIN = ids(ADMIN_ROLE_IDS);

function accessLevel(member) {
  const has = (list) => list.some((r) => member.roles.cache.has(r));
  if (has(ADMIN)) return 2;
  if (has(STAFF)) return 1;
  return 0;
}

// ---- Roblox helpers ----
async function resolveUser(input) {
  input = input.trim();
  if (/^\d{5,}$/.test(input)) {
    const r = await fetch(`https://users.roblox.com/v1/users/${input}`);
    if (!r.ok) throw new Error(`No Roblox user with ID ${input}.`);
    const u = await r.json();
    return { id: u.id, name: u.name };
  }
  const r = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
  });
  const j = await r.json();
  const u = j.data && j.data[0];
  if (!u) throw new Error(`No Roblox user named "${input}".`);
  return { id: u.id, name: u.name };
}

async function getEntry(store, key) {
  const url = `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}/standard-datastores/datastore/entries/entry`
    + `?datastoreName=${encodeURIComponent(store)}&scope=global&entryKey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'x-api-key': ROBLOX_API_KEY } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (check your API key permissions)' : '';
    throw new Error(`Roblox DataStore error ${res.status}${hint}: ${(await res.text()).slice(0, 150)}`);
  }
  return res.json();
}

async function publish(payload) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${ROBLOX_UNIVERSE_ID}/topics/${BRIDGE_TOPIC}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: JSON.stringify(payload) }),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (check your API key permissions)' : '';
    throw new Error(`Roblox Messaging error ${res.status}${hint}: ${(await res.text()).slice(0, 150)}`);
  }
}

let vehCache = { at: 0, list: [] };
async function getLegacyVehicles() {
  if (Date.now() - vehCache.at < 60_000) return vehCache.list;
  try {
    const list = await getEntry(LEGACY_VEHICLE_STORE, 'VehicleDataListArray');
    vehCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  } catch (e) {
    console.warn('Legacy vehicle lookup failed:', e.message);
    vehCache = { at: Date.now() - 50_000, list: [] }; // retry in ~10s
  }
  return vehCache.list;
}

// ---- Formatting ----
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
const clip = (s, n = 1000) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function playtime(min) {
  min = Math.floor(Number(min) || 0);
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function summarizeBackpack(bp) {
  if (!Array.isArray(bp) || bp.length === 0) return 'Empty';
  const counts = new Map();
  for (const item of bp) {
    let label;
    if (typeof item === 'string') label = item;
    else if (item && typeof item === 'object') label = (item.Name || 'Unknown') + (item.Serial ? ` #${item.Serial}` : '');
    else continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join(', ');
}

function banText(info) {
  if (!info || !info.isBanned) return null;
  const permanent = info.permanent || !info.duration;
  const expires = info.startTime + info.duration;
  if (!permanent && expires < Date.now() / 1000) return null; // expired
  const until = permanent ? 'Permanent' : `Until <t:${Math.floor(expires)}:f>`;
  return `${until} | by ${info.bannedBy || '?'} | ${info.reason || 'No reason'}`;
}

async function buildLookup(user, onlySlot) {
  const [profile, banInfo, vehicles] = await Promise.all([
    getEntry(PROFILE_STORE, PROFILE_KEY_PREFIX + user.id),
    getEntry(BAN_STORE, String(user.id)).catch(() => null),
    getLegacyVehicles(),
  ]);

  const embed = new EmbedBuilder()
    .setTitle(`${user.name} (${user.id})`)
    .setURL(`https://www.roblox.com/users/${user.id}/profile`)
    .setTimestamp();

  const ban = banText(banInfo);
  embed.setColor(ban ? 0xe53e3e : 0x2b6cb0);
  if (ban) embed.addFields({ name: '🔨 BANNED', value: clip(ban) });

  const pd = profile && ((profile.Data && profile.Data.PlayerData) || profile.PlayerData);
  if (!pd) {
    embed.setDescription('No saved game data found for this user (they may never have joined).');
    return embed;
  }
  embed.setDescription('Saved data (updates when the game autosaves, so it can be a minute or two behind).');

  const slots = pd.CharacterSlots || {};
  const names = [];
  for (let i = 1; i <= 5; i++) {
    const s = slots[i] || slots[String(i)];
    if (!s) continue;
    if (onlySlot && onlySlot !== i) continue;
    const c = s.CustomizationData || {};
    const name = `${c.FirstName || ''} ${c.LastName || ''}`.trim();
    const cars = Array.isArray(s.OwnedCars) ? s.OwnedCars : [];
    const empty = !name && !s.Cash && !s.Bank && !s.Playtime && !cars.length
      && !(Array.isArray(s.Backpack) && s.Backpack.length);
    if (empty && !onlySlot) continue;
    if (name) names.push(name);

    const lines = [
      `**Cash:** ${money(s.Cash)} | **Bank:** ${money(s.Bank)}${s.DirtyMoney ? ` | **Dirty:** ${money(s.DirtyMoney)}` : ''}`,
      `**Playtime:** ${playtime(s.Playtime)}${s.ID ? ` | **Char ID:** ${s.ID}` : ''}${s.Jailed ? ' | **JAILED**' : ''}`,
      `**Cars:** ${cars.length ? cars.map((v) => `${v.Name} (${v.Id})`).join(', ') : 'None'}`,
      `**Inventory:** ${summarizeBackpack(s.Backpack)}`,
    ];
    embed.addFields({
      name: `Slot ${i}: ${name || 'Unnamed'}${s.IsLocked ? ' 💀 (CK / locked)' : ''}`,
      value: clip(lines.join('\n')),
    });
  }

  // Older plate-based vehicle system (owner stored as "UserId:CharacterName")
  const mine = vehicles
    .map((row) => String(row).split('~'))
    .filter((p) => (p[1] || '').startsWith(`${user.id}:`))
    .map((p) => `${p[4]} — ${p[0]} (${(p[1] || '').split(':').slice(1).join(':')})`);
  if (mine.length) embed.addFields({ name: 'Licensed vehicles (plates)', value: clip(mine.join('\n')) });

  if (!embed.data.fields || embed.data.fields.length === 0) {
    embed.addFields({ name: 'Characters', value: 'No character data found.' });
  }
  return embed;
}

// ---- Panel ----
const PANEL_TITLE = 'Main Game Control Panel';
const EPHEMERAL = MessageFlags.Ephemeral;
// 1 = staff, 2 = admin
const PERM = { lookup: 1, kick: 1, ban: 2, unban: 2, ssu_start: 2, ssu_stop: 2 };

const btn = (id, label, style, emoji) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setEmoji(emoji);

function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setColor(0x2b6cb0)
    .setDescription('Use the buttons below.\n**Staff:** Lookup, Kick\n**Admin:** Ban, Unban, SSU');
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        btn('p:lookup', 'Lookup Player', ButtonStyle.Primary, '🔍'),
        btn('p:kick', 'Kick', ButtonStyle.Secondary, '👢'),
        btn('p:ban', 'Ban', ButtonStyle.Danger, '🔨'),
        btn('p:unban', 'Unban', ButtonStyle.Success, '✅'),
      ),
      new ActionRowBuilder().addComponents(
        btn('p:ssu_start', 'SSU Start', ButtonStyle.Success, '🟢'),
        btn('p:ssu_stop', 'SSU Stop', ButtonStyle.Danger, '🔴'),
      ),
    ],
  };
}

// Posts the panel in PANEL_CHANNEL_ID, or updates the existing one so there's only ever one.
async function ensurePanel() {
  const channel = await client.channels.fetch(PANEL_CHANNEL_ID);
  const recent = await channel.messages.fetch({ limit: 50 });
  const existing = recent.find((m) => m.author.id === client.user.id
    && m.embeds[0] && m.embeds[0].title === PANEL_TITLE);
  if (existing) await existing.edit(panelPayload());
  else await channel.send(panelPayload());
}

// ---- Modals ----
const MODAL_TITLES = {
  lookup: 'Lookup Player', kick: 'Kick Player', ban: 'Ban Player',
  unban: 'Unban Player', ssu_start: 'Start SSU',
};

function field(id, label, { required = false, paragraph = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setRequired(required)
      .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short),
  );
}

// userId '-' = opened from the panel (ask who); otherwise opened from a lookup result (target known)
function buildModal(action, userId, name) {
  const modal = new ModalBuilder()
    .setCustomId(`m:${action}:${userId}:${name}`)
    .setTitle(MODAL_TITLES[action]);
  const rows = [];
  if (action === 'lookup') {
    rows.push(field('user', 'Roblox username or user ID', { required: true }));
  } else if (action === 'ssu_start') {
    rows.push(field('seconds', 'Duration in seconds (optional)'));
  } else {
    if (userId === '-') {
      rows.push(field('user', 'Roblox username or user ID'));
      rows.push(field('character', 'Character name (online only)'));
    }
    rows.push(field('reason', 'Reason', { required: action === 'ban', paragraph: true }));
    if (action === 'ban') rows.push(field('minutes', 'Minutes (empty = permanent)'));
  }
  return modal.addComponents(...rows);
}

// ---- Interactions ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await ensurePanel();
    console.log('Panel is up.');
  } catch (e) {
    console.error('Could not post the panel (check PANEL_CHANNEL_ID and bot channel permissions):', e.message);
  }
});

const denied = (i) => i.reply({ content: 'You do not have permission to do that.', flags: EPHEMERAL });

async function onButton(i) {
  const [kind, action, userId = '-', name = '-'] = i.customId.split(':');
  if ((kind !== 'p' && kind !== 'q') || !PERM[action]) return;
  if (accessLevel(i.member) < PERM[action]) return denied(i);

  if (action === 'ssu_stop') {
    await i.deferReply();
    await publish({ type: 'ssu', action: 'stop' });
    return i.editReply(`📨 SSU **stop** sent by ${i.user.username}.`);
  }
  return i.showModal(buildModal(action, kind === 'q' ? userId : '-', name));
}

async function onModal(i) {
  const [kind, action, userId = '-', name = '-'] = i.customId.split(':');
  if (kind !== 'm' || !PERM[action]) return;
  if (accessLevel(i.member) < PERM[action]) return denied(i);

  const val = (id) => { try { return i.fields.getTextInputValue(id).trim(); } catch { return ''; } };
  const moderator = `${i.user.username} (Discord)`;

  if (action === 'lookup') {
    await i.deferReply({ flags: EPHEMERAL });
    const user = await resolveUser(val('user'));
    const embed = await buildLookup(user);
    const quick = (a, label, style, emoji) => btn(`q:${a}:${user.id}:${user.name}`, label, style, emoji);
    const row = new ActionRowBuilder().addComponents(
      quick('kick', 'Kick', ButtonStyle.Secondary, '👢'),
      quick('ban', 'Ban', ButtonStyle.Danger, '🔨'),
      quick('unban', 'Unban', ButtonStyle.Success, '✅'),
    );
    return i.editReply({ embeds: [embed], components: [row] });
  }

  await i.deferReply();

  if (action === 'ssu_start') {
    const seconds = parseInt(val('seconds'), 10);
    await publish({ type: 'ssu', action: 'start', durationSeconds: seconds > 0 ? seconds : undefined });
    return i.editReply(`📨 SSU **start** sent by ${i.user.username}${seconds > 0 ? ` (${seconds}s)` : ''}.`);
  }

  // kick / ban / unban: work out who
  let t;
  if (userId !== '-') {
    t = { fields: { userId: Number(userId), value: name }, label: `${name} (${userId})` };
  } else if (val('user')) {
    const u = await resolveUser(val('user'));
    t = { fields: { userId: u.id, value: u.name }, label: `${u.name} (${u.id})` };
  } else if (val('character')) {
    t = { fields: { kind: 'charname', value: val('character') }, label: `character "${val('character')}"` };
  } else {
    throw new Error('Give a Roblox username/ID or a character name.');
  }
  const reason = val('reason') || 'No reason provided';

  if (action === 'kick') {
    await publish({ type: 'kick', ...t.fields, reason, moderator });
    return i.editReply(`📨 Kick sent for **${t.label}** by ${i.user.username}. Only works if they're in a server right now.`);
  }
  if (action === 'ban') {
    const minutes = Math.max(0, parseInt(val('minutes'), 10) || 0);
    await publish({ type: 'ban', ...t.fields, reason, durationMinutes: minutes, moderator });
    return i.editReply(`📨 Ban sent for **${t.label}** by ${i.user.username} (${minutes ? minutes + ' min' : 'permanent'}): ${reason}`);
  }
  if (action === 'unban') {
    await publish({ type: 'unban', ...t.fields, reason: val('reason') || undefined, moderator });
    return i.editReply(`📨 Unban sent for **${t.label}** by ${i.user.username}.`);
  }
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isButton()) await onButton(i);
    else if (i.isModalSubmit()) await onModal(i);
  } catch (e) {
    console.error(e);
    const msg = `❌ ${e.message}`;
    try {
      if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] });
      else await i.reply({ content: msg, flags: EPHEMERAL });
    } catch (_) { /* interaction expired */ }
  }
});

client.login(DISCORD_TOKEN);
