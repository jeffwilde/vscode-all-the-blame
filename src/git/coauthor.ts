import type { Commit } from "./Commit.js";
import { git } from "./command/CachedGit.js";
import { Logger } from "../logger.js";

const BOT_SUFFIX = /\[bot\]$/i;

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

async function resolveCommitCoAuthor(
	commit: Commit,
	filePath: string,
): Promise<void> {
	try {
		const message = await git.run(
			filePath,
			"log",
			"-1",
			"--format=%B",
			commit.hash,
		);

		const coAuthors = parseCoAuthors(message);
		if (coAuthors.length > 0) {
			Logger.info(
				`Resolved co-author "${coAuthors[0].name}" for bot-authored commit ${commit.hash}`,
			);
			commit.author.name = coAuthors[0].name;
			commit.author.mail = coAuthors[0].mail;
		}
	} catch {
		// If we can't fetch the commit message, keep the original author
	}
}

export async function resolveCoAuthors(
	commits: Iterable<Commit>,
	filePath: string,
): Promise<void> {
	const pending: Promise<void>[] = [];

	for (const commit of commits) {
		if (commit.isCommitted() && isBotAuthor(commit.author.name)) {
			pending.push(resolveCommitCoAuthor(commit, filePath));
		}
	}

	await Promise.all(pending);
}
