import Mustache from "mustache";
import { between } from "../ago.js";
import type { Commit, CommitLike } from "../git/Commit.js";
import type { CommitAuthorLike } from "../git/CommitAuthor.js";
import { PropertyStore } from "../PropertyStore.js";

export type TemplateView = Record<string, unknown>;

// sv-SE is close enough to ISO8601
const DateFormater = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short" });

function authorView(
	author: CommitAuthorLike,
	currentUserAlias: string,
): Record<string, unknown> {
	return {
		name:
			author.isCurrentUser && currentUserAlias ? currentUserAlias : author.name,
		mail: author.mail,
		timestamp: author.timestamp,
		tz: author.tz,
		date: DateFormater.format(author.date),
		is_current_user: author.isCurrentUser,
	};
}

export function normalizeCommitInfoTokens({
	author,
	committer,
	hash,
	summary,
}: CommitLike): TemplateView {
	const now = new Date();
	const currentUserAlias = PropertyStore.get("currentUserAlias");

	return {
		author: authorView(author, currentUserAlias),
		committer: authorView(committer, currentUserAlias),
		commit: {
			hash,
			hash_short: hash.slice(0, 7),
			summary,
		},
		time: {
			ago: between(now, author.date),
			c_ago: between(now, committer.date),
		},
		upper:
			() =>
			(text: string, render: (text: string) => string): string =>
				render(text).toUpperCase(),
		lower:
			() =>
			(text: string, render: (text: string) => string): string =>
				render(text).toLowerCase(),
	};
}

function sanitize(output: string): string {
	return output.replaceAll("\u202e", "");
}

export function renderTemplate(template: string, view: TemplateView): string {
	return sanitize(
		Mustache.render(template, view, undefined, { escape: (v: string) => v }),
	);
}

export function toStatusBarTextView(commit: Commit): string {
	return renderTemplate(
		PropertyStore.get("statusBarMessageFormat"),
		normalizeCommitInfoTokens(commit),
	);
}

export function toInlineTextView(commit: Commit): string {
	return renderTemplate(
		PropertyStore.get("inlineMessageFormat"),
		normalizeCommitInfoTokens(commit),
	);
}
