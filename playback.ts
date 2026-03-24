import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    type ButtonInteraction,
    type GuildMember,
    type GuildTextBasedChannel,
    type Message,
    type StringSelectMenuInteraction,
    type User,
} from 'discord.js';
import { QueryType, QueueRepeatMode, type GuildQueue, type Player, type Track } from 'discord-player';

const BOT_BUSY_ERROR = 'BOT_BUSY_IN_ANOTHER_CHANNEL';
const CONTROL_PREFIX = 'musicctl';
const QUEUE_PREFIX = 'queuectl';
const EMBED_COLOR = 0x2c2c2e;
const PAGE_SIZE = 8;

const EMOJI_PREV = '\u23EE\uFE0F';
const EMOJI_PLAY = '\u25B6\uFE0F';
const EMOJI_PAUSE = '\u23F8\uFE0F';
const EMOJI_NEXT = '\u23ED\uFE0F';
const EMOJI_QUEUE = '\u{1F4CB}';
const EMOJI_LOOP_TRACK = '\u{1F502}';
const EMOJI_LOOP_QUEUE = '\u{1F501}';
const EMOJI_SHUFFLE = '\u{1F500}';

const ICON_QUEUE_MOVE_UP = '\u2191';
const ICON_QUEUE_MOVE_DOWN = '\u2193';
const ICON_QUEUE_REMOVE = '\u2212';
const ICON_PAGE_PREV = '\u2039';
const ICON_PAGE_NEXT = '\u203A';
const GOOGLEVIDEO_EXTRACTOR_ID = 'ext:com.github.xxczaki.youtube-sabr';
const YOUTUBEI_EXTRACTOR_ID = 'ext:com.retrouser955.discord-player.discord-player-youtubei';

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

function isPlaybackMetadata(value: unknown): value is PlaybackMetadata {
    return typeof value === 'object'
        && value !== null
        && 'textChannel' in value
        && 'controlMessage' in value;
}

function getPlaybackMetadata(value: unknown): PlaybackMetadata | null {
    return isPlaybackMetadata(value) ? value : null;
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
    return (process.env.YOUTUBE_EXTRACTOR ?? 'youtubei').toLowerCase() === 'googlevideo'
        ? GOOGLEVIDEO_EXTRACTOR_ID
        : YOUTUBEI_EXTRACTOR_ID;
}

function getQueueTracks(queue: GuildQueue) {
    return queue.tracks.toArray();
}

function getLoopButtonLabel(mode: number) {
    if (mode === QueueRepeatMode.TRACK) return 'Loop Track';
    if (mode === QueueRepeatMode.QUEUE) return 'Loop Queue';
    return 'Loop Off';
}

function getLoopEmoji(mode: number) {
    return mode === QueueRepeatMode.TRACK ? EMOJI_LOOP_TRACK : EMOJI_LOOP_QUEUE;
}

function getShuffleButtonLabel(enabled: boolean) {
    return enabled ? 'Shuffle On' : 'Shuffle Off';
}

function getRepeatLabel(mode: number) {
    if (mode === QueueRepeatMode.TRACK) return 'Track';
    if (mode === QueueRepeatMode.QUEUE) return 'Queue';
    if (mode === QueueRepeatMode.AUTOPLAY) return 'Autoplay';
    return 'Off';
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function normalizeQueueState(queue: GuildQueue, page: number, selectedIndex: number): QueueManagerState {
    const tracks = getQueueTracks(queue);

    if (tracks.length === 0) {
        return { page: 0, selectedIndex: -1 };
    }

    const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
    const safePage = clamp(page, 0, totalPages - 1);
    const pageStart = safePage * PAGE_SIZE;
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, tracks.length - 1);
    const initialSelectedIndex = selectedIndex < 0 ? pageStart : clamp(selectedIndex, 0, tracks.length - 1);
    const safeSelectedIndex = initialSelectedIndex < pageStart || initialSelectedIndex > pageEnd
        ? pageStart
        : initialSelectedIndex;

    return {
        page: safePage,
        selectedIndex: safeSelectedIndex,
    };
}

function createIconButton(customId: string, label: string, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
}

function createControlButton(customId: string, label: string, emoji: string, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setEmoji(emoji)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
}

