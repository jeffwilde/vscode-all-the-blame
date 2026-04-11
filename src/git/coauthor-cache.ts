import type { Memento } from "vscode";

type CoAuthorEntry = { name: string; mail: string } | null;
type CacheData = Record<string, CoAuthorEntry>;

const CACHE_KEY = "coAuthorIndex";

export class CoAuthorCache {
	private static instance?: CoAuthorCache;

	public static createInstance(storage: Memento): CoAuthorCache {
		CoAuthorCache.instance = new CoAuthorCache(storage);
		return CoAuthorCache.instance;
	}

	public static getInstance(): CoAuthorCache | undefined {
		return CoAuthorCache.instance;
	}

	private readonly storage: Memento;
	private data: CacheData;
	private dirty = false;

	private constructor(storage: Memento) {
		this.storage = storage;
		this.data = storage.get<CacheData>(CACHE_KEY, {});
	}

	public get(hash: string): CoAuthorEntry | undefined {
		return this.data[hash];
	}

	public has(hash: string): boolean {
		return hash in this.data;
	}

	public set(hash: string, coAuthor: { name: string; mail: string }): void {
		this.data[hash] = coAuthor;
		this.dirty = true;
	}

	public setNone(hash: string): void {
		this.data[hash] = null;
		this.dirty = true;
	}

	public async flush(): Promise<void> {
		if (this.dirty) {
			await this.storage.update(CACHE_KEY, this.data);
			this.dirty = false;
		}
	}
}
