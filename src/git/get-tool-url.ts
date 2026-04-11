import { URL } from "node:url";
import type { Uri as UriType } from "vscode";
import { Logger } from "../logger.js";
import { errorMessage } from "../message.js";
import { PropertyStore } from "../PropertyStore.js";
import { isUrl } from "../string-stuff/is-url.js";
import { split } from "../string-stuff/split.js";
import {
	type TemplateView,
	renderTemplate,
} from "../string-stuff/text-decorator.js";
import { getvscode } from "../vscode-quarantine.js";
import { getGeneralGitInfo } from "./command/getGeneralGitInfo.js";
import type { LineAttachedCommit } from "./LineAttachedCommit.js";
import { originUrlToToolUrl } from "./origin-url-to-tool-url.js";
import { projectNameFromOrigin } from "./project-name-from-origin.js";
import { stripGitRemoteUrl, stripGitSuffix } from "./strip-git-remote-url.js";

function getPathIndex(path: string, splitOn = "/"): string[] {
	return path.split(splitOn).filter((a) => !!a);
}

function gitOriginHostnameView(url: URL): Record<string, string> {
	const parts = getPathIndex(url.hostname, ".");
	const view: Record<string, string> = { full: url.hostname };
	for (let i = 0; i < parts.length; i++) {
		view[i.toString()] = parts[i];
	}
	return view;
}

/**
 * @internal
 */
export function gitRemotePathView(
	remote: string,
): Record<string, string> {
	let pathname: string;

	if (/^[a-z0-9-]+?@/.test(remote)) {
		const [, path] = split(remote, ":");
		pathname = `/${path}`;
	} else {
		try {
			pathname = new URL(remote).pathname;
		} catch (err) {
			if (err instanceof Error) {
				Logger.debug(
					`Failed to get git remote path token value: "${err.message}"`,
				);
			}
			return { full: "no-remote-url" };
		}
	}

	const parts = getPathIndex(pathname);
	const view: Record<string, string> = { full: pathname };
	for (let i = 0; i < parts.length; i++) {
		view[i.toString()] = parts[i];
	}
	return view;
}

function isToolUrlPlural(origin: string): boolean {
	return PropertyStore.get("pluralWebPathSubstrings").some((substring) =>
		origin.includes(substring),
	);
}

/**
 * @internal
 */
export async function generateUrlTokens(
	lineAware: LineAttachedCommit,
): Promise<TemplateView | undefined> {
	const generalGit = await getGeneralGitInfo(PropertyStore.get("remoteName"));
	if (generalGit === undefined || generalGit.remoteUrl === "") {
		Logger.info("Unable to find remote URL. Can not provide URL.");
		return;
	}

	const tool = originUrlToToolUrl(generalGit.remoteUrl);

	return {
		hash: lineAware.commit.hash,
		tool: {
			protocol: tool?.protocol ?? "https:",
			commitpath: `/commit${isToolUrlPlural(generalGit.remoteUrl) ? "s" : ""}/`,
		},
		project: {
			name: projectNameFromOrigin(generalGit.fileOrigin),
			remote: stripGitRemoteUrl(generalGit.remoteUrl),
			currentbranch: generalGit.currentBranch,
			defaultbranch: generalGit.defaultBranch,
			currenthash: generalGit.currentHash,
		},
		gitorigin: {
			hostname: tool ? gitOriginHostnameView(tool) : { "": "no-origin-url" },
			path: gitRemotePathView(stripGitSuffix(generalGit.fileOrigin)),
			port: tool?.port ? `:${tool.port}` : "",
		},
		file: {
			path: generalGit.relativePathOfActiveFile,
			"path.result": generalGit.relativePathOfActiveFile,
			"path.source": lineAware.filename,
			line: lineAware.line.result.toString(),
			"line.result": lineAware.line.result.toString(),
			"line.source": lineAware.line.source.toString(),
		},
	};
}

let Uri: typeof UriType | undefined;
export async function getToolUrl(
	commit?: LineAttachedCommit,
): Promise<UriType | undefined> {
	if (!commit?.commit.isCommitted()) {
		return;
	}
	const tokens = await generateUrlTokens(commit);

	if (tokens === undefined) {
		return;
	}

	const parsedUrl = renderTemplate(PropertyStore.get("commitUrl"), tokens);

	if (isUrl(parsedUrl)) {
		Uri ??= (await getvscode())?.Uri;
		if (Uri === undefined) {
			return;
		}
		return Uri.parse(parsedUrl, true);
	}

	errorMessage(
		`Malformed alltheblame.commitUrl: '${parsedUrl}' from '${PropertyStore.get(
			"commitUrl",
		)}'`,
	);
}