function buildControls(queue: GuildQueue<PlaybackMetadata>) {
    const hasTrack = Boolean(queue.currentTrack);
    const queueTracks = getQueueTracks(queue);
    const hasEditableQueue = queueTracks.length > 0;

    return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            createControlButton(`${CONTROL_PREFIX}:prev`, 'Prev', EMOJI_PREV, !hasTrack || !queue.history.previousTrack),
            createControlButton(`${CONTROL_PREFIX}:toggle`, isQueuePaused(queue) ? 'Play' : 'Pause', isQueuePaused(queue) ? EMOJI_PLAY : EMOJI_PAUSE, !hasTrack),
            createControlButton(`${CONTROL_PREFIX}:next`, 'Next', EMOJI_NEXT, !hasTrack),
            createControlButton(`${CONTROL_PREFIX}:queue`, 'Queue', EMOJI_QUEUE, !hasTrack && !hasEditableQueue),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            createControlButton(`${CONTROL_PREFIX}:loop`, getLoopButtonLabel(queue.repeatMode), getLoopEmoji(queue.repeatMode), !hasTrack),
            createControlButton(`${CONTROL_PREFIX}:shuffle`, getShuffleButtonLabel(queue.isShuffling), EMOJI_SHUFFLE, !hasTrack || !hasEditableQueue),
        ),
    ];
}

function buildControlEmbed(queue: GuildQueue<PlaybackMetadata>) {
    const currentTrack = queue.currentTrack;

    if (!currentTrack) {
        return new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle('Playback Idle')
            .setDescription('Start another track with `/play`.')
            .addFields(
                { name: 'Queue', value: '0 waiting', inline: true },
                { name: 'Loop', value: getRepeatLabel(queue.repeatMode), inline: true },
                { name: 'Shuffle', value: queue.isShuffling ? 'On' : 'Off', inline: true },
            );
    }

    const nextTrack = queue.tracks.at(0);
    const requestedBy = currentTrack.requestedBy?.username ?? 'Unknown';
    const status = isQueuePaused(queue) ? 'Paused' : 'Playing';

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(truncate(currentTrack.title, 256))
        .setURL(currentTrack.url)
        .setDescription([
            `by **${truncate(currentTrack.author || 'Unknown Artist', 64)}**`,
            '',
            `Status: ${status}`,
            `Up next: ${nextTrack ? `**${truncate(nextTrack.title, 48)}**` : 'Nothing queued'}`,
        ].join('\n'))
        .addFields(
            { name: 'Duration', value: currentTrack.duration || 'Live', inline: true },
            { name: 'Queue', value: `${queue.size} waiting`, inline: true },
            { name: 'Mode', value: `${getRepeatLabel(queue.repeatMode)} - ${queue.isShuffling ? 'Shuffle On' : 'Shuffle Off'}`, inline: true },
        )
        .setFooter({ text: `Requested by ${requestedBy}` });

    if (currentTrack.thumbnail) {
        embed.setThumbnail(currentTrack.thumbnail);
    }

    return embed;
}

async function syncControlPanel(queue: GuildQueue<PlaybackMetadata>, sendIfMissing = true, bump = false) {
    const metadata = getPlaybackMetadata(queue.metadata);
    if (!metadata) return;

    const payload = {
        embeds: [buildControlEmbed(queue)],
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
            return;
        } catch {
            metadata.controlMessage = null;
        }
    }

    if (!sendIfMissing) {
        queue.setMetadata(metadata);
        return;
    }

    try {
        metadata.controlMessage = await metadata.textChannel.send(payload);
        queue.setMetadata(metadata);
    } catch (error) {
        console.error(`[control-panel:${queue.guild.id}]`, error);
        metadata.controlMessage = null;
        queue.setMetadata(metadata);
    }
}

function buildMetadata(textChannel: GuildTextBasedChannel, queue: GuildQueue | null): PlaybackMetadata {
    const currentMetadata = getPlaybackMetadata(queue?.metadata);
    const preserveControlMessage = currentMetadata?.textChannel.id === textChannel.id
        ? currentMetadata.controlMessage
        : null;

    return {
        textChannel,
        controlMessage: preserveControlMessage,
    };
}

