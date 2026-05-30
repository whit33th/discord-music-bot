import {
  AppleMusicExtractor,
  SoundCloudExtractor,
  SpotifyExtractor,
} from "@discord-player/extractor";
import { onStreamExtracted, Player, type Track } from "discord-player";
import type { Client } from "discord.js";
import fs from "node:fs";
import { YoutubeSabrExtractor } from "discord-player-googlevideo";
import { YoutubeiExtractor } from "discord-player-youtubei";
import youtubedl, { create as createYoutubeDl } from "youtube-dl-exec";
import { logStreamExtracted } from "./telemetry.js";

const DEFAULT_YOUTUBE_STREAM_HIGH_WATER_MARK = 1 << 25;

function getYoutubeStreamHighWaterMark() {
  const raw = Number.parseInt(
    process.env.YOUTUBE_STREAM_HIGH_WATER_MARK ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_YOUTUBE_STREAM_HIGH_WATER_MARK;
}

function getYoutubeDlBinaryPath() {
  return (
    process.env.YOUTUBE_DL_PATH?.trim() ||
    ((youtubedl as any).constants?.YOUTUBE_DL_PATH as string | undefined)
  );
}

function createYoutubeDlStream(
  url: string,
  cookieFile: string | undefined,
  youtubeDlBinaryPath: string,
) {
  const youtubeDlClient = createYoutubeDl(youtubeDlBinaryPath);
  const process = youtubeDlClient.exec(url, {
    format: "bestaudio",
    output: "-",
    noWarnings: true,
    noProgress: true,
    jsRuntimes: "node",
    cookies: cookieFile,
  });

  process.catch((error) => {
    console.error("[youtube-dl]", error);
  });

  const stream = process.stdout;
  if (!stream) {
    throw new Error("youtube-dl did not return a readable stream.");
  }

  const cleanup = () => {
    if (!process.killed) {
      process.kill();
    }
  };

  stream.once("close", cleanup);
  stream.once("end", cleanup);
  stream.once("error", cleanup);

  return stream;
}

export async function createPlayer(client: Client) {
  const player = new Player(client);
  const youtubeExtractor = (
    process.env.YOUTUBE_EXTRACTOR ?? "youtubei"
  ).toLowerCase();
  const youtubeiUseDl =
    (process.env.YOUTUBE_USE_YTDL ?? "false").toLowerCase() === "true";
  const youtubeCookie = process.env.YOUTUBE_COOKIE;
  const ytDlpCookieFile = process.env.YTDLP_COOKIE_FILE;
  const youtubeDlPath = getYoutubeDlBinaryPath();
  const hasYoutubeDlBinary = Boolean(
    youtubeDlPath && fs.existsSync(youtubeDlPath),
  );
  const hasYtDlpCookieFile = Boolean(
    ytDlpCookieFile && fs.existsSync(ytDlpCookieFile),
  );
  const youtubeStreamHighWaterMark = getYoutubeStreamHighWaterMark();

  onStreamExtracted(async (stream, track, queue) =>
    logStreamExtracted(queue, track, stream),
  );

  if (youtubeExtractor === "googlevideo") {
    await player.extractors.register(YoutubeSabrExtractor, {});
  } else {
    const youtubeiOptions: Record<string, unknown> = {
      cookie: youtubeCookie,
      generateWithPoToken: process.env.YOUTUBE_GENERATE_PO_TOKEN === "true",
      disablePlayer: true,
      overrideBridgeMode: "yt",
      streamOptions: {
        useClient: "ANDROID",
        highWaterMark: youtubeStreamHighWaterMark,
      },
      logLevel: "NONE",
    };

    if (youtubeiUseDl && hasYoutubeDlBinary) {
      youtubeiOptions.createStream = (track: Track) =>
        Promise.resolve(
          createYoutubeDlStream(
            track.url,
            hasYtDlpCookieFile ? ytDlpCookieFile : undefined,
            youtubeDlPath!,
          ),
        );
      if (!hasYtDlpCookieFile) {
        console.warn(
          "[audio] yt-dlp is enabled without YTDLP_COOKIE_FILE, YouTube may require sign-in cookies",
        );
      }
    } else if (youtubeiUseDl) {
      console.warn(
        "[audio] yt-dlp binary not found, falling back to native youtubei streaming",
      );
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
