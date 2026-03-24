import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Track } from 'discord-player';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');

export type FavoriteEntry = {
    title: string;
    url: string;
    author: string;
    duration: string;
    thumbnail: string | null;
    savedAt: string;
};

type FavoritesStore = Record<string, FavoriteEntry[]>;

async function ensureStore() {
    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
        await fs.access(FAVORITES_FILE);
    } catch {
        await fs.writeFile(FAVORITES_FILE, '{}\n', 'utf8');
    }
}

async function readStore(): Promise<FavoritesStore> {
    await ensureStore();

    try {
        const raw = await fs.readFile(FAVORITES_FILE, 'utf8');
        const parsed = JSON.parse(raw) as FavoritesStore;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function writeStore(store: FavoritesStore) {
    await ensureStore();
    await fs.writeFile(FAVORITES_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function listFavorites(userId: string): Promise<FavoriteEntry[]> {
    const store = await readStore();
    return store[userId] ?? [];
}

export async function saveFavorite(userId: string, track: Track): Promise<FavoriteEntry[]> {
    const store = await readStore();
    const entries = store[userId] ?? [];
    const nextEntry: FavoriteEntry = {
        title: track.title,
        url: track.url,
        author: track.author || 'Unknown Artist',
        duration: track.duration || 'Live',
        thumbnail: track.thumbnail || null,
        savedAt: new Date().toISOString(),
    };

    const deduped = entries.filter((entry) => entry.url !== nextEntry.url);
    store[userId] = [nextEntry, ...deduped];
    await writeStore(store);
    return store[userId];
}

export async function removeFavorite(userId: string, url: string): Promise<FavoriteEntry[]> {
    const store = await readStore();
    const entries = store[userId] ?? [];
    store[userId] = entries.filter((entry) => entry.url !== url);
    await writeStore(store);
    return store[userId];
}
