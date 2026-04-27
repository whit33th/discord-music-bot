import {
  QueryType,
  QueueRepeatMode,
  type GuildQueue,
  type LrcSearchResult,
  type Player,
  type Track,
} from "discord-player";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";
import {
  listFavorites,
  removeFavorite,
  saveFavorite,
  type FavoriteEntry,
} from "./favorites.js";
import {
  logPlaybackPhase,
  logQueuePlaybackPhase,
  markPlayerStart,
  startPlaybackTrace,
} from "./telemetry.js";

const BOT_BUSY_ERROR = "BOT_BUSY_IN_ANOTHER_CHANNEL";
const CONTROL_PREFIX = "musicctl";
const PANEL_PREFIX = "musicpanel";
const EMBED_COLOR = 0x000000;
const PAGE_SIZE = 8;
const LYRICS_PAGE_SIZE = 14;
const VOLUME_STEP = 10;
const SEEK_FADE_OUT_MS = 300;
const SEEK_FADE_IN_MS = 300;
const FADE_STEPS = 6;
const GOOGLEVIDEO_EXTRACTOR_ID = "ext:com.github.xxczaki.youtube-sabr";
const YOUTUBEI_EXTRACTOR_ID =
  "ext:com.retrouser955.discord-player.discord-player-youtubei";

const EMOJI_VOLUME_DOWN = "1486416641708392499";
const EMOJI_VOLUME_UP = "1486416638818517002";
const EMOJI_PREVIOUS = "1486104235262349333";
const EMOJI_NEXT = "1486104242417832006";
const EMOJI_PLAY = "1486104239511044326";
const EMOJI_PAUSE = "1486104243890028594";
const EMOJI_STOP = "1486104254652616896";
const EMOJI_LOOP_TRACK = "1486104266522493060";
const EMOJI_LOOP_QUEUE = "1486110000290988063";
const EMOJI_AUTOPLAY = "1486109960973844512";
const EMOJI_AUTOPLAY_OFF = "1498355471206187161";

const EMOJI_MORE = "1486110006112817232";
const EMOJI_QUEUE = "1486104256619479276";
const EMOJI_LYRICS = "1486417808072900678";
const EMOJI_EFFECTS = "1486104284289568940";
const EMOJI_FAVORITES = "1486104262655086754";
const EMOJI_CLOSE = "1486116488791457812";
const EMOJI_REMOVE = "1486412564681195571";
const EMOJI_BASS = "1486110017924108288";
const EMOJI_NIGHTCORE = "1486104289750286458";
const EMOJI_8D = "1486109951133745212";
const EMOJI_CLEAR = "\u{1F9F9}";

const ICON_PAGE_PREV = "1486117061548703794";
const ICON_PAGE_NEXT = "1486117059711729785";

const EFFECT_FILTERS = {
  bassboost: {
    label: "Bass",
    emoji: EMOJI_BASS,
    filter: "bassboost",
  },
  nightcore: {
    label: "Nightcore",
    emoji: EMOJI_NIGHTCORE,
    filter: "nightcore",
  },
  "8D": {
    label: "8D",
    emoji: EMOJI_8D,
    filter: "8D",
  },
} as const;

type EffectKey = keyof typeof EFFECT_FILTERS;

type PlaybackMetadata = {
  textChannel: GuildTextBasedChannel;
  controlMessage: Message | null;
};

type PlayTrackInput = {
  player: Player;
  member: GuildMember;
  query: string;
  textChannel: GuildTextBasedChannel;
  requestedBy: User;
};

type PlayTrackResult = {
  track: Track;
  playlistTitle: string | null;
  wasPlaying: boolean;
};

type QueueManagerState = {
  page: number;
  selectedIndex: number;
};

type LyricsView = {
  pages: string[];
  currentLine: string | null;
  source: "synced" | "plain";
};

const lyricsCache = new Map<string, LyricsView>();
const fadingQueues = new Set<string>();
const panelSyncTasks = new Map<string, Promise<void>>();

function isYouTubeQuery(query: string) {
  return (
    query.startsWith("ytsearch:") || /(?:youtube\.com|youtu\.be)/i.test(query)
  );
}

function isPlaybackMetadata(value: unknown): value is PlaybackMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "textChannel" in value &&
    "controlMessage" in value
  );
}

function getPlaybackMetadata(value: unknown): PlaybackMetadata | null {
  return isPlaybackMetadata(value) ? value : null;
}

function queuePanelSync(
  queue: GuildQueue<PlaybackMetadata>,
  task: () => Promise<void>,
) {
  const guildId = queue.guild.id;
  const previousTask = panelSyncTasks.get(guildId) ?? Promise.resolve();
  const nextTask = previousTask
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.error(`[control-panel:${guildId}]`, error);
    })
    .finally(() => {
      if (panelSyncTasks.get(guildId) === nextTask) {
        panelSyncTasks.delete(guildId);
      }
    });

  panelSyncTasks.set(guildId, nextTask);
  return nextTask;
}

function getVoiceChannel(member: GuildMember) {
  return member.voice.channel;
}

