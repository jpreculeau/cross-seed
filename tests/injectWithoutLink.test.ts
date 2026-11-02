import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { TorrentClient } from "../src/clients/TorrentClient.js";
import type { Metafile } from "../src/parseTorrent.js";
import type { RuntimeConfig } from "../src/runtimeConfig.js";
import type { SearcheeWithLabel } from "../src/searchee.js";
import { searcheeFactory } from "./factories/searchee.js";

const TEST_ROOT = await mkdtemp(join(tmpdir(), "cross-seed-nolink-tests-"));

// Two directories on different filesystems: a hardlink between them is
// impossible, like data on a network share with a local linkDir. /dev/shm is
// a separate tmpfs on Linux (GitHub runners included); elsewhere the
// integration cases are skipped, so Windows (stat.dev === 0) is not covered.
const OTHER_FS = "/dev/shm";
const crossDevice = await stat(OTHER_FS)
	.then(async (s) => s.dev !== (await stat(TEST_ROOT)).dev)
	.catch(() => false);

type Env = {
	action: typeof import("../src/action.js");
	Action: typeof import("../src/constants.js").Action;
	Decision: typeof import("../src/constants.js").Decision;
	InjectionResult: typeof import("../src/constants.js").InjectionResult;
	Label: typeof import("../src/logger.js").Label;
	LinkType: typeof import("../src/constants.js").LinkType;
	resultOf: typeof import("../src/Result.js").resultOf;
	resultOfErr: typeof import("../src/Result.js").resultOfErr;
	configure: (config: Partial<RuntimeConfig>) => void;
	getClients: typeof import("../src/clients/TorrentClient.js").getClients;
	validateClientSavePaths: typeof import("../src/clients/TorrentClient.js").validateClientSavePaths;
	checkConfigPaths: typeof import("../src/startup.js").checkConfigPaths;
	CrossSeedError: typeof import("../src/errors.js").CrossSeedError;
	db: typeof import("../src/db.js").db;
};

async function createEnv(): Promise<Env> {
	process.env.CONFIG_DIR = await mkdtemp(join(TEST_ROOT, "config-"));
	vi.resetModules();
	const { db } = await import("../src/db.js");
	const { createAppDirHierarchy } = await import("../src/configuration.js");
	const { initializeLogger, Label } = await import("../src/logger.js");
	const { setRuntimeConfig } = await import("../src/runtimeConfig.js");
	const { Action, Decision, InjectionResult, LinkType } = await import(
		"../src/constants.js"
	);
	const { resultOf, resultOfErr } = await import("../src/Result.js");
	const { getClients, validateClientSavePaths } = await import(
		"../src/clients/TorrentClient.js"
	);
	const { checkConfigPaths } = await import("../src/startup.js");
	const { CrossSeedError } = await import("../src/errors.js");
	const action = await import("../src/action.js");
	createAppDirHierarchy();
	initializeLogger({ verbose: false });
	// v6 has no default runtime config object: start from the defaults that
	// matter here (linkType and the option itself).
	const configure = (config: Partial<RuntimeConfig>) =>
		setRuntimeConfig({
			linkDirs: [],
			linkType: LinkType.HARDLINK,
			flatLinking: false,
			injectInPlaceWithoutLinkDir: false,
			...config,
		} as RuntimeConfig);
	return {
		action,
		Action,
		Decision,
		InjectionResult,
		Label,
		LinkType,
		resultOf,
		resultOfErr,
		configure,
		getClients,
		validateClientSavePaths,
		checkConfigPaths,
		CrossSeedError,
		db,
	};
}