function buildQueueManagerPayload(queue: GuildQueue<PlaybackMetadata>, page: number, selectedIndex: number) {
    const tracks = getQueueTracks(queue);
    const state = normalizeQueueState(queue, page, selectedIndex);
    const currentTrack = queue.currentTrack;
    const totalPages = Math.max(1, Math.ceil(Math.max(tracks.length, 1) / PAGE_SIZE));
    const pageStart = state.page * PAGE_SIZE;
    const pageTracks = tracks.slice(pageStart, pageStart + PAGE_SIZE);
    const selectedTrack = state.selectedIndex >= 0 ? tracks[state.selectedIndex] : null;

    const list = pageTracks.length > 0
        ? pageTracks.map((track, index) => {
            const absoluteIndex = pageStart + index;
            const marker = absoluteIndex === state.selectedIndex ? '>' : ' ';
            return `${marker} ${absoluteIndex + 1}. **${truncate(track.title, 48)}**\n   ${truncate(track.author || 'Unknown Artist', 28)} - ${track.duration || 'Live'}`;
        }).join('\n')
        : 'Queue is empty.';

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Queue')
        .setDescription([
            `Now playing: ${currentTrack ? `**${truncate(currentTrack.title, 56)}**` : 'Nothing'}`,
            '',
            list,
        ].join('\n'))
        .addFields(
            {
                name: 'Selected',
                value: selectedTrack
                    ? `**${truncate(selectedTrack.title, 48)}**\n${truncate(selectedTrack.author || 'Unknown Artist', 32)} - ${selectedTrack.duration || 'Live'}`
                    : 'No track selected.',
                inline: false,
            },
        )
        .setFooter({ text: `Page ${state.page + 1}/${totalPages} - ${tracks.length} queued` });

    const components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            createIconButton(`${QUEUE_PREFIX}:page:-1:${state.page}:${state.selectedIndex}`, ICON_PAGE_PREV, state.page === 0 || tracks.length === 0),
            createIconButton(`${QUEUE_PREFIX}:move:-1:${state.page}:${state.selectedIndex}`, ICON_QUEUE_MOVE_UP, state.selectedIndex <= 0),
            createIconButton(`${QUEUE_PREFIX}:remove:${state.page}:${state.selectedIndex}`, ICON_QUEUE_REMOVE, state.selectedIndex < 0),
            createIconButton(`${QUEUE_PREFIX}:move:1:${state.page}:${state.selectedIndex}`, ICON_QUEUE_MOVE_DOWN, state.selectedIndex < 0 || state.selectedIndex >= tracks.length - 1),
            createIconButton(`${QUEUE_PREFIX}:page:1:${state.page}:${state.selectedIndex}`, ICON_PAGE_NEXT, state.page >= totalPages - 1 || tracks.length === 0),
        ),
    ];

    if (pageTracks.length > 0) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`${QUEUE_PREFIX}:select:${state.page}:${state.selectedIndex}`)
            .setPlaceholder('Select a track')
            .addOptions(
                pageTracks.map((track, index) => {
                    const absoluteIndex = pageStart + index;
                    return {
                        label: `${absoluteIndex + 1}. ${truncate(track.title, 90)}`,
                        description: truncate(`${track.author || 'Unknown Artist'} - ${track.duration || 'Live'}`, 100),
                        value: String(absoluteIndex),
                        default: absoluteIndex === state.selectedIndex,
                    };
                }),
            );

        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }

    return {
        embeds: [embed],
        components,
    };
}

function cycleRepeatMode(mode: number) {
    if (mode === QueueRepeatMode.OFF) return QueueRepeatMode.TRACK;
    if (mode === QueueRepeatMode.TRACK) return QueueRepeatMode.QUEUE;
    return QueueRepeatMode.OFF;
}

async function playNextTrack(queue: GuildQueue) {
    const currentTrack = queue.currentTrack;
    const nextTrack = queue.tracks.dispatch();

    if (!nextTrack) {
        throw new Error('There is no next track to skip to.');
    }

    if (currentTrack) {
        queue.history.push(currentTrack);
    }

    await queue.node.play(nextTrack, { queue: false });
}

function parsePositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

async function ensureSharedVoiceChannel(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    player: Player,
) {
    if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: 'This control only works inside a server.', flags: MessageFlags.Ephemeral });
        return null;
    }

    const queue = player.nodes.get(interaction.guild);
    if (!queue) {
        await interaction.reply({ content: 'There is no active playback right now.', flags: MessageFlags.Ephemeral });
        return null;
    }

    const member = interaction.member as GuildMember;
    const userVoiceChannel = member.voice.channel;
    if (!userVoiceChannel || !queue.channel || userVoiceChannel.id !== queue.channel.id) {
        await interaction.reply({ content: 'Join the same voice channel as the bot to use these controls.', flags: MessageFlags.Ephemeral });
        return null;
    }

    return queue;
}

