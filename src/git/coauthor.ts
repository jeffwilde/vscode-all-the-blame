import { Logger } from "../logger.js";
import type { Commit } from "./Commit.js";
import { CoAuthorCache } from "./coauthor-cache.js";
import { git } from "./command/CachedGit.js";

const BOT_SUFFIX = /\[bot\]$/i;
const COMMIT_DELIMITER = "COMMIT_DELIMITER ";
// Conservative limit to stay under Windows' ~32KB ARG_MAX.
const MAX_HASHES_PER_CALL = 500;

export function isBotAuthor(name: string): boolean {
	return BOT_SUFFIX.test(name);
}

export function parseCoAuthors(
	message: string,
): { name: string; mail: string }[] {
	const pattern = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>/gim;
	return [...message.matchAll(pattern)].map((match) => ({
		name: match[1].trim(),
		mail: `<${match[2]}>`,
	}));
}

function applyCoAuthor(
	commit: Commit,
	coAuthor: { name: string; mail: string },
): void {
	commit.author.name = coAuthor.name;
	commit.author.mail = coAuthor.mail;
}

async function fetchCoAuthors(
	hashes: string[],
	filePath: string,
): Promise<Map<string, { name: string; mail: string } | null>> {
	const results = new Map<string, { name: string; mail: string } | null>();

	const output = await git.run(
		filePath,
		"log",
		`--format=${COMMIT_DELIMITER}%H%n%B`,
		"--no-walk",
		...hashes,
	);

	for (const block of output.split(COMMIT_DELIMITER)) {
		if (!block.trim()) continue;

		const newlineIndex = block.indexOf("\n");
		if (newlineIndex === -1) continue;

		const hash = block.slice(0, newlineIndex).trim();
		const message = block.slice(newlineIndex + 1);
		const coAuthors = parseCoAuthors(message);

		results.set(hash, coAuthors.length > 0 ? coAuthors[0] : null);
	}

	return results;
}

/**
 * Streaming co-author resolver. Observes commits as they arrive from
 * git blame, resolves cached entries immediately, and accumulates
 * uncached bot-authored hashes for batch resolution.
 */
export class CoAuthorResolver {
	private readonly filePath: string;
	private readonly cache: CoAuthorCache | undefined;
	private readonly pending = new Map<string, Commit>();
	private readonly seen = new Set<string>();

	constructor(filePath: string) {
		this.filePath = filePath;
		this.cache = CoAuthorCache.getInstance();
	}

	/**
	 * Observe a commit from the blame stream. If bot-authored and
	 * cached, applies the co-author immediately. Otherwise accumulates
	 * the hash for batch resolution in flush().
	 */
	public observe(commit: Commit): void {
		if (!commit.isCommitted() || !isBotAuthor(commit.author.name)) {
			return;
		}

		const { hash } = commit;
		if (this.seen.has(hash)) return;
		this.seen.add(hash);

		if (this.cache?.has(hash)) {
			const cached = this.cache.get(hash);
			if (cached) {
				applyCoAuthor(commit, cached);
				Logger.info(
					`Resolved co-author "${cached.name}" for commit ${hash} (cached)`,
				);
			}
			return;
		}

		this.pending.set(hash, commit);
	}

	/**
	 * Resolve all accumulated hashes in batched git log calls,
	 * update commits, and persist results to the cache.
	 */
	public async flush(): Promise<void> {
		if (this.pending.size === 0) return;

		try {
			const allHashes = [...this.pending.keys()];
			const chunks: Promise<
				Map<string, { name: string; mail: string } | null>
			>[] = [];

			for (let i = 0; i < allHashes.length; i += MAX_HASHES_PER_CALL) {
				chunks.push(
					fetchCoAuthors(
						allHashes.slice(i, i + MAX_HASHES_PER_CALL),
						this.filePath,
					),
				);
			}

			const results = await Promise.all(chunks);

			for (const batch of results) {
				for (const [hash, coAuthor] of batch) {
					const commit = this.pending.get(hash);
					if (coAuthor) {
						if (commit) applyCoAuthor(commit, coAuthor);
						this.cache?.set(hash, coAuthor);
						Logger.info(
							`Resolved co-author "${coAuthor.name}" for commit ${hash}`,
						);
					} else {
						this.cache?.setNone(hash);
					}
				}
			}

			await this.cache?.flush();
		} catch {
			// If we can't fetch commit messages, keep the original authors
		}
	}
}
