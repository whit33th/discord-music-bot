import type { ExtractorStreamable, GuildQueue, Track } from 'discord-player';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

type PlaybackTrace = {
    id: string;
    guildId: string;
    query: string;
    requestedBy: string;
    startedAt: number;
    coldStart: boolean;
    wasPlaying: boolean;
    searchEngine: string;
};

const execFileAsync = promisify(execFile);
const tracesByGuild = new Map<string, PlaybackTrace>();
const lastPlayerStartAt = new Map<string, number>();
const FFMPEG_SAMPLE_TTL_MS = 1_000;

let traceCounter = 0;
let lastFfmpegSampleAt = 0;
let lastFfmpegSample: number | null = null;

function createTraceId() {
    traceCounter += 1;
    return `${Date.now().toString(36)}-${traceCounter.toString(36)}`;
}

async function countFfmpegChildren() {
    if (process.platform === 'win32') {
        return null;
    }

    if ((Date.now() - lastFfmpegSampleAt) < FFMPEG_SAMPLE_TTL_MS) {
        return lastFfmpegSample;
    }

    try {
        const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '--ppid', String(process.pid)]);
        lastFfmpegSample = stdout
            .split(/\r?\n/)
            .map((line) => line.trim().toLowerCase())
            .filter(Boolean)
            .filter((line) => line === 'ffmpeg' || line.endsWith('/ffmpeg'))
            .length;
        lastFfmpegSampleAt = Date.now();
        return lastFfmpegSample;
    } catch {
        return null;
    }
}

function getTrace(guildId: string) {
    return tracesByGuild.get(guildId) ?? null;
}

function getExtractorId(track: Track | null | undefined) {
    return track?.bridgedExtractor?.identifier ?? track?.extractor?.identifier ?? null;
}

function describeStreamSource(stream: Readable | ExtractorStreamable | string) {
    if (typeof stream === 'string') {
        return 'string';
    }

    if (stream instanceof Readable) {
        return 'readable';
    }

    if (typeof stream === 'object' && stream !== null && '$fmt' in stream) {
        return `extractor:${String(stream.$fmt)}`;
    }

    return typeof stream;
}

async function emitTrace(trace: PlaybackTrace, event: string, details: Record<string, unknown> = {}) {
    const ffmpegChildren = await countFfmpegChildren();
    const payload = {
        event,
        traceId: trace.id,
        guildId: trace.guildId,
        msSinceStart: Date.now() - trace.startedAt,
        coldStart: trace.coldStart,
        wasPlaying: trace.wasPlaying,
        searchEngine: trace.searchEngine,
        ffmpegChildren,
        ...details,
    };

    console.log(`[perf][play:${trace.id}] ${JSON.stringify(payload)}`);
}

export function startPlaybackTrace({
    guildId,
    query,
    requestedBy,
    wasPlaying,
    searchEngine,
}: {
    guildId: string;
    query: string;
    requestedBy: string;
    wasPlaying: boolean;
    searchEngine: string;
}) {
    const trace: PlaybackTrace = {
        id: createTraceId(),
        guildId,
        query,
        requestedBy,
        startedAt: Date.now(),
        coldStart: !lastPlayerStartAt.has(guildId),
        wasPlaying,
        searchEngine,
    };

    tracesByGuild.set(guildId, trace);
    void emitTrace(trace, 'slash_received', {
        query,
        requestedBy,
    });

    return trace.id;
}

export function logPlaybackPhase(guildId: string, event: string, details: Record<string, unknown> = {}) {
    const trace = getTrace(guildId);
    if (!trace) return;
    void emitTrace(trace, event, details);
}

export function logQueuePlaybackPhase(queue: GuildQueue, event: string, details: Record<string, unknown> = {}) {
    logPlaybackPhase(queue.guild.id, event, details);
}

export function markPlayerStart(queue: GuildQueue, track: Track | null | undefined) {
    lastPlayerStartAt.set(queue.guild.id, Date.now());
    logQueuePlaybackPhase(queue, 'player_start', {
        trackTitle: track?.title ?? null,
        extractorId: getExtractorId(track),
        queueSize: queue.size,
    });
}

export function logStreamExtracted(
    queue: GuildQueue,
    track: Track,
    stream: Readable | ExtractorStreamable | string,
) {
    logQueuePlaybackPhase(queue, 'stream_extracted', {
        extractorId: getExtractorId(track),
        streamSource: describeStreamSource(stream),
        trackTitle: track.title,
    });

    return stream;
}