async function handleQueueOpen(interaction: ButtonInteraction, player: Player) {
    const queue = await ensureSharedVoiceChannel(interaction, player);
    if (!queue) return true;

    await interaction.reply({
        ...buildQueueManagerPayload(queue as GuildQueue<PlaybackMetadata>, 0, 0),
        flags: MessageFlags.Ephemeral,
    });

    return true;
}

async function handleQueueButtonAction(interaction: ButtonInteraction, player: Player) {
    const queue = await ensureSharedVoiceChannel(interaction, player);
    if (!queue) return true;

    const [, , action, arg, pageToken, selectedToken] = interaction.customId.split(':');
    const page = parsePositiveInt(pageToken, 0);
    const selectedIndex = parsePositiveInt(selectedToken, 0);

    try {
        if (action === 'page') {
            const delta = Number.parseInt(arg ?? '0', 10) || 0;
            const tracks = getQueueTracks(queue);
            const nextPage = clamp(page + delta, 0, Math.max(0, Math.ceil(Math.max(tracks.length, 1) / PAGE_SIZE) - 1));
            const fallbackSelected = tracks.length === 0 ? -1 : nextPage * PAGE_SIZE;

            await interaction.update(buildQueueManagerPayload(
                queue as GuildQueue<PlaybackMetadata>,
                nextPage,
                selectedIndex >= 0 ? selectedIndex : fallbackSelected,
            ));
            return true;
        }

        if (action === 'move') {
            const tracks = getQueueTracks(queue);
            const track = tracks[selectedIndex];
            if (!track) {
                await interaction.update(buildQueueManagerPayload(queue as GuildQueue<PlaybackMetadata>, page, selectedIndex));
                return true;
            }

            const delta = Number.parseInt(arg ?? '0', 10) || 0;
            const targetIndex = clamp(selectedIndex + delta, 0, tracks.length - 1);
            if (targetIndex !== selectedIndex) {
                queue.moveTrack(track, targetIndex);
            }

            await interaction.update(buildQueueManagerPayload(queue as GuildQueue<PlaybackMetadata>, Math.floor(targetIndex / PAGE_SIZE), targetIndex));
            void syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false);
            return true;
        }

        if (action === 'remove') {
            const tracks = getQueueTracks(queue);
            const track = tracks[selectedIndex];
            if (track) {
                queue.removeTrack(track);
            }

            const updatedTracks = getQueueTracks(queue);
            const nextSelectedIndex = updatedTracks.length === 0 ? -1 : Math.min(selectedIndex, updatedTracks.length - 1);
            const nextPage = nextSelectedIndex < 0 ? 0 : Math.floor(nextSelectedIndex / PAGE_SIZE);

            await interaction.update(buildQueueManagerPayload(queue as GuildQueue<PlaybackMetadata>, nextPage, nextSelectedIndex));
            void syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false);
            return true;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update the queue.';
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
        return true;
    }

    return false;
}

async function handleQueueSelect(interaction: StringSelectMenuInteraction, player: Player) {
    const queue = await ensureSharedVoiceChannel(interaction, player);
    if (!queue) return true;

    const selectedIndex = Number.parseInt(interaction.values[0] ?? '-1', 10);
    const nextPage = selectedIndex < 0 ? 0 : Math.floor(selectedIndex / PAGE_SIZE);

    await interaction.update(buildQueueManagerPayload(queue as GuildQueue<PlaybackMetadata>, nextPage, selectedIndex));
    return true;
}

