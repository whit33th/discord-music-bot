import { AppleMusicExtractor, SoundCloudExtractor, SpotifyExtractor } from '@discord-player/extractor';
import { Player } from 'discord-player';
import type { Client } from 'discord.js';
import { YoutubeSabrExtractor } from 'discord-player-googlevideo';
import { YoutubeiExtractor } from 'discord-player-youtubei';

export async function createPlayer(client: Client) {
    const player = new Player(client);
    const youtubeExtractor = (process.env.YOUTUBE_EXTRACTOR ?? 'youtubei').toLowerCase();
    const youtubeiUseDl = (process.env.YOUTUBE_USE_YTDL ?? 'true').toLowerCase() === 'true';

    if (youtubeExtractor === 'googlevideo') {
        await player.extractors.register(YoutubeSabrExtractor, {});
    } else {
        await player.extractors.register(YoutubeiExtractor, {
            cookie: process.env.YOUTUBE_COOKIE,
            generateWithPoToken: process.env.YOUTUBE_GENERATE_PO_TOKEN === 'true',
            disablePlayer: true,
            overrideBridgeMode: 'yt',
            streamOptions: {
                useClient: 'ANDROID',
                highWaterMark: 1 << 25,
            },
            // Hidden runtime option supported by discord-player-youtubei.
            useYoutubeDL: youtubeiUseDl,
            logLevel: 'NONE',
        } as any);
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
