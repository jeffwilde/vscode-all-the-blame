import type { Commit } from "./Commit.js";
import { git } from "./command/CachedGit.js";
import { Logger } from "../logger.js";

const BOT_SUFFIX = /\[bot\]$/i;
const COMMIT_DELIMITER = "COMMIT_DELIMITER ";

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

export async function resolveCoAuthors(
	commits: Iterable<Commit>,
	filePath: string,
): Promise<void> {
	const botCommits = new Map<string, Commit>();

	for (const commit of commits) {
		if (commit.isCommitted() && isBotAuthor(commit.author.name)) {
			botCommits.set(commit.hash, commit);
		}
	}

	if (botCommits.size === 0) {
		return;
	}

	try {
		const output = await git.run(
			filePath,
			"log",
			`--format=${COMMIT_DELIMITER}%H%n%B`,
			"--no-walk",
			...botCommits.keys(),
		);

		for (const block of output.split(COMMIT_DELIMITER)) {
			if (!block.trim()) continue;

			const newlineIndex = block.indexOf("\n");
			if (newlineIndex === -1) continue;

			const hash = block.slice(0, newlineIndex).trim();
			const message = block.slice(newlineIndex + 1);
			const commit = botCommits.get(hash);

			if (!commit) continue;

			const coAuthors = parseCoAuthors(message);
			if (coAuthors.length > 0) {
				Logger.info(
					`Resolved co-author "${coAuthors[0].name}" for bot-authored commit ${hash}`,
				);
				commit.author.name = coAuthors[0].name;
				commit.author.mail = coAuthors[0].mail;
			}
		}
	} catch {
		// If we can't fetch commit messages, keep the original authors
	}
}