export async function playTrack({ player, member, query, textChannel, requestedBy }: PlayTrackInput): Promise<PlayTrackResult> {
    const voiceChannel = getVoiceChannel(member);

    if (!voiceChannel) {
        throw new Error('USER_NOT_IN_VOICE_CHANNEL');
    }

    const existingQueue = player.nodes.get(voiceChannel.guild);
    if (existingQueue?.channel && existingQueue.channel.id !== voiceChannel.id) {
        throw new Error(BOT_BUSY_ERROR);
    }

    const metadata = buildMetadata(textChannel, existingQueue);
    const wasPlaying = Boolean(existingQueue?.isPlaying());
    const normalizedQuery = isUrl(query) ? query : `ytsearch:${query}`;
    const result = await player.play(voiceChannel, normalizedQuery, {
        requestedBy,
        searchEngine: normalizedQuery.startsWith('ytsearch:') ? getYouTubeSearchEngine() : QueryType.AUTO_SEARCH,
        nodeOptions: {
            metadata,
            selfDeaf: true,
            leaveOnEmpty: true,
            leaveOnEmptyCooldown: 300_000,
            leaveOnEnd: true,
            leaveOnEndCooldown: 60_000,
            leaveOnStop: true,
            volume: 80,
            maxHistorySize: 20,
        },
    });

    result.queue.setMetadata(metadata);
    await syncControlPanel(result.queue as GuildQueue<PlaybackMetadata>, true, true);

    return {
        track: result.track,
        playlistTitle: result.searchResult.playlist?.title ?? null,
        wasPlaying,
    };
}

export function attachPlayerEvents(player: Player) {
    player.events.on('playerStart', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>);
    });

    player.events.on('audioTrackAdd', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>);
    });

    player.events.on('audioTracksAdd', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>);
    });

    player.events.on('playerPause', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>);
    });

    player.events.on('playerResume', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>);
    });

    player.events.on('emptyQueue', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false);
    });

    player.events.on('disconnect', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false);
    });

    player.events.on('queueDelete', (queue) => {
        void syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false);
    });

    player.events.on('error', (queue, error) => {
        console.error(`[queue:${queue.guild.id}]`, error);
    });

    player.events.on('playerError', async (queue, error, track) => {
        console.error(`[track:${track.title}]`, error);

        const metadata = getPlaybackMetadata(queue.metadata);
        if (!metadata) return;

        await metadata.textChannel.send({
            content: `Failed to play **${track.title}**.`,
        }).catch(() => null);

        await syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false).catch(() => null);
    });
}

export async function handlePlaybackInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    player: Player,
) {
    if (interaction.isButton()) {
        if (interaction.customId === `${CONTROL_PREFIX}:queue`) {
            return handleQueueOpen(interaction, player);
        }

        if (interaction.customId.startsWith(`${QUEUE_PREFIX}:`)) {
            return handleQueueButtonAction(interaction, player);
        }

        if (!interaction.customId.startsWith(`${CONTROL_PREFIX}:`)) {
            return false;
        }

        const queue = await ensureSharedVoiceChannel(interaction, player);
        if (!queue) return true;

        const action = interaction.customId.slice(`${CONTROL_PREFIX}:`.length);
        await interaction.deferUpdate();

        try {
            if (action === 'toggle') {
                if (!queue.currentTrack) {
                    throw new Error('Nothing is currently playing.');
                }

                if (isQueuePaused(queue)) {
                    queue.node.resume();
                } else {
                    queue.node.pause();
                }
            } else if (action === 'next') {
                if (!queue.currentTrack) {
                    throw new Error('There is no next track to skip to.');
                }

                await playNextTrack(queue);
            } else if (action === 'prev') {
                if (!queue.history.previousTrack) {
                    throw new Error('There is no previous track in history.');
                }

                await queue.history.previous(true);
            } else if (action === 'loop') {
                queue.setRepeatMode(cycleRepeatMode(queue.repeatMode));
            } else if (action === 'shuffle') {
                if (getQueueTracks(queue).length === 0) {
                    throw new Error('There are no queued tracks to shuffle.');
                }

                queue.toggleShuffle();
            }

            await syncControlPanel(queue as GuildQueue<PlaybackMetadata>, false);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Could not update the player.';
            await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
        }

        return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${QUEUE_PREFIX}:`)) {
        return handleQueueSelect(interaction, player);
    }

    return false;
}

export function getPlaybackErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'USER_NOT_IN_VOICE_CHANNEL') {
        return 'Join a voice channel first.';
    }

    if (message === BOT_BUSY_ERROR) {
        return 'The bot is already being used in another voice channel on this server.';
    }

    if (message.includes('No results found')) {
        return 'No results found for that query.';
    }

    if (message.includes('Could not bridge this track') || message.includes('Could not extract stream')) {
        return 'Track found, but the audio stream could not be created.';
    }

    if (message.includes('VOICE_CONNECT_FAILED')) {
        return 'Could not connect to the voice channel.';
    }

    return 'Could not play the track. Check that the bot has permission to connect and speak.';
}
