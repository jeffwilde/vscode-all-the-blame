import { PropertyStore } from "../../PropertyStore.js";
import { blameProcess } from "../command/blameProcess.js";
import { git as cachedGit } from "../command/CachedGit.js";
import { getGeneralGitInfo as runGetGeneralGitInfo } from "../command/getGeneralGitInfo.js";
import { getGitEmail } from "../command/getGitEmail.js";
import { getRevsFile } from "../command/getRevsFile.js";
import type {
	BlameOptions,
	BlameStreamHandle,
	GitBackend,
	GitInfo,
} from "./GitBackend.js";

/**
 * Backend implementation that spawns real CLI git as a subprocess.
 * Works on local-host and remote-host. Requires `child_process` and a
 * real filesystem.
 *
 * Thin wrapper over the existing src/git/command/* helpers — moves them
 * behind the GitBackend interface seam without changing behavior. The
 * helpers themselves stay where they are for now; in a follow-up they
 * can be inlined into this class once nothing else imports them.
 */
export class CliGitBackend implements GitBackend {
	getRepositoryFolder(filePath: string): Promise<string | undefined> {
		return cachedGit.getRepositoryFolder(filePath);
	}

	getUserEmail(filePath: string): Promise<string | undefined> {
		return getGitEmail(filePath);
	}

	findRevsFile(filePath: string): Promise<string | undefined> {
		return getRevsFile(filePath);
	}

	async blame(
		filePath: string,
		_options: BlameOptions,
	): Promise<BlameStreamHandle> {
		// The existing blameProcess reads its options from PropertyStore
		// internally. The interface accepts them explicitly so future
		// backends don't have to depend on PropertyStore — but for parity
		// with current behavior, we leave PropertyStore as the source of
		// truth on the CLI path.
		const proc = await blameProcess(filePath, _options.revsFile);
		return proc as unknown as BlameStreamHandle;
	}

	getGeneralGitInfo(fallbackRemote: string): Promise<GitInfo | undefined> {
		return runGetGeneralGitInfo(fallbackRemote);
	}
}

/**
 * Construct CLI blame options from PropertyStore. Centralized so future
 * call sites that go through GitBackend don't have to know which keys to
 * read.
 */
export function blameOptionsFromConfig(): BlameOptions {
	const moveCount = PropertyStore.get("detectMoveOrCopyFromOtherFiles");
	const detect = (Number.isInteger(moveCount) ? moveCount : 0) as 0 | 1 | 2 | 3;
	return {
		ignoreWhitespace: PropertyStore.get("ignoreWhitespace"),
		revsFile: undefined,
		detectMoveOrCopyFromOtherFiles: detect,
	};
}
