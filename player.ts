import { AppleMusicExtractor, SoundCloudExtractor, SpotifyExtractor } from '@discord-player/extractor';
import { Player, type Track } from 'discord-player';
import type { Client } from 'discord.js';
import fs from 'node:fs';
import { YoutubeSabrExtractor } from 'discord-player-googlevideo';
import { YoutubeiExtractor } from 'discord-player-youtubei';
import youtubedl from 'youtube-dl-exec';

function createYoutubeDlStream(url: string, cookie?: string) {
    const process = youtubedl.exec(url, {
        format: 'bestaudio',
        output: '-',
        noWarnings: true,
        noProgress: true,
        jsRuntimes: 'node',
        cookies: cookie,
    });

    process.catch((error) => {
        console.error('[youtube-dl]', error);
    });

    const stream = process.stdout;
    if (!stream) {
        throw new Error('youtube-dl did not return a readable stream.');
    }

    const cleanup = () => {
        if (!process.killed) {
            process.kill();
        }
    };

    stream.once('close', cleanup);
    stream.once('end', cleanup);
    stream.once('error', cleanup);

    return stream;
}

export async function createPlayer(client: Client) {
    const player = new Player(client);
    const youtubeExtractor = (process.env.YOUTUBE_EXTRACTOR ?? 'youtubei').toLowerCase();
    const youtubeiUseDl = (process.env.YOUTUBE_USE_YTDL ?? 'true').toLowerCase() === 'true';
    const youtubeDlPath = (youtubedl as any).constants?.YOUTUBE_DL_PATH as string | undefined;
    const hasYoutubeDlBinary = Boolean(youtubeDlPath && fs.existsSync(youtubeDlPath));

    if (youtubeExtractor === 'googlevideo') {
        await player.extractors.register(YoutubeSabrExtractor, {});
    } else {
        const youtubeiOptions: Record<string, unknown> = {
            cookie: process.env.YOUTUBE_COOKIE,
            generateWithPoToken: process.env.YOUTUBE_GENERATE_PO_TOKEN === 'true',
            disablePlayer: true,
            overrideBridgeMode: 'yt',
            streamOptions: {
                useClient: 'ANDROID',
                highWaterMark: 1 << 25,
            },
            logLevel: 'NONE',
        };

        if (youtubeiUseDl && hasYoutubeDlBinary) {
            youtubeiOptions.createStream = (track: Track) =>
                Promise.resolve(createYoutubeDlStream(track.url, process.env.YOUTUBE_COOKIE));
        } else if (youtubeiUseDl) {
            console.warn('[audio] yt-dlp binary not found, falling back to native youtubei streaming');
        }

        await player.extractors.register(YoutubeiExtractor, youtubeiOptions as any);
    }

    await player.extractors.register(SoundCloudExtractor, {});
    await player.extractors.register(AppleMusicExtractor, {});

    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
        await player.extractors.register(SpotifyExtractor, {
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        });
    }

    return player;
}