function isUrl(query: string): boolean {
  return /^https?:\/\//i.test(query);
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function isQueuePaused(queue: GuildQueue) {
  return queue.dispatcher?.paused ?? false;
}

function getYouTubeSearchEngine() {
  return (process.env.YOUTUBE_EXTRACTOR ?? "youtubei").toLowerCase() ===
    "googlevideo"
    ? GOOGLEVIDEO_EXTRACTOR_ID
    : YOUTUBEI_EXTRACTOR_ID;
}

function getQueueTracks(queue: GuildQueue) {
  return queue.tracks.toArray();
}

function getQueueVolume(queue: GuildQueue) {
  return Math.round(queue.node.volume || 0);
}

function isAutoplayEnabled(queue: GuildQueue) {
  return queue.repeatMode === QueueRepeatMode.AUTOPLAY;
}

function getLoopButtonLabel(mode: number) {
  if (mode === QueueRepeatMode.TRACK) return "Loop Track";
  return "Loop Queue";
}

function getLoopEmoji(mode: number) {
  return mode === QueueRepeatMode.TRACK ? EMOJI_LOOP_TRACK : EMOJI_LOOP_QUEUE;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSelection(
  totalItems: number,
  page: number,
  selectedIndex: number,
  pageSize: number,
): QueueManagerState {
  if (totalItems === 0) {
    return { page: 0, selectedIndex: -1 };
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = clamp(page, 0, totalPages - 1);
  const pageStart = safePage * pageSize;
  const pageEnd = Math.min(pageStart + pageSize - 1, totalItems - 1);
  const initialSelectedIndex =
    selectedIndex < 0 ? pageStart : clamp(selectedIndex, 0, totalItems - 1);
  const safeSelectedIndex =
    initialSelectedIndex < pageStart || initialSelectedIndex > pageEnd
      ? pageStart
      : initialSelectedIndex;

  return {
    page: safePage,
    selectedIndex: safeSelectedIndex,
  };
}

function canSeek(track: Track | null) {
  return Boolean(
    track && track.seekable && !track.live && track.durationMS > 0,
  );
}

function formatTimestamp(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkLines(lines: string[], size: number) {
  const sanitized = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (sanitized.length === 0) {
    return ["Nothing to show."];
  }

  const pages: string[] = [];

  for (let index = 0; index < sanitized.length; index += size) {
    pages.push(sanitized.slice(index, index + size).join("\n"));
  }

  return pages;
}

function getActiveEffect(queue: GuildQueue): EffectKey | null {
  for (const effect of Object.keys(EFFECT_FILTERS) as EffectKey[]) {
    const filter = EFFECT_FILTERS[effect].filter;
    if (queue.filters.ffmpeg.isEnabled(filter)) {
      return effect;
    }
  }

  return null;
}

function getEffectLabel(queue: GuildQueue) {
  const activeEffect = getActiveEffect(queue);
  return activeEffect ? EFFECT_FILTERS[activeEffect].label : "Off";
}

function resolveEmojiToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return null;

  if (/^\d{17,20}$/.test(trimmed)) {
    return { id: trimmed };
  }

  const customMatch = trimmed.match(/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/);
  if (customMatch) {
    return {
      id: customMatch[3],
      name: customMatch[2],
      animated: customMatch[1] === "a",
    };
  }

  if (/\p{Extended_Pictographic}/u.test(trimmed)) {
    return { name: trimmed };
  }

  return null;
}

function formatTextEmoji(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return "";

  if (/^\d{17,20}$/.test(trimmed)) {
    return trimmed;
  }

  const shortCustomMatch = trimmed.match(/^([a-zA-Z0-9_]+):(\d{17,20})$/);
  if (shortCustomMatch) {
    return `<:${shortCustomMatch[1]}:${shortCustomMatch[2]}>`;
  }

  const shortAnimatedMatch = trimmed.match(/^a:([a-zA-Z0-9_]+):(\d{17,20})$/);
  if (shortAnimatedMatch) {
    return `<a:${shortAnimatedMatch[1]}:${shortAnimatedMatch[2]}>`;
  }

  if (/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed;
}

async function resolveTextEmoji(token: string, client: GuildMember["client"]) {
  void client;
  return formatTextEmoji(token);
}

function createIconButton(customId: string, label: string, disabled = false) {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const emoji = resolveEmojiToken(label);
  if (emoji) {
    return button.setEmoji(emoji);
  }

  return button.setLabel(label);
}

function createControlButton(
  customId: string,
  label: string,
  emoji: string,
  disabled = false,
) {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const resolvedEmoji = resolveEmojiToken(emoji);
  if (resolvedEmoji) {
    button.setEmoji(resolvedEmoji);
  }

  return button;
}

async function buildMainControlEmbed(queue: GuildQueue<PlaybackMetadata>) {
  const currentTrack = queue.currentTrack;
  if (!currentTrack) return null;

  const embed = new EmbedBuilder();
  embed
    .setAuthor({
      name: currentTrack.requestedBy?.username ?? "Unknown",
      iconURL: currentTrack.requestedBy?.displayAvatarURL({
        forceStatic: false,
        size: 128,
      }),
    })
    .setTitle(truncate(currentTrack.title, 256))
    .setURL(currentTrack.url)
    .addFields(
      {
        name: "Requested By",
        value: currentTrack.requestedBy
          ? `${currentTrack.requestedBy}`
          : "Unknown",
        inline: true,
      },
      {
        name: "Music Duration",
        value: currentTrack.duration || "Live",
        inline: true,
      },
      {
        name: "Music Author",
        value: truncate(currentTrack.author || "Unknown Artist", 64),
        inline: true,
      },
    );

  if (currentTrack.thumbnail) {
    embed.setThumbnail(currentTrack.thumbnail);
  }

  return embed;
}

function buildQueueEndedEmbed(client: Client) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({
      name: client.user?.username ?? "Bot",
      iconURL: client.user?.displayAvatarURL({ forceStatic: false, size: 128 }),
    })
    .setTitle("Queue Ended!")
    .setDescription(
      "All songs have been played! You can add songs again using `/play` command.",
    );
}

function buildControls(queue: GuildQueue<PlaybackMetadata>) {
  const hasTrack = Boolean(queue.currentTrack);
  const queueTracks = getQueueTracks(queue);
  const hasVoiceSession = Boolean(queue.channel);
  const hasPlayableContext =
    hasVoiceSession || hasTrack || queueTracks.length > 0;
  const canGoPrevious = !queue.history.disabled && !queue.history.isEmpty();
  const canGoNext = queueTracks.length > 0;

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      createControlButton(
        `${CONTROL_PREFIX}:volume_down`,
        "Down",
        EMOJI_VOLUME_DOWN,
        !hasPlayableContext,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:previous`,
        "Prev",
        EMOJI_PREVIOUS,
        !canGoPrevious,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:toggle`,
        isQueuePaused(queue) ? "Play" : "Pause",
        isQueuePaused(queue) ? EMOJI_PLAY : EMOJI_PAUSE,
        !hasTrack,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:next`,
        "Next",
        EMOJI_NEXT,
        !canGoNext,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:volume_up`,
        "Up",
        EMOJI_VOLUME_UP,
        !hasPlayableContext,
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      createControlButton(
        `${CONTROL_PREFIX}:loop`,
        getLoopButtonLabel(queue.repeatMode),
        getLoopEmoji(queue.repeatMode),
        !hasTrack,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:stop`,
        "Stop",
        EMOJI_STOP,
        !hasTrack && queueTracks.length === 0,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:autoplay`,
        "Autoplay",
        isAutoplayEnabled(queue) ? EMOJI_AUTOPLAY : EMOJI_AUTOPLAY_OFF,
        !hasTrack,
      ),
      createControlButton(
        `${CONTROL_PREFIX}:more`,
        "Moreeee",
        EMOJI_MORE,
        !hasPlayableContext,
      ),
    ),
  ];
}

async function syncControlPanel(
  queue: GuildQueue<PlaybackMetadata>,
  sendIfMissing = true,
  reason = "unknown",
  bump = false,
) {
  return queuePanelSync(queue, async () => {
    const metadata = getPlaybackMetadata(queue.metadata);
    if (!metadata) {
      logQueuePlaybackPhase(queue, "control_panel_sync_end", {
        reason,
        outcome: "no_metadata",
      });
      return;
    }

    logQueuePlaybackPhase(queue, "control_panel_sync_start", {
      reason,
      sendIfMissing,
      hasControlMessage: Boolean(metadata.controlMessage),
      currentTrack: queue.currentTrack?.title ?? null,
    });

    const embed = await buildMainControlEmbed(queue);
    if (!embed) {
      logQueuePlaybackPhase(queue, "control_panel_sync_end", {
        reason,
        outcome: "no_current_track",
      });
      return;
    }

    const payload = {
      embeds: [embed],
      components: buildControls(queue),
    };

    if (bump && metadata.controlMessage) {
      await metadata.controlMessage.delete().catch(() => null);
      metadata.controlMessage = null;
    }

    if (metadata.controlMessage) {
      try {
        metadata.controlMessage = await metadata.controlMessage.edit(payload);
        queue.setMetadata(metadata);
        logQueuePlaybackPhase(queue, "control_panel_sync_end", {
          reason,
          outcome: "edited",
        });
        return;
      } catch {
        metadata.controlMessage = null;
      }
    }

    if (!sendIfMissing) {
      queue.setMetadata(metadata);
      logQueuePlaybackPhase(queue, "control_panel_sync_end", {
        reason,
        outcome: "missing_message_skipped",
      });
      return;
    }

    try {
      metadata.controlMessage = await metadata.textChannel.send(payload);
      queue.setMetadata(metadata);
      logQueuePlaybackPhase(queue, "control_panel_sync_end", {
        reason,
        outcome: "sent",
      });
    } catch (error) {
      console.error(`[control-panel:${queue.guild.id}]`, error);
      metadata.controlMessage = null;
      queue.setMetadata(metadata);
      logQueuePlaybackPhase(queue, "control_panel_sync_end", {
        reason,
        outcome: "send_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function bumpPlaybackPanel(
  queue: GuildQueue<PlaybackMetadata>,
  reason = "commandReply",
) {
  await syncControlPanel(queue, true, reason, true);
}

async function showQueueEndedPanel(queue: GuildQueue<PlaybackMetadata>) {
  return queuePanelSync(queue, async () => {
    const metadata = getPlaybackMetadata(queue.metadata);
    if (!metadata?.controlMessage) {
      return;
    }

    try {
      metadata.controlMessage = await metadata.controlMessage.edit({
        embeds: [buildQueueEndedEmbed(queue.guild.client)],
        components: [],
      });
    } catch {
      metadata.controlMessage = null;
    }

    queue.setMetadata(metadata);
  });
}

function buildMetadata(
  textChannel: GuildTextBasedChannel,
  queue: GuildQueue | null,
): PlaybackMetadata {
  const currentMetadata = getPlaybackMetadata(queue?.metadata);
  const preserveControlMessage =
    currentMetadata?.textChannel.id === textChannel.id
      ? currentMetadata.controlMessage
      : null;

  return {
    textChannel,
    controlMessage: preserveControlMessage,
  };
}

function buildMoreMenuPayload(queue: GuildQueue<PlaybackMetadata>) {
  const currentTrack = queue.currentTrack;

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("Controls")
        .addFields(
          { name: "Volume", value: `${getQueueVolume(queue)}%`, inline: true },
          {
            name: "Autoplay",
            value: isAutoplayEnabled(queue) ? "On" : "Off",
            inline: true,
          },
          { name: "Effects", value: getEffectLabel(queue), inline: true },
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        createControlButton(
          `${PANEL_PREFIX}:lyrics:open`,
          "Lyrics",
          EMOJI_LYRICS,
          !currentTrack,
        ),
        createControlButton(
          `${PANEL_PREFIX}:effects:open`,
          "Effects",
          EMOJI_EFFECTS,
          !currentTrack,
        ),
        createControlButton(
          `${PANEL_PREFIX}:favorites:open:0:0`,
          "Favorites",
          EMOJI_FAVORITES,
        ),
        createControlButton(`${PANEL_PREFIX}:close`, "Close", EMOJI_CLOSE),
      ),
    ],
  };
}

function buildEffectsPanelPayload(queue: GuildQueue<PlaybackMetadata>) {
  const activeEffect = getActiveEffect(queue);

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("Audio Effects")
        .addFields(
          {
            name: "Current",
            value: activeEffect ? EFFECT_FILTERS[activeEffect].label : "Off",
            inline: true,
          },
          {
            name: "Track",
            value: queue.currentTrack
              ? truncate(queue.currentTrack.title, 48)
              : "Nothing",
            inline: true,
          },
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        createControlButton(`${PANEL_PREFIX}:menu`, "Back", EMOJI_MORE),
        createControlButton(
          `${PANEL_PREFIX}:effects:apply:bassboost`,
          "Bass",
          EMOJI_BASS,
          !queue.currentTrack,
        ),
        createControlButton(
          `${PANEL_PREFIX}:effects:apply:nightcore`,
          "Nightcore",
          EMOJI_NIGHTCORE,
          !queue.currentTrack,
        ),
        createControlButton(
          `${PANEL_PREFIX}:effects:apply:8D`,
          "8D",
          EMOJI_8D,
          !queue.currentTrack,
        ),
        createControlButton(
          `${PANEL_PREFIX}:effects:apply:clear`,
          "Clear",
          EMOJI_CLEAR,
          !queue.currentTrack,
        ),
      ),
    ],
  };
}

function buildLyricsPanelPayload(
  queue: GuildQueue<PlaybackMetadata>,
  lyrics: LyricsView,
  page: number,
) {
  const safePage = clamp(page, 0, Math.max(lyrics.pages.length - 1, 0));

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("Lyrics")
        .setDescription(lyrics.pages[safePage] ?? "Lyrics not found.")
        .addFields(
          {
            name: "Track",
            value: queue.currentTrack
              ? truncate(queue.currentTrack.title, 64)
              : "Nothing",
            inline: false,
          },
          {
            name: "Mode",
            value: lyrics.source === "synced" ? "Synced" : "Plain",
            inline: true,
          },
          {
            name: "Current line",
            value: lyrics.currentLine ?? "Unavailable",
            inline: true,
          },
        )
        .setFooter({ text: `Page ${safePage + 1}/${lyrics.pages.length}` }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        createIconButton(
          `${PANEL_PREFIX}:lyrics:page:-1:${safePage}`,
          ICON_PAGE_PREV,
          safePage === 0,
        ),
        createIconButton(
          `${PANEL_PREFIX}:lyrics:page:1:${safePage}`,
          ICON_PAGE_NEXT,
          safePage >= lyrics.pages.length - 1,
        ),
        createControlButton(`${PANEL_PREFIX}:menu`, "Back", EMOJI_MORE),
      ),
    ],
  };
}

function buildFavoritesPanelPayload(
  queue: GuildQueue<PlaybackMetadata>,
  favorites: FavoriteEntry[],
  page: number,
  selectedIndex: number,
) {
  const state = normalizeSelection(
    favorites.length,
    page,
    selectedIndex,
    PAGE_SIZE,
  );
  const totalPages = Math.max(
    1,
    Math.ceil(Math.max(favorites.length, 1) / PAGE_SIZE),
  );
  const pageStart = state.page * PAGE_SIZE;
  const pageFavorites = favorites.slice(pageStart, pageStart + PAGE_SIZE);
  const selectedFavorite =
    state.selectedIndex >= 0 ? favorites[state.selectedIndex] : null;

  const list =
    pageFavorites.length > 0
      ? pageFavorites
          .map((entry, index) => {
            const absoluteIndex = pageStart + index;
            const marker = absoluteIndex === state.selectedIndex ? ">" : " ";
            return `${marker} ${absoluteIndex + 1}. **${truncate(entry.title, 48)}**\n   ${truncate(entry.author, 28)} - ${entry.duration}`;
          })
          .join("\n")
      : "No saved favorites yet.";

  const components: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  > = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      createIconButton(
        `${PANEL_PREFIX}:favorites:page:-1:${state.page}:${state.selectedIndex}`,
        ICON_PAGE_PREV,
        state.page === 0 || favorites.length === 0,
      ),
      createIconButton(
        `${PANEL_PREFIX}:favorites:page:1:${state.page}:${state.selectedIndex}`,
        ICON_PAGE_NEXT,
        state.page >= totalPages - 1 || favorites.length === 0,
      ),
      createControlButton(
        `${PANEL_PREFIX}:favorites:save:${state.page}:${state.selectedIndex}`,
        "Save Current",
        EMOJI_FAVORITES,
        !queue.currentTrack,
      ),
      createControlButton(
        `${PANEL_PREFIX}:favorites:queue:${state.page}:${state.selectedIndex}`,
        "Queue Selected",
        EMOJI_QUEUE,
        state.selectedIndex < 0,
      ),
      createControlButton(
        `${PANEL_PREFIX}:favorites:remove:${state.page}:${state.selectedIndex}`,
        "Remove",
        EMOJI_REMOVE,
        state.selectedIndex < 0,
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      createControlButton(`${PANEL_PREFIX}:menu`, "Back", EMOJI_MORE),
    ),
  ];

  if (pageFavorites.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            `${PANEL_PREFIX}:favorites:select:${state.page}:${state.selectedIndex}`,
          )
          .setPlaceholder("Select a favorite")
          .addOptions(
            pageFavorites.map((entry, index) => {
              const absoluteIndex = pageStart + index;
              return {
                label: `${absoluteIndex + 1}. ${truncate(entry.title, 90)}`,
                description: truncate(
                  `${entry.author} - ${entry.duration}`,
                  100,
                ),
                value: String(absoluteIndex),
                default: absoluteIndex === state.selectedIndex,
              };
            }),
          ),
      ),
    );
  }

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("Favorites")
        .setDescription(list)
        .addFields(
          {
            name: "Selected",
            value: selectedFavorite
              ? `**${truncate(selectedFavorite.title, 48)}**\n${truncate(selectedFavorite.author, 32)} - ${selectedFavorite.duration}`
              : "No favorite selected.",
            inline: false,
          },
          {
            name: "Now playing",
            value: queue.currentTrack
              ? truncate(queue.currentTrack.title, 56)
              : "Nothing",
            inline: false,
          },
        )
        .setFooter({
          text: `Page ${state.page + 1}/${totalPages} - ${favorites.length} saved`,
        }),
    ],
    components,
  };
}

