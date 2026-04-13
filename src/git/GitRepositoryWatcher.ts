import type {
	Disposable,
	FileSystemWatcher,
	RelativePattern as RelativePatternType,
	Uri as UriType,
	workspace as WorkspaceType,
} from "vscode";
import { Logger } from "../logger.js";
import { getvscode } from "../vscode-quarantine.js";

export type HeadChangeEvent = {
	gitRoot: string;
	repositoryRoot: string;
};

type RepositoryTarget = {
	gitPath: string;
	isDirectory: boolean;
};

type HeadChangeEventCallbackFunction = (event: HeadChangeEvent) => void;

type WatcherBundle = {
	watchers: FileSystemWatcher[];
	subscriptions: Disposable[];
};

/**
 * Minimal subset of `vscode` the watcher needs. Injectable so unit tests can
 * swap it for a fake without needing the real `vscode` module resolvable.
 */
export type WatcherVscodeApi = {
	workspace: Pick<typeof WorkspaceType, "createFileSystemWatcher">;
	RelativePattern: typeof RelativePatternType;
	Uri: Pick<typeof UriType, "file">;
};

type VscodeApiFactory = () => Promise<WatcherVscodeApi | undefined>;

const defaultVscodeApiFactory: VscodeApiFactory = async () =>
	(await getvscode()) as WatcherVscodeApi | undefined;

export class GitRepositoryWatcher {
	private readonly watchers: Map<string, WatcherBundle> = new Map();
	private callback: HeadChangeEventCallbackFunction = () => undefined;
	private readonly targets: ReadonlyArray<RepositoryTarget>;
	private readonly vscodeApiFactory: VscodeApiFactory;

	public constructor(...targets: RepositoryTarget[]);
	public constructor(options: {
		targets: RepositoryTarget[];
		vscodeApi?: VscodeApiFactory;
	});
	public constructor(
		first?:
			| RepositoryTarget
			| { targets: RepositoryTarget[]; vscodeApi?: VscodeApiFactory },
		...rest: RepositoryTarget[]
	) {
		if (first && typeof first === "object" && "targets" in first) {
			this.targets = first.targets;
			this.vscodeApiFactory = first.vscodeApi ?? defaultVscodeApiFactory;
		} else {
			this.targets = first ? [first, ...rest] : [];
			this.vscodeApiFactory = defaultVscodeApiFactory;
		}
	}

	public onChange(callback: HeadChangeEventCallbackFunction): void {
		this.callback = callback;
	}

	/**
	 * @param gitRepositoryPath Full absolute path to the `.git` folder
	 * (the return value from `git rev-parse --absolute-git-dir`).
	 */
	public async addRepository(gitRepositoryPath: string): Promise<string> {
		if (gitRepositoryPath === "") {
			return "";
		}
		const gitRoot = this.normalizeWindowsDrivePath(gitRepositoryPath);
		const watched = this.watchers.has(gitRoot);

		if (!watched) {
			await this.setupWatcher(gitRoot);
		}

		return gitRoot;
	}

	public dispose(): void {
		for (const [gitRoot, bundle] of this.watchers) {
			for (const sub of bundle.subscriptions) sub.dispose();
			for (const w of bundle.watchers) w.dispose();
			Logger.debug(`File watcher git root "${gitRoot}" closed.`);
		}
		this.watchers.clear();
		this.callback = () => undefined;
	}

	private async setupWatcher(gitRoot: string): Promise<void> {
		// Trim `.git` off the end with a regex rather than node:path so the
		// code is provider-agnostic.
		const repositoryRoot = gitRoot.replace(/[/\\]\.git[/\\]?$/, "");
		const bundle: WatcherBundle = { watchers: [], subscriptions: [] };
		this.watchers.set(gitRoot, bundle);

		const vscode = await this.vscodeApiFactory();
		if (!vscode) {
			Logger.debug(
				"vscode module unavailable; skipping watcher setup (non-extension-host context)",
			);
			return;
		}

		let lastTime = 0;
		const debouncedFire = (subject: string, reason: string) => {
			if (Date.now() - lastTime <= 10) {
				Logger.debug(
					`File watcher callback for "${subject}" called. Reason: "${reason}". Already processed callback within 10ms. Skipping.`,
				);
				return;
			}
			Logger.debug(
				`File watcher callback for "${subject}" called. Reason: "${reason}"`,
			);
			this.callback({ gitRoot, repositoryRoot });
			lastTime = Date.now();
		};

		for (const target of this.targets) {
			const pattern = new vscode.RelativePattern(
				vscode.Uri.file(gitRoot),
				target.isDirectory ? `${target.gitPath}/**` : target.gitPath,
			);
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			const subject = `${gitRoot}/${target.gitPath}`;

			bundle.watchers.push(watcher);
			bundle.subscriptions.push(
				watcher.onDidChange(() => debouncedFire(subject, "change")),
				watcher.onDidCreate(() => debouncedFire(subject, "create")),
				watcher.onDidDelete(() => debouncedFire(subject, "delete")),
			);

			Logger.debug(
				`${target.isDirectory ? "Recursive file" : "File"} watcher for "${target.gitPath}" created.`,
			);
		}
	}

	private normalizeWindowsDrivePath(path: string): string {
		if (!path) {
			return path;
		}
		return path[0].toUpperCase() + path.slice(1);
	}
}
