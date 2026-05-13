const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─── Config Storage ───────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getServerConfig(guildId) {
  const cfg = loadConfig();
  return cfg[guildId] || null;
}

function setServerConfig(guildId, data) {
  const cfg = loadConfig();
  cfg[guildId] = { ...cfg[guildId], ...data };
  saveConfig(cfg);
}

// ─── Jellyfin API Helper ───────────────────────────────────────────────────────
async function jellyFetch(guildId, endpoint, options = {}) {
  const cfg = getServerConfig(guildId);
  if (!cfg?.serverUrl || !cfg?.apiToken) throw new Error('Bot not configured. Run `/config` first.');
  const url = `${cfg.serverUrl.replace(/\/$/, '')}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-Emby-Token': cfg.apiToken,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Jellyfin API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function jellyAuth(serverUrl, username, password) {
  const res = await fetch(`${serverUrl.replace(/\/$/, '')}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return res.json();
}

// ─── Watch Party State ─────────────────────────────────────────────────────────
const watchParties = new Map(); // guildId -> { itemId, itemName, channelId, members, startedAt, paused, position }

// ─── Slash Commands Definition ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure JellyBot with your Jellyfin server')
    .addStringOption(o => o.setName('server_url').setDescription('Your Jellyfin server URL (e.g. http://192.168.1.10:8096)').setRequired(true))
    .addStringOption(o => o.setName('api_token').setDescription('Your Jellyfin API token').setRequired(false))
    .addStringOption(o => o.setName('username').setDescription('Jellyfin username (alternative to token)').setRequired(false))
    .addStringOption(o => o.setName('password').setDescription('Jellyfin password').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for movies or shows on your Jellyfin server')
    .addStringOption(o => o.setName('query').setDescription('What to search for').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Filter by type').setRequired(false)
      .addChoices(
        { name: '🎬 Movies', value: 'Movie' },
        { name: '📺 TV Shows', value: 'Series' },
        { name: '🎵 Music', value: 'MusicAlbum' },
        { name: 'All', value: 'All' }
      )),

  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Start a watch party for a Jellyfin item')
    .addStringOption(o => o.setName('item_id').setDescription('Jellyfin item ID to watch').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Title of the item (for display)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('party')
    .setDescription('Show current watch party status and controls'),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the current watch party'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the current watch party'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the watch party (syncs for all members)'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the watch party'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop and end the watch party'),

  new SlashCommandBuilder()
    .setName('recent')
    .setDescription('Show recently added media on your Jellyfin server')
    .addIntegerOption(o => o.setName('count').setDescription('Number of items to show (default 8)').setRequired(false).setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what\'s currently playing on the Jellyfin server'),

  new SlashCommandBuilder()
    .setName('libraries')
    .setDescription('List all media libraries on your Jellyfin server'),

  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Get details about a specific Jellyfin item')
    .addStringOption(o => o.setName('item_id').setDescription('Jellyfin item ID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('stream')
    .setDescription('Get a direct stream link for a Jellyfin item')
    .addStringOption(o => o.setName('item_id').setDescription('Jellyfin item ID').setRequired(true)),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check Jellyfin server status and connection'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all JellyBot commands'),
];

// ─── Client Setup ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─── Register Commands ─────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🪼 JellyBot is online as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands registered globally');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// ─── Utility: Error Embed ──────────────────────────────────────────────────────
function errorEmbed(msg) {
  return new EmbedBuilder().setColor(0xff4757).setTitle('❌ Error').setDescription(msg).setTimestamp();
}

function successEmbed(title, desc) {
  return new EmbedBuilder().setColor(0x00d2d3).setTitle(title).setDescription(desc).setTimestamp();
}

function jellyEmbed(title) {
  return new EmbedBuilder().setColor(0x00b4d8).setAuthor({ name: '🪼 JellyBot', iconURL: 'https://jellyfin.org/images/favicon.ico' }).setTitle(title).setTimestamp();
}

function formatRuntime(ticks) {
  if (!ticks) return 'Unknown';
  const totalSec = Math.floor(ticks / 10_000_000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Command Handlers ──────────────────────────────────────────────────────────

async function handleConfig(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const serverUrl = interaction.options.getString('server_url');
  const apiToken = interaction.options.getString('api_token');
  const username = interaction.options.getString('username');
  const password = interaction.options.getString('password');
  const guildId = interaction.guildId;

  try {
    let token = apiToken;
    let userId = null;

    if (!token && username && password) {
      const auth = await jellyAuth(serverUrl, username, password);
      token = auth.AccessToken;
      userId = auth.User?.Id;
    }

    if (!token) {
      return interaction.editReply({ embeds: [errorEmbed('Provide either an **API token** or **username + password**.')] });
    }

    // Test connection
    const testRes = await fetch(`${serverUrl.replace(/\/$/, '')}/System/Info/Public`);
    if (!testRes.ok) throw new Error('Cannot reach Jellyfin server');
    const info = await testRes.json();

    setServerConfig(guildId, { serverUrl, apiToken: token, userId, serverName: info.ServerName });

    const embed = jellyEmbed('✅ JellyBot Configured!')
      .setDescription(`Successfully connected to **${info.ServerName}**`)
      .addFields(
        { name: '🌐 Server URL', value: serverUrl, inline: true },
        { name: '🔧 Version', value: info.Version || 'Unknown', inline: true },
        { name: '🔑 Auth Method', value: username ? 'Username/Password' : 'API Token', inline: true }
      )
      .setColor(0x2ed573);

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(`Configuration failed: ${err.message}`)] });
  }
}

async function handleSearch(interaction) {
  await interaction.deferReply();
  const query = interaction.options.getString('query');
  const type = interaction.options.getString('type') || 'All';
  const guildId = interaction.guildId;

  try {
    const params = new URLSearchParams({ SearchTerm: query, Limit: '8', Recursive: 'true' });
    if (type !== 'All') params.set('IncludeItemTypes', type);
    const data = await jellyFetch(guildId, `/Items?${params}`);
    const items = data.Items || [];

    if (!items.length) {
      return interaction.editReply({ embeds: [jellyEmbed(`🔍 No results for "${query}"`).setDescription('Try a different search term.')] });
    }

    const cfg = getServerConfig(guildId);
    const embed = jellyEmbed(`🔍 Results for "${query}"`)
      .setDescription(items.map((item, i) => {
        const type = item.Type === 'Movie' ? '🎬' : item.Type === 'Series' ? '📺' : item.Type === 'MusicAlbum' ? '🎵' : '📁';
        const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
        const runtime = item.RunTimeTicks ? ` • ${formatRuntime(item.RunTimeTicks)}` : '';
        return `${type} **${item.Name}**${year}${runtime}\n\`ID: ${item.Id}\``;
      }).join('\n\n'));

    // Add select menu for watch action
    if (items.filter(i => i.Type === 'Movie' || i.Type === 'Episode').length > 0) {
      const watchable = items.filter(i => i.Type === 'Movie' || i.Type === 'Episode').slice(0, 5);
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('watch_select')
          .setPlaceholder('🎬 Start a watch party...')
          .addOptions(watchable.map(item => ({
            label: item.Name.slice(0, 100),
            description: `${item.Type} • ${item.ProductionYear || 'Unknown year'} • ID: ${item.Id}`.slice(0, 100),
            value: item.Id,
          })))
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleWatch(interaction, itemId, itemTitle) {
  const guildId = interaction.guildId;
  const user = interaction.user;

  try {
    let title = itemTitle;
    if (!title) {
      const item = await jellyFetch(guildId, `/Items/${itemId}`);
      title = item.Name;
    }

    const party = {
      itemId,
      itemName: title,
      channelId: interaction.channelId,
      hostId: user.id,
      members: new Set([user.id]),
      startedAt: Date.now(),
      paused: false,
      position: 0,
    };
    watchParties.set(guildId, party);

    const cfg = getServerConfig(guildId);
    const streamUrl = `${cfg.serverUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?api_key=${cfg.apiToken}`;

    const embed = jellyEmbed(`🎬 Watch Party Started!`)
      .setDescription(`**${title}**\n\nA watch party has begun! Use the buttons below to manage it.`)
      .addFields(
        { name: '👤 Host', value: `<@${user.id}>`, inline: true },
        { name: '👥 Members', value: `<@${user.id}>`, inline: true },
        { name: '🔗 Stream Link', value: `[Open in browser](${streamUrl})`, inline: false },
      )
      .setFooter({ text: 'Use /join to join the party • /pause to pause • /stop to end' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('party_join').setLabel('Join Party').setStyle(ButtonStyle.Success).setEmoji('👋'),
      new ButtonBuilder().setCustomId('party_pause').setLabel('Pause').setStyle(ButtonStyle.Primary).setEmoji('⏸️'),
      new ButtonBuilder().setCustomId('party_resume').setLabel('Resume').setStyle(ButtonStyle.Primary).setEmoji('▶️'),
      new ButtonBuilder().setCustomId('party_stop').setLabel('End Party').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleParty(interaction) {
  const guildId = interaction.guildId;
  const party = watchParties.get(guildId);

  if (!party) {
    return interaction.reply({ embeds: [jellyEmbed('No Active Party').setDescription('No watch party is running.\nUse `/watch <item_id>` or `/search` to start one!')], ephemeral: true });
  }

  const elapsed = Math.floor((Date.now() - party.startedAt) / 1000);
  const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
  const elapsedStr = `${h > 0 ? h + 'h ' : ''}${m}m ${s}s`;
  const memberList = [...party.members].map(id => `<@${id}>`).join(', ');

  const embed = jellyEmbed(`${party.paused ? '⏸️' : '▶️'} Watch Party: ${party.itemName}`)
    .addFields(
      { name: '👤 Host', value: `<@${party.hostId}>`, inline: true },
      { name: '📊 Status', value: party.paused ? '⏸️ Paused' : '▶️ Playing', inline: true },
      { name: '⏱️ Running for', value: elapsedStr, inline: true },
      { name: `👥 Members (${party.members.size})`, value: memberList },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('party_join').setLabel('Join').setStyle(ButtonStyle.Success).setEmoji('👋'),
    new ButtonBuilder().setCustomId('party_pause').setLabel('Pause').setStyle(ButtonStyle.Primary).setEmoji('⏸️'),
    new ButtonBuilder().setCustomId('party_resume').setLabel('Resume').setStyle(ButtonStyle.Primary).setEmoji('▶️'),
    new ButtonBuilder().setCustomId('party_stop').setLabel('End').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleRecent(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const count = interaction.options.getInteger('count') || 8;

  try {
    const cfg = getServerConfig(guildId);
    const userId = cfg.userId || (await jellyFetch(guildId, '/Users'))[0]?.Id;
    const data = await jellyFetch(guildId, `/Users/${userId}/Items/Latest?Limit=${count}&Fields=Overview,RunTimeTicks`);

    const embed = jellyEmbed('🆕 Recently Added')
      .setDescription(data.map(item => {
        const type = item.Type === 'Movie' ? '🎬' : item.Type === 'Episode' ? '📺' : '📁';
        const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';
        const runtime = item.RunTimeTicks ? ` • ${formatRuntime(item.RunTimeTicks)}` : '';
        return `${type} **${item.Name}**${year}${runtime}\n\`${item.Id}\``;
      }).join('\n\n') || 'Nothing recently added.');

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleNowPlaying(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;

  try {
    const sessions = await jellyFetch(guildId, '/Sessions');
    const active = sessions.filter(s => s.NowPlayingItem);

    if (!active.length) {
      return interaction.editReply({ embeds: [jellyEmbed('📺 Now Playing').setDescription('Nothing is playing right now.')] });
    }

    const embed = jellyEmbed(`📺 Now Playing (${active.length} session${active.length > 1 ? 's' : ''})`);
    embed.setDescription(active.map(s => {
      const item = s.NowPlayingItem;
      const pos = s.PlayState?.PositionTicks ? formatRuntime(s.PlayState.PositionTicks) : '?';
      const dur = item.RunTimeTicks ? formatRuntime(item.RunTimeTicks) : '?';
      const paused = s.PlayState?.IsPaused ? '⏸️' : '▶️';
      return `${paused} **${item.Name}** • ${pos} / ${dur}\n👤 ${s.UserName || 'Unknown'} • 📱 ${s.Client || 'Unknown client'}`;
    }).join('\n\n'));

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleLibraries(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;

  try {
    const data = await jellyFetch(guildId, '/Library/MediaFolders');
    const libs = data.Items || [];

    const embed = jellyEmbed('📚 Media Libraries')
      .setDescription(libs.map(lib => {
        const icon = lib.CollectionType === 'movies' ? '🎬' : lib.CollectionType === 'tvshows' ? '📺' : lib.CollectionType === 'music' ? '🎵' : '📁';
        return `${icon} **${lib.Name}** — \`${lib.CollectionType || 'mixed'}\`\n\`ID: ${lib.Id}\``;
      }).join('\n\n') || 'No libraries found.');

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleInfo(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const itemId = interaction.options.getString('item_id');

  try {
    const item = await jellyFetch(guildId, `/Items/${itemId}?Fields=Overview,Genres,Studios,RunTimeTicks,OfficialRating`);
    const cfg = getServerConfig(guildId);

    const type = item.Type === 'Movie' ? '🎬 Movie' : item.Type === 'Series' ? '📺 Series' : item.Type === 'Episode' ? '📺 Episode' : '📁';
    const embed = jellyEmbed(`${type}: ${item.Name}`)
      .setDescription(item.Overview ? item.Overview.slice(0, 300) + (item.Overview.length > 300 ? '...' : '') : 'No description.')
      .addFields(
        { name: '📅 Year', value: item.ProductionYear?.toString() || 'Unknown', inline: true },
        { name: '⏱️ Runtime', value: formatRuntime(item.RunTimeTicks), inline: true },
        { name: '⭐ Rating', value: item.OfficialRating || 'N/A', inline: true },
        { name: '🎭 Genres', value: item.Genres?.join(', ') || 'None', inline: false },
        { name: '🆔 Item ID', value: `\`${item.Id}\``, inline: false },
      )
      .setImage(`${cfg.serverUrl.replace(/\/$/, '')}/Items/${item.Id}/Images/Backdrop?api_key=${cfg.apiToken}&maxWidth=1280`)
      .setThumbnail(`${cfg.serverUrl.replace(/\/$/, '')}/Items/${item.Id}/Images/Primary?api_key=${cfg.apiToken}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`watch_now_${item.Id}`)
        .setLabel('Watch Party')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🎬'),
      new ButtonBuilder()
        .setURL(`${cfg.serverUrl.replace(/\/$/, '')}/web/index.html#!/details?id=${item.Id}`)
        .setLabel('Open in Jellyfin')
        .setStyle(ButtonStyle.Link)
        .setEmoji('🌐'),
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleStream(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  const itemId = interaction.options.getString('item_id');

  try {
    const item = await jellyFetch(guildId, `/Items/${itemId}`);
    const cfg = getServerConfig(guildId);
    const streamUrl = `${cfg.serverUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?api_key=${cfg.apiToken}`;
    const hlsUrl = `${cfg.serverUrl.replace(/\/$/, '')}/Videos/${itemId}/master.m3u8?api_key=${cfg.apiToken}`;

    const embed = jellyEmbed(`🔗 Stream Links: ${item.Name}`)
      .addFields(
        { name: '🎬 Direct Stream', value: `[Click to stream](${streamUrl})`, inline: true },
        { name: '📡 HLS Stream', value: `[M3U8 link](${hlsUrl})`, inline: true },
      )
      .setDescription('⚠️ These links include your API token. **Do not share publicly.**')
      .setColor(0xffa502);

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}

async function handleStatus(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const cfg = getServerConfig(guildId);

  if (!cfg) {
    return interaction.editReply({ embeds: [errorEmbed('Bot not configured. Use `/config` to set up your Jellyfin server.')] });
  }

  try {
    const start = Date.now();
    const info = await jellyFetch(guildId, '/System/Info');
    const ping = Date.now() - start;

    const embed = jellyEmbed('📡 Server Status')
      .setColor(0x2ed573)
      .addFields(
        { name: '🟢 Status', value: 'Online', inline: true },
        { name: '📶 Ping', value: `${ping}ms`, inline: true },
        { name: '🏷️ Server Name', value: info.ServerName || 'Unknown', inline: true },
        { name: '🔧 Version', value: info.Version || 'Unknown', inline: true },
        { name: '💾 OS', value: info.OperatingSystem || 'Unknown', inline: true },
        { name: '🌐 URL', value: cfg.serverUrl, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const embed = jellyEmbed('📡 Server Status')
      .setColor(0xff4757)
      .addFields(
        { name: '🔴 Status', value: 'Offline / Error', inline: true },
        { name: '🌐 URL', value: cfg.serverUrl, inline: true },
        { name: '❌ Error', value: err.message },
      );
    await interaction.editReply({ embeds: [embed] });
  }
}

async function handleHelp(interaction) {
  const embed = jellyEmbed('🪼 JellyBot Commands')
    .setDescription('Your Jellyfin watch-together bot for Discord!')
    .addFields(
      {
        name: '⚙️ Setup',
        value: [
          '`/config` — Set your Jellyfin server URL and credentials',
          '`/status` — Check server connection and info',
        ].join('\n'),
      },
      {
        name: '🔍 Browse',
        value: [
          '`/search <query>` — Search for movies, shows, music',
          '`/recent` — Show recently added media',
          '`/libraries` — List all media libraries',
          '`/info <item_id>` — Get details about an item',
        ].join('\n'),
      },
      {
        name: '🎬 Watch Party',
        value: [
          '`/watch <item_id>` — Start a watch party',
          '`/party` — Show current party status & controls',
          '`/join` — Join the active watch party',
          '`/leave` — Leave the watch party',
          '`/pause` — Pause for everyone',
          '`/resume` — Resume for everyone',
          '`/stop` — End the watch party',
        ].join('\n'),
      },
      {
        name: '🔗 Streaming',
        value: [
          '`/stream <item_id>` — Get direct stream links',
          '`/nowplaying` — See active playback sessions',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Powered by Jellyfin • Made with 🪼 by JellyBot' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Interaction Handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  const guildId = interaction.guildId;

  // Button interactions
  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'party_join' || customId === 'watch_join') {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      party.members.add(interaction.user.id);
      await interaction.reply({ embeds: [successEmbed('👋 Joined!', `You joined the watch party for **${party.itemName}**!\n${[...party.members].map(id => `<@${id}>`).join(', ')}`)], ephemeral: true });
    }

    if (customId === 'party_pause') {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      party.paused = true;
      await interaction.reply({ embeds: [successEmbed('⏸️ Paused', `**${party.itemName}** has been paused.\n${[...party.members].map(id => `<@${id}>`).join(' ')} — everyone pause!`)] });
    }

    if (customId === 'party_resume') {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      party.paused = false;
      await interaction.reply({ embeds: [successEmbed('▶️ Resumed', `**${party.itemName}** is resuming!\n${[...party.members].map(id => `<@${id}>`).join(' ')} — everyone play!`)] });
    }

    if (customId === 'party_stop') {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      watchParties.delete(guildId);
      await interaction.reply({ embeds: [successEmbed('⏹️ Party Ended', `The watch party for **${party.itemName}** has ended. Thanks for watching!`)] });
    }

    if (customId.startsWith('watch_now_')) {
      const itemId = customId.replace('watch_now_', '');
      await interaction.deferReply();
      await handleWatch(interaction, itemId, null);
    }

    return;
  }

  // Select menu interactions
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'watch_select') {
      const itemId = interaction.values[0];
      await interaction.deferReply();
      await handleWatch(interaction, itemId, null);
    }
    return;
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;

  // Config check (skip for config, status, help)
  const noConfigNeeded = ['config', 'help'];
  if (!noConfigNeeded.includes(interaction.commandName) && !getServerConfig(guildId)) {
    return interaction.reply({ embeds: [errorEmbed('JellyBot is not configured yet!\nAn admin needs to run `/config` first.')], ephemeral: true });
  }

  switch (interaction.commandName) {
    case 'config':      return handleConfig(interaction);
    case 'search':      return handleSearch(interaction);
    case 'watch':       await interaction.deferReply(); return handleWatch(interaction, interaction.options.getString('item_id'), interaction.options.getString('title'));
    case 'party':       return handleParty(interaction);
    case 'recent':      return handleRecent(interaction);
    case 'nowplaying':  return handleNowPlaying(interaction);
    case 'libraries':   return handleLibraries(interaction);
    case 'info':        return handleInfo(interaction);
    case 'stream':      return handleStream(interaction);
    case 'status':      return handleStatus(interaction);
    case 'help':        return handleHelp(interaction);

    case 'join': {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party. Start one with `/watch`!')], ephemeral: true });
      party.members.add(interaction.user.id);
      return interaction.reply({ embeds: [successEmbed('👋 Joined!', `<@${interaction.user.id}> joined the watch party for **${party.itemName}**!\n👥 ${[...party.members].map(id => `<@${id}>`).join(', ')}`)] });
    }

    case 'leave': {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      party.members.delete(interaction.user.id);
      return interaction.reply({ embeds: [successEmbed('👋 Left', `<@${interaction.user.id}> left the watch party.`)], ephemeral: true });
    }

    case 'pause': {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      party.paused = true;
      return interaction.reply({ embeds: [successEmbed('⏸️ Paused!', `**${party.itemName}** paused by <@${interaction.user.id}>!\n${[...party.members].map(id => `<@${id}>`).join(' ')} — pause your player!`)] });
    }

    case 'resume': {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      party.paused = false;
      return interaction.reply({ embeds: [successEmbed('▶️ Resumed!', `**${party.itemName}** resumed by <@${interaction.user.id}>!\n${[...party.members].map(id => `<@${id}>`).join(' ')} — press play!`)] });
    }

    case 'stop': {
      const party = watchParties.get(guildId);
      if (!party) return interaction.reply({ embeds: [errorEmbed('No active watch party.')], ephemeral: true });
      watchParties.delete(guildId);
      return interaction.reply({ embeds: [successEmbed('⏹️ Party Ended', `Watch party for **${party.itemName}** ended by <@${interaction.user.id}>. Thanks for watching! 🪼`)] });
    }
  }
});

// ─── Start Bot ─────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN environment variable not set!');
  process.exit(1);
}
client.login(token);