function cycleRepeatMode(mode: number) {
  return mode === QueueRepeatMode.TRACK
    ? QueueRepeatMode.QUEUE
    : QueueRepeatMode.TRACK;
}

function resetTrackPlaybackState(track: Track | null) {
  if (!track) return;

  track.setResource(null);
  track.bridgedTrack?.setResource(null);
}

function parseIntToken(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clampVolume(value: number) {
  return clamp(value, 0, 200);
}

async function ensureSharedVoiceChannel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  player: Player,
) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "This control only works inside a server.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const queue = player.nodes.get(interaction.guildId);
  if (!queue) {
    await interaction.reply({
      content: "There is no active playback right now.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const member = interaction.member as GuildMember;
  const userVoiceChannel = member.voice.channel;
  if (
    !userVoiceChannel ||
    !queue.channel ||
    userVoiceChannel.id !== queue.channel.id
  ) {
    await interaction.reply({
      content: "Join the same voice channel as the bot to use these controls.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  return queue;
}

async function seekBy(queue: GuildQueue, deltaMs: number) {
  const track = queue.currentTrack;
  if (!canSeek(track) || !track) {
    throw new Error("This track cannot be seeked.");
  }

  const targetVolume = clampVolume(getQueueVolume(queue));
  const nextPosition = clamp(
    queue.node.estimatedPlaybackTime + deltaMs,
    0,
    track.durationMS,
  );
  if (targetVolume > 0) {
    await fadeQueueVolume(queue, targetVolume, 0, SEEK_FADE_OUT_MS);
  }

  const ok = await queue.node.seek(nextPosition);
  if (!ok) {
    if (targetVolume > 0) {
      await fadeQueueVolume(queue, 0, targetVolume, SEEK_FADE_IN_MS);
    }
    throw new Error("Could not seek this track.");
  }

  await delay(40);
  if (targetVolume > 0) {
    await fadeQueueVolume(queue, 0, targetVolume, SEEK_FADE_IN_MS);
  }
}

function changeVolumeBy(queue: GuildQueue, delta: number) {
  const nextVolume = clampVolume(getQueueVolume(queue) + delta);
  const ok = queue.node.setVolume(nextVolume);
  if (!ok) {
    throw new Error("Could not update the volume.");
  }
}

async function setEffect(queue: GuildQueue, effect: EffectKey | "clear") {
  if (effect === "clear") {
    await queue.filters.ffmpeg.setFilters(false);
    return;
  }

  await queue.filters.ffmpeg.setFilters([EFFECT_FILTERS[effect].filter]);
}

async function fadeQueueVolume(
  queue: GuildQueue,
  from: number,
  to: number,
  durationMs: number,
) {
  const guildId = queue.guild.id;
  const steps = Math.max(1, FADE_STEPS);
  const stepDelay = Math.max(10, Math.floor(durationMs / steps));

  fadingQueues.add(guildId);
  try {
    queue.node.setVolume(clampVolume(from));
    for (let step = 1; step <= steps; step += 1) {
      const nextVolume = clampVolume(
        Math.round(from + ((to - from) * step) / steps),
      );
      queue.node.setVolume(nextVolume);
      await delay(stepDelay);
    }
  } finally {
    fadingQueues.delete(guildId);
  }
}

async function fetchLyricsView(
  player: Player,
  queue: GuildQueue<PlaybackMetadata>,
): Promise<LyricsView> {
  const track = queue.currentTrack;
  if (!track) {
    throw new Error("Nothing is currently playing.");
  }

  const cached = lyricsCache.get(track.url);
  if (cached) {
    return cached;
  }

  let results: LrcSearchResult[] = [];

  try {
    results = await player.lyrics.search({
      trackName: track.cleanTitle || track.title,
      artistName: track.author || undefined,
    });
  } catch {
    results = [];
  }

  if (results.length === 0) {
    try {
      results = await player.lyrics.search({
        q: `${track.title} ${track.author || ""}`.trim(),
      });
    } catch {
      results = [];
    }
  }

  const found = results[0];
  if (!found) {
    const fallback = {
      pages: ["Lyrics not found."],
      currentLine: null,
      source: "plain" as const,
    };
    lyricsCache.set(track.url, fallback);
    return fallback;
  }

  if (found.syncedLyrics) {
    const provider = queue.syncedLyrics(found);
    if (provider.lyrics.size === 0) {
      provider.load(found.syncedLyrics);
    }

    const currentLine =
      provider.at(queue.node.estimatedPlaybackTime)?.line ?? null;
    const lines = Array.from(provider.lyrics.entries()).map(
      ([timestamp, line]) => `${formatTimestamp(timestamp)} ${line}`,
    );
    const syncedView = {
      pages: chunkLines(lines, LYRICS_PAGE_SIZE),
      currentLine,
      source: "synced" as const,
    };

    lyricsCache.set(track.url, syncedView);
    return syncedView;
  }

  const plainView = {
    pages: chunkLines(found.plainLyrics.split(/\r?\n/), LYRICS_PAGE_SIZE),
    currentLine: null,
    source: "plain" as const,
  };

  lyricsCache.set(track.url, plainView);
  return plainView;
}

async function enqueueFavorite(
  player: Player,
  queue: GuildQueue<PlaybackMetadata>,
  favorite: FavoriteEntry,
  requestedBy: User,
) {
  const result = await player.search(favorite.url, {
    requestedBy,
    searchEngine: QueryType.AUTO_SEARCH,
  });

  const track = result.tracks[0];
  if (!track) {
    throw new Error("Could not load that saved track.");
  }

  if (queue.currentTrack || queue.isPlaying()) {
    queue.addTrack(track);
  } else {
    await queue.node.play(track);
  }

  return track;
}

async function handleLyricsOpen(
  interaction: ButtonInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  await interaction.deferUpdate();
  const lyrics = await fetchLyricsView(
    player,
    queue as GuildQueue<PlaybackMetadata>,
  );
  await interaction.editReply(
    buildLyricsPanelPayload(queue as GuildQueue<PlaybackMetadata>, lyrics, 0),
  );
  return true;
}

async function handleLyricsButtonAction(
  interaction: ButtonInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  const parts = interaction.customId.split(":");
  const panel = parts[1];
  const action = parts[2];
  const arg = parts[3];
  const pageToken = parts[4];
  if (panel !== "lyrics") return false;

  const currentPage = parseIntToken(pageToken, 0);
  const lyrics = await fetchLyricsView(
    player,
    queue as GuildQueue<PlaybackMetadata>,
  );

  if (action === "page") {
    const nextPage = clamp(
      currentPage + parseIntToken(arg, 0),
      0,
      lyrics.pages.length - 1,
    );
    await interaction.update(
      buildLyricsPanelPayload(
        queue as GuildQueue<PlaybackMetadata>,
        lyrics,
        nextPage,
      ),
    );
    return true;
  }

  return false;
}

async function handleEffectsOpen(
  interaction: ButtonInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  await interaction.update(
    buildEffectsPanelPayload(queue as GuildQueue<PlaybackMetadata>),
  );
  return true;
}

async function handleEffectsButtonAction(
  interaction: ButtonInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  const parts = interaction.customId.split(":");
  const panel = parts[1];
  const action = parts[2];
  const effect = parts[3];
  if (panel !== "effects" || action !== "apply") return false;

  await interaction.deferUpdate().catch(() => null);

  try {
    await setEffect(
      queue as GuildQueue<PlaybackMetadata>,
      effect as EffectKey | "clear",
    );
    await interaction
      .editReply(
        buildEffectsPanelPayload(queue as GuildQueue<PlaybackMetadata>),
      )
      .catch(() => null);
    await syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      false,
      "effectsApply",
    );
  } catch (error) {
    console.error("[effects-panel]", error);
    await interaction
      .followUp({
        content:
          error instanceof Error
            ? error.message
            : "Could not apply the audio effect.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => null);
  }

  return true;
}

async function handleFavoritesOpen(
  interaction: ButtonInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  const parts = interaction.customId.split(":");
  const pageToken = parts[4];
  const selectedToken = parts[5];
  const page = parseIntToken(pageToken, 0);
  const selectedIndex = parseIntToken(selectedToken, 0);
  const favorites = await listFavorites(interaction.user.id);

  await interaction.deferUpdate();
  await interaction.editReply(
    buildFavoritesPanelPayload(
      queue as GuildQueue<PlaybackMetadata>,
      favorites,
      page,
      selectedIndex,
    ),
  );
  return true;
}

async function handleFavoritesButtonAction(
  interaction: ButtonInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  const parts = interaction.customId.split(":");
  const panel = parts[1];
  const action = parts[2];
  const arg = parts[3];
  const pageToken = parts[4];
  const selectedToken = parts[5];
  if (panel !== "favorites") return false;

  const page = parseIntToken(pageToken, 0);
  const selectedIndex = parseIntToken(selectedToken, 0);

  if (action === "page") {
    const favorites = await listFavorites(interaction.user.id);
    const nextPage = clamp(
      page + parseIntToken(arg, 0),
      0,
      Math.max(0, Math.ceil(Math.max(favorites.length, 1) / PAGE_SIZE) - 1),
    );
    const nextSelected =
      favorites.length === 0
        ? -1
        : Math.min(selectedIndex, favorites.length - 1);
    await interaction.update(
      buildFavoritesPanelPayload(
        queue as GuildQueue<PlaybackMetadata>,
        favorites,
        nextPage,
        nextSelected,
      ),
    );
    return true;
  }

  if (action === "save") {
    await interaction.deferUpdate();
    if (!queue.currentTrack) {
      throw new Error("Nothing is currently playing to save.");
    }

    const favorites = await saveFavorite(
      interaction.user.id,
      queue.currentTrack,
    );
    await interaction.editReply(
      buildFavoritesPanelPayload(
        queue as GuildQueue<PlaybackMetadata>,
        favorites,
        0,
        0,
      ),
    );
    await interaction
      .followUp({
        content: `Saved **${queue.currentTrack.title}** to your favorites.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => null);
    return true;
  }

  if (action === "queue") {
    await interaction.deferUpdate();
    const favorites = await listFavorites(interaction.user.id);
    const favorite = favorites[selectedIndex];
    if (!favorite) {
      throw new Error("Select a favorite first.");
    }

    const track = await enqueueFavorite(
      player,
      queue as GuildQueue<PlaybackMetadata>,
      favorite,
      interaction.user,
    );
    const refreshedFavorites = await listFavorites(interaction.user.id);
    await interaction.editReply(
      buildFavoritesPanelPayload(
        queue as GuildQueue<PlaybackMetadata>,
        refreshedFavorites,
        page,
        selectedIndex,
      ),
    );
    await interaction
      .followUp({
        content: `Queued **${track.title}** from favorites.`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => null);
    await syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      false,
      "favoritesQueue",
    );
    return true;
  }

  if (action === "remove") {
    await interaction.deferUpdate();
    const favorites = await listFavorites(interaction.user.id);
    const favorite = favorites[selectedIndex];
    if (!favorite) {
      throw new Error("Select a favorite first.");
    }

    const refreshedFavorites = await removeFavorite(
      interaction.user.id,
      favorite.url,
    );
    const nextSelectedIndex =
      refreshedFavorites.length === 0
        ? -1
        : Math.min(selectedIndex, refreshedFavorites.length - 1);
    const nextPage =
      nextSelectedIndex < 0 ? 0 : Math.floor(nextSelectedIndex / PAGE_SIZE);
    await interaction.editReply(
      buildFavoritesPanelPayload(
        queue as GuildQueue<PlaybackMetadata>,
        refreshedFavorites,
        nextPage,
        nextSelectedIndex,
      ),
    );
    return true;
  }

  return false;
}

async function handleFavoritesSelect(
  interaction: StringSelectMenuInteraction,
  player: Player,
) {
  const queue = await ensureSharedVoiceChannel(interaction, player);
  if (!queue) return true;

  const selectedIndex = Number.parseInt(interaction.values[0] ?? "-1", 10);
  const nextPage =
    selectedIndex < 0 ? 0 : Math.floor(selectedIndex / PAGE_SIZE);
  const favorites = await listFavorites(interaction.user.id);

  await interaction.update(
    buildFavoritesPanelPayload(
      queue as GuildQueue<PlaybackMetadata>,
      favorites,
      nextPage,
      selectedIndex,
    ),
  );
  return true;
}

export async function playTrack({
  player,
  member,
  query,
  textChannel,
  requestedBy,
}: PlayTrackInput): Promise<PlayTrackResult> {
  const voiceChannel = getVoiceChannel(member);

  if (!voiceChannel) {
    throw new Error("USER_NOT_IN_VOICE_CHANNEL");
  }

  const existingQueue = player.nodes.get(voiceChannel.guild);
  if (existingQueue?.channel && existingQueue.channel.id !== voiceChannel.id) {
    throw new Error(BOT_BUSY_ERROR);
  }

  const metadata = buildMetadata(textChannel, existingQueue);
  const wasPlaying = Boolean(existingQueue?.isPlaying());
  const normalizedQuery = isUrl(query) ? query : `ytsearch:${query}`;
  const searchEngine = normalizedQuery.startsWith("ytsearch:")
    ? getYouTubeSearchEngine()
    : QueryType.AUTO_SEARCH;
  const disableFallbackStream = isYouTubeQuery(normalizedQuery);

  startPlaybackTrace({
    guildId: voiceChannel.guild.id,
    query,
    requestedBy: requestedBy.id,
    wasPlaying,
    searchEngine: String(searchEngine),
  });
  logPlaybackPhase(voiceChannel.guild.id, "player_play_start", {
    normalizedQuery,
    disableFallbackStream,
  });

  const result = await player.play(voiceChannel, normalizedQuery, {
    requestedBy,
    searchEngine,
    nodeOptions: {
      metadata,
      selfDeaf: true,
      leaveOnEmpty: true,
      leaveOnEmptyCooldown: 300_000,
      leaveOnEnd: true,
      leaveOnEndCooldown: 120_000,
      leaveOnStop: true,
      volume: 100,
      maxHistorySize: 30,
      disableFallbackStream,
    },
  });

  result.queue.setMetadata(metadata);
  logPlaybackPhase(voiceChannel.guild.id, "player_play_complete", {
    trackTitle: result.track.title,
    playlistTitle: result.searchResult.playlist?.title ?? null,
    queueSize: result.queue.size,
  });

  if (wasPlaying) {
    await syncControlPanel(
      result.queue as GuildQueue<PlaybackMetadata>,
      true,
      "playTrack:queue_update",
    );
  }

  return {
    track: result.track,
    playlistTitle: result.searchResult.playlist?.title ?? null,
    wasPlaying,
  };
}

export function attachPlayerEvents(player: Player) {
  player.events.on("playerStart", (queue) => {
    lyricsCache.delete(queue.currentTrack?.url ?? "");
    markPlayerStart(queue, queue.currentTrack);
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "playerStart",
    );
  });

  player.events.on("playerFinish", (queue, track) => {
    resetTrackPlaybackState(track);
    logQueuePlaybackPhase(queue, "player_finish", {
      trackTitle: track.title,
      repeatMode: queue.repeatMode,
      queueSize: queue.size,
      historySize: queue.history.size,
    });
  });

  player.events.on("audioTrackAdd", (queue) => {
    logQueuePlaybackPhase(queue, "audio_track_add", {
      trackTitle: queue.tracks.at(-1)?.title ?? null,
      queueSize: queue.size,
    });
    if (!queue.currentTrack && !queue.isPlaying()) {
      return;
    }
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "audioTrackAdd",
    );
  });

  player.events.on("audioTracksAdd", (queue) => {
    logQueuePlaybackPhase(queue, "audio_tracks_add", {
      queueSize: queue.size,
    });
    if (!queue.currentTrack && !queue.isPlaying()) {
      return;
    }
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "audioTracksAdd",
    );
  });

  player.events.on("playerPause", (queue) => {
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "playerPause",
    );
  });

  player.events.on("playerResume", (queue) => {
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "playerResume",
    );
  });

  player.events.on("volumeChange", (queue) => {
    if (fadingQueues.has(queue.guild.id)) {
      return;
    }
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "volumeChange",
    );
  });

  player.events.on("audioFiltersUpdate", (queue) => {
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      true,
      "audioFiltersUpdate",
    );
  });

  player.events.on("emptyQueue", (queue) => {
    logQueuePlaybackPhase(queue, "empty_queue");
    void showQueueEndedPanel(queue as GuildQueue<PlaybackMetadata>);
  });

  player.events.on("disconnect", (queue) => {
    logQueuePlaybackPhase(queue, "disconnect");
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      false,
      "disconnect",
    );
  });

  player.events.on("queueDelete", (queue) => {
    logQueuePlaybackPhase(queue, "queue_delete");
    void syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      false,
      "queueDelete",
    );
  });

  player.events.on("error", (queue, error) => {
    console.error(`[queue:${queue.guild.id}]`, error);
    logQueuePlaybackPhase(queue, "queue_error", {
      error: error.message,
    });
  });

  player.events.on("playerError", async (queue, error, track) => {
    console.error(`[track:${track.title}]`, error);
    logQueuePlaybackPhase(queue, "player_error", {
      trackTitle: track.title,
      extractorId:
        track.bridgedExtractor?.identifier ??
        track.extractor?.identifier ??
        null,
      error: error.message,
    });

    const metadata = getPlaybackMetadata(queue.metadata);
    if (!metadata) return;

    await metadata.textChannel
      .send({
        content: `Failed to play **${track.title}**.`,
      })
      .catch(() => null);

    await syncControlPanel(
      queue as GuildQueue<PlaybackMetadata>,
      false,
      "playerError",
    ).catch(() => null);
  });
}

export async function handlePlaybackInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  player: Player,
) {
  if (interaction.isButton()) {
    if (interaction.customId === `${PANEL_PREFIX}:close`) {
      await interaction.deferUpdate().catch(() => null);
      await interaction.deleteReply().catch(() => null);
      return true;
    }

    if (interaction.customId === `${PANEL_PREFIX}:menu`) {
      const queue = await ensureSharedVoiceChannel(interaction, player);
      if (!queue) return true;

      await interaction.update(
        buildMoreMenuPayload(queue as GuildQueue<PlaybackMetadata>),
      );
      return true;
    }

    if (interaction.customId === `${PANEL_PREFIX}:lyrics:open`) {
      return handleLyricsOpen(interaction, player);
    }

    if (interaction.customId.startsWith(`${PANEL_PREFIX}:lyrics:`)) {
      return handleLyricsButtonAction(interaction, player);
    }

    if (interaction.customId === `${PANEL_PREFIX}:effects:open`) {
      return handleEffectsOpen(interaction, player);
    }

    if (interaction.customId.startsWith(`${PANEL_PREFIX}:effects:`)) {
      return handleEffectsButtonAction(interaction, player);
    }

    if (interaction.customId.startsWith(`${PANEL_PREFIX}:favorites:open`)) {
      return handleFavoritesOpen(interaction, player);
    }

    if (interaction.customId.startsWith(`${PANEL_PREFIX}:favorites:`)) {
      return handleFavoritesButtonAction(interaction, player);
    }

    if (!interaction.customId.startsWith(`${CONTROL_PREFIX}:`)) {
      return false;
    }

    const queue = await ensureSharedVoiceChannel(interaction, player);
    if (!queue) return true;

    const action = interaction.customId.slice(`${CONTROL_PREFIX}:`.length);

    if (action === "more") {
      await interaction.reply({
        ...buildMoreMenuPayload(queue as GuildQueue<PlaybackMetadata>),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.deferUpdate();

    try {
      if (action === "toggle") {
        if (!queue.currentTrack) {
          throw new Error("Nothing is currently playing.");
        }

        if (isQueuePaused(queue)) {
          queue.node.resume();
        } else {
          queue.node.pause();
        }
      } else if (action === "previous") {
        if (queue.history.disabled || queue.history.isEmpty()) {
          throw new Error("There is no previous track in history.");
        }

        await queue.history.previous(true);
      } else if (action === "next") {
        if (getQueueTracks(queue).length === 0) {
          throw new Error("There is no next track in the queue.");
        }

        const skipped = queue.node.skip();
        if (!skipped) {
          throw new Error("Could not skip to the next track.");
        }
      } else if (action === "volume_down") {
        changeVolumeBy(queue, -VOLUME_STEP);
      } else if (action === "volume_up") {
        changeVolumeBy(queue, VOLUME_STEP);
      } else if (action === "stop") {
        queue.node.stop(true);
      } else if (action === "loop") {
        queue.setRepeatMode(cycleRepeatMode(queue.repeatMode));
      } else if (action === "autoplay") {
        queue.setRepeatMode(
          isAutoplayEnabled(queue)
            ? QueueRepeatMode.OFF
            : QueueRepeatMode.AUTOPLAY,
        );
      } else {
        return false;
      }

      await syncControlPanel(
        queue as GuildQueue<PlaybackMetadata>,
        false,
        `control:${action}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not update the player.";
      await interaction
        .followUp({ content: message, flags: MessageFlags.Ephemeral })
        .catch(() => null);
    }

    return true;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith(`${PANEL_PREFIX}:favorites:`)) {
      return handleFavoritesSelect(interaction, player);
    }
  }

  return false;
}

export function getPlaybackErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "USER_NOT_IN_VOICE_CHANNEL") {
    return "Join a voice channel first.";
  }

  if (message === BOT_BUSY_ERROR) {
    return "The bot is already being used in another voice channel on this server.";
  }

  if (message.includes("No results found")) {
    return "No results found for that query.";
  }

  if (
    message.includes("Could not bridge this track") ||
    message.includes("Could not extract stream")
  ) {
    return "Track found, but the audio stream could not be created.";
  }

  if (message.includes("VOICE_CONNECT_FAILED")) {
    return "Could not connect to the voice channel.";
  }

  return "Could not play the track. Check that the bot has permission to connect and speak.";
}