afterAll(async () => {
	delete process.env.CONFIG_DIR;
	await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("canInjectWithoutLink", () => {
	let env: Env;
	beforeAll(async () => {
		env = await createEnv();
	});
	afterAll(async () => {
		await env.db.destroy();
	});

	it("allows a perfect match when enabled", () => {
		env.configure({ injectInPlaceWithoutLinkDir: true });
		expect(env.action.canInjectWithoutLink(env.Decision.MATCH)).toBe(true);
	});

	it("refuses everything when disabled (default)", () => {
		env.configure({ injectInPlaceWithoutLinkDir: false });
		expect(env.action.canInjectWithoutLink(env.Decision.MATCH)).toBe(false);
	});

	it("refuses renamed or partial matches: they need a link", () => {
		env.configure({ injectInPlaceWithoutLinkDir: true });
		expect(
			env.action.canInjectWithoutLink(env.Decision.MATCH_SIZE_ONLY),
		).toBe(false);
		expect(
			env.action.canInjectWithoutLink(env.Decision.MATCH_PARTIAL),
		).toBe(false);
	});

	it("is a no-op with symlinks, which never lack a linkDir", () => {
		env.configure({
			injectInPlaceWithoutLinkDir: true,
			linkType: env.LinkType.SYMLINK,
		});
		expect(env.action.canInjectWithoutLink(env.Decision.MATCH)).toBe(false);
	});
});

describe("injection without a linkDir on the same drive", () => {
	const dirs: string[] = [];
	let env: Env;

	afterEach(async () => {
		if (env) env.getClients().length = 0;
		await Promise.all(
			dirs.map((d) => rm(d, { recursive: true, force: true })),
		);
		dirs.length = 0;
		await env?.db.destroy();
	});

	async function setup(injectInPlaceWithoutLinkDir: boolean) {
		env = await createEnv();
		const tmp = async (parent: string, prefix: string) => {
			const dir = await mkdtemp(join(parent, prefix));
			dirs.push(dir);
			return dir;
		};
		const savePath = await tmp(OTHER_FS, "xs-data-");
		const linkDir = await tmp(TEST_ROOT, "xs-link-");
		const outputDir = await tmp(TEST_ROOT, "xs-out-");
		const filePath = join(savePath, "a.mkv");
		await writeFile(filePath, "x");
		const { mtimeMs } = await stat(filePath);
		env.configure({
			action: env.Action.INJECT,
			linkDirs: [linkDir],
			linkType: env.LinkType.HARDLINK,
			flatLinking: true,
			skipRecheck: true,
			outputDir,
			injectInPlaceWithoutLinkDir,
		});
		const inject = vi.fn<TorrentClient["inject"]>(() =>
			Promise.resolve(env.InjectionResult.SUCCESS),
		);
		const client = {
			clientHost: "localhost:1",
			clientPriority: 0,
			label: "test",
			readonly: false,
			getDownloadDir: () =>
				Promise.resolve(env.resultOfErr("NOT_FOUND" as const)),
			isTorrentInClient: () => Promise.resolve(env.resultOf(false)),
			inject,
		} as unknown as TorrentClient;
		env.getClients().push(client);
		const files = [{ name: "a.mkv", path: "a.mkv", length: 1 }];
		const newMeta = {
			infoHash: "new",
			name: "a.mkv",
			title: "a.mkv",
			files,
			length: 1,
			getFileSystemSafeName: () => "a.mkv",
			encode: () => new Uint8Array(),
		} as unknown as Metafile;
		return { savePath, linkDir, filePath, mtimeMs, files, inject, newMeta };
	}

	it.skipIf(!crossDevice)(
		"injects a perfect torrent-based match in place when enabled",
		async () => {
			const { savePath, linkDir, files, inject, newMeta } =
				await setup(true);
			const searchee = searcheeFactory({
				infoHash: "old",
				savePath,
				clientHost: "localhost:1",
				files,
				length: 1,
				label: env.Label.INJECT,
			}) as SearcheeWithLabel;
			const res = await env.action.performActionWithoutMutex(
				newMeta,
				env.Decision.MATCH,
				searchee,
				"tracker",
				undefined,
				{ onlyCompleted: false },
			);
			expect(res.actionResult).toBe(env.InjectionResult.SUCCESS);
			expect(res).toHaveProperty("linkedNewFiles", false);
			expect(inject).toHaveBeenCalledTimes(1);
			// As without linkDirs: the client derives the save path, category
			// and layout from the source torrent.
			expect(inject.mock.calls[0][3].destinationDir).toBeUndefined();
			expect(await readdir(linkDir)).toEqual([]);
		},
	);

	it.skipIf(!crossDevice)(
		"injects a perfect data-based match in its own directory when enabled",
		async () => {
			const {
				savePath,
				linkDir,
				filePath,
				mtimeMs,
				files,
				inject,
				newMeta,
			} = await setup(true);
			const searchee = searcheeFactory({
				path: filePath,
				mtimeMs,
				files: [{ ...files[0], path: filePath }],
				length: 1,
				label: env.Label.SEARCH,
			}) as SearcheeWithLabel;
			const res = await env.action.performActionWithoutMutex(
				newMeta,
				env.Decision.MATCH,
				searchee,
				"tracker",
			);
			expect(res.actionResult).toBe(env.InjectionResult.SUCCESS);
			expect(inject).toHaveBeenCalledTimes(1);
			expect(inject.mock.calls[0][3].destinationDir).toBe(
				dirname(filePath),
			);
			expect(dirname(filePath)).toBe(savePath);
			expect(await readdir(linkDir)).toEqual([]);
		},
	);

	it.skipIf(!crossDevice)(
		"still fails a perfect match when disabled (default)",
		async () => {
			const { savePath, files, inject, newMeta } = await setup(false);
			const searchee = searcheeFactory({
				infoHash: "old",
				savePath,
				clientHost: "localhost:1",
				files,
				length: 1,
				label: env.Label.INJECT,
			}) as SearcheeWithLabel;
			const res = await env.action.performActionWithoutMutex(
				newMeta,
				env.Decision.MATCH,
				searchee,
				"tracker",
				undefined,
				{ onlyCompleted: false },
			);
			expect(res.actionResult).toBe(env.InjectionResult.FAILURE);
			expect(inject).not.toHaveBeenCalled();
		},
	);

	it.skipIf(!crossDevice)(
		"still fails a renamed match, which needs a link",
		async () => {
			const { savePath, files, inject, newMeta } = await setup(true);
			const searchee = searcheeFactory({
				infoHash: "old",
				savePath,
				clientHost: "localhost:1",
				files: [{ ...files[0], name: "b.mkv", path: "b.mkv" }],
				length: 1,
				label: env.Label.INJECT,
			}) as SearcheeWithLabel;
			await writeFile(join(savePath, "b.mkv"), "x");
			const res = await env.action.performActionWithoutMutex(
				newMeta,
				env.Decision.MATCH_SIZE_ONLY,
				searchee,
				"tracker",
				undefined,
				{ onlyCompleted: false },
			);
			expect(res.actionResult).toBe(env.InjectionResult.FAILURE);
			expect(inject).not.toHaveBeenCalled();
		},
	);
});

describe("linking health checks without a linkDir on the same drive", () => {
	const dirs: string[] = [];
	let env: Env;

	afterEach(async () => {
		await Promise.all(
			dirs.map((d) => rm(d, { recursive: true, force: true })),
		);
		dirs.length = 0;
		await env?.db.destroy();
	});

	async function setup(
		injectInPlaceWithoutLinkDir: boolean,
		linkType: "HARDLINK" | "SYMLINK" = "HARDLINK",
	) {
		env = await createEnv();
		const savePath = await mkdtemp(join(OTHER_FS, "xs-data-"));
		const linkDir = await mkdtemp(join(TEST_ROOT, "xs-link-"));
		const outputDir = await mkdtemp(join(TEST_ROOT, "xs-out-"));
		dirs.push(savePath, linkDir, outputDir);
		env.configure({
			dataDirs: [savePath],
			linkDirs: [linkDir],
			linkType: env.LinkType[linkType],
			outputDir,
			injectInPlaceWithoutLinkDir,
		});
		return { savePath, linkDir };
	}

	it.skipIf(!crossDevice)(
		"skips the link probe (warning only) when enabled",
		async () => {
			const { savePath } = await setup(true);
			expect(await env.action.linkingCheckSkippedInPlace(savePath)).toBe(
				true,
			);
		},
	);

	it.skipIf(!crossDevice)(
		"keeps the link probe when disabled (default)",
		async () => {
			const { savePath } = await setup(false);
			expect(await env.action.linkingCheckSkippedInPlace(savePath)).toBe(
				false,
			);
		},
	);

	it.skipIf(!crossDevice)(
		"keeps the link probe with symlinks, where the option is a no-op",
		async () => {
			const { savePath } = await setup(true, "SYMLINK");
			expect(await env.action.linkingCheckSkippedInPlace(savePath)).toBe(
				false,
			);
		},
	);

	it("keeps the link probe when a linkDir shares the drive", async () => {
		const { linkDir } = await setup(true);
		expect(await env.action.linkingCheckSkippedInPlace(linkDir)).toBe(
			false,
		);
	});

	// End to end: the real health checks, not only their predicate.
	const clientCheck = (savePath: string) =>
		env.validateClientSavePaths([], new Map([["h", savePath]]), "test", 0);

	it.skipIf(!crossDevice)(
		"client save path check passes when enabled",
		async () => {
			const { savePath } = await setup(true);
			await expect(clientCheck(savePath)).resolves.toBeUndefined();
		},
	);

	it.skipIf(!crossDevice)(
		"client save path check fails when disabled (default)",
		async () => {
			const { savePath } = await setup(false);
			await expect(clientCheck(savePath)).rejects.toBeInstanceOf(
				env.CrossSeedError,
			);
		},
	);

	it.skipIf(!crossDevice)("dataDir check passes when enabled", async () => {
		await setup(true);
		await expect(env.checkConfigPaths()).resolves.toBeUndefined();
	});

	it.skipIf(!crossDevice)(
		"dataDir check fails when disabled (default)",
		async () => {
			await setup(false);
			await expect(env.checkConfigPaths()).rejects.toBeInstanceOf(
				env.CrossSeedError,
			);
		},
	);
});
