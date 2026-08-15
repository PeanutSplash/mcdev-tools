import { promises as fs, Dirent } from 'fs';
import * as path from 'path';

/** 自动发现到的 MOD 目录候选 */
export interface ModDirectoryCandidate {
    /** 写入 .mcdev.json 的路径：位于工作区内使用相对路径，否则使用绝对路径 */
    path: string;
    /** 绝对路径，用于去重与提示 */
    absolutePath: string;
    /** 目录名，作为展示标题 */
    name: string;
    /** 行为包数量 */
    behaviorPacks: number;
    /** 资源包数量 */
    resourcePacks: number;
    /** 候选是否就是工作区根目录本身 */
    isWorkspaceRoot: boolean;
}

interface PackSummary {
    behaviorPacks: number;
    resourcePacks: number;
    total: number;
}

/** 相对工作区根向下搜索的层数，覆盖 `<工作区>/mods/<mod>` 这类常见布局 */
const MAX_SCAN_DEPTH = 3;
const MAX_CANDIDATES = 300;
const MAX_VISITED_DIRECTORIES = 4000;
const CACHE_TTL_MS = 10_000;

/** 不可能是 MOD、且遍历代价高的目录 */
const IGNORED_DIRECTORY_NAMES = new Set([
    'node_modules',
    '__pycache__',
    'out',
    'dist',
    'build',
    'venv',
    'env',
    'target',
    'behavior_packs',
    'resource_packs'
]);

interface CacheEntry {
    key: string;
    timestamp: number;
    result: Promise<ModDirectoryCandidate[]>;
}

let cache: CacheEntry | undefined;

/**
 * 扫描工作区，发现可作为 MOD 目录使用的候选。
 *
 * 判定标准与 mcdk 一致：目录的直接子目录中存在带 manifest.json 的包目录。
 * 工作区根目录本身是 MOD 时同样会被发现（用户直接打开单个 MOD 文件夹的场景）。
 */
export function discoverModDirectories(
    workspaceRoots: string[],
    options: { refresh?: boolean } = {}
): Promise<ModDirectoryCandidate[]> {
    const roots = workspaceRoots.filter(root => root.length > 0);
    const key = roots.join('|');
    const now = Date.now();
    if (
        !options.refresh &&
        cache &&
        cache.key === key &&
        now - cache.timestamp < CACHE_TTL_MS
    ) {
        return cache.result;
    }

    const result = scanWorkspaceRoots(roots).catch(error => {
        if (cache?.result === result) {
            cache = undefined;
        }
        throw error;
    });
    cache = { key, timestamp: now, result };
    return result;
}

/** 丢弃缓存，下一次发现会重新扫描磁盘 */
export function clearModDirectoryCache(): void {
    cache = undefined;
}

async function scanWorkspaceRoots(roots: string[]): Promise<ModDirectoryCandidate[]> {
    const relativeBase = roots[0];
    const candidates: ModDirectoryCandidate[] = [];
    const seen = new Set<string>();
    const visited = { count: 0 };

    for (const root of roots) {
        if (candidates.length >= MAX_CANDIDATES) {
            break;
        }
        await scanDirectory(root, 0, {
            root,
            relativeBase,
            candidates,
            seen,
            visited
        });
    }

    return candidates.sort(compareCandidates);
}

interface ScanContext {
    root: string;
    relativeBase?: string;
    candidates: ModDirectoryCandidate[];
    seen: Set<string>;
    visited: { count: number };
}

async function scanDirectory(directory: string, depth: number, context: ScanContext): Promise<void> {
    if (
        context.candidates.length >= MAX_CANDIDATES ||
        context.visited.count >= MAX_VISITED_DIRECTORIES
    ) {
        return;
    }
    context.visited.count += 1;

    const entries = await readDirectory(directory);
    if (!entries) {
        return;
    }

    const childDirectories = entries.filter(entry => isScannableDirectory(entry));
    const packs = await summarizePacks(directory, childDirectories);
    if (packs.total > 0) {
        addCandidate(directory, packs, depth === 0, context);
        // MOD 内部只剩包目录，无需继续下探
        return;
    }

    if (depth >= MAX_SCAN_DEPTH) {
        return;
    }

    for (const entry of childDirectories) {
        await scanDirectory(path.join(directory, entry.name), depth + 1, context);
    }
}

function addCandidate(
    directory: string,
    packs: PackSummary,
    isWorkspaceRoot: boolean,
    context: ScanContext
): void {
    const absolutePath = path.resolve(directory);
    const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
    if (context.seen.has(key)) {
        return;
    }
    context.seen.add(key);
    context.candidates.push({
        path: toConfiguredPath(absolutePath, context.relativeBase),
        absolutePath,
        name: path.basename(absolutePath) || absolutePath,
        behaviorPacks: packs.behaviorPacks,
        resourcePacks: packs.resourcePacks,
        isWorkspaceRoot
    });
}

/**
 * mcdk 以工作区为基准解析相对路径，因此工作区内的候选写成相对路径，
 * 这样配置在不同机器之间仍然可用；工作区外的候选只能用绝对路径。
 */
function toConfiguredPath(absolutePath: string, relativeBase?: string): string {
    if (!relativeBase) {
        return toPosixPath(absolutePath);
    }
    const relative = path.relative(relativeBase, absolutePath);
    if (relative.length === 0) {
        return './';
    }
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return toPosixPath(absolutePath);
    }
    return `./${toPosixPath(relative)}`;
}

function toPosixPath(value: string): string {
    return value.replace(/\\/g, '/');
}

async function readDirectory(directory: string): Promise<Dirent[] | undefined> {
    try {
        return await fs.readdir(directory, { withFileTypes: true });
    } catch {
        // 无权限或已被删除的目录直接跳过
        return undefined;
    }
}

function isScannableDirectory(entry: Dirent): boolean {
    if (!entry.isDirectory()) {
        return false;
    }
    if (entry.name.startsWith('.')) {
        return false;
    }
    return !IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase());
}

/** 统计目录直接子目录中的包，用于判定该目录是否是 MOD */
async function summarizePacks(directory: string, childDirectories: Dirent[]): Promise<PackSummary> {
    const packTypes = await Promise.all(
        childDirectories.map(entry => readPackType(path.join(directory, entry.name), entry.name))
    );

    const summary: PackSummary = { behaviorPacks: 0, resourcePacks: 0, total: 0 };
    for (const packType of packTypes) {
        if (!packType) {
            continue;
        }
        summary.total += 1;
        if (packType === 'behavior') {
            summary.behaviorPacks += 1;
        } else if (packType === 'resource') {
            summary.resourcePacks += 1;
        }
    }
    return summary;
}

type PackType = 'behavior' | 'resource' | 'unknown';

async function readPackType(packDirectory: string, packName: string): Promise<PackType | undefined> {
    let manifest: string;
    try {
        manifest = await fs.readFile(path.join(packDirectory, 'manifest.json'), 'utf8');
    } catch {
        return undefined;
    }

    try {
        const parsed = JSON.parse(stripBom(manifest)) as { modules?: { type?: string }[] };
        for (const module of parsed.modules ?? []) {
            if (module?.type === 'data') {
                return 'behavior';
            }
            if (module?.type === 'resources') {
                return 'resource';
            }
        }
    } catch {
        // manifest 损坏时退回按目录名判断，避免整个 MOD 无法被发现
    }

    const normalizedName = packName.toLowerCase();
    if (normalizedName.startsWith('behavior')) {
        return 'behavior';
    }
    if (normalizedName.startsWith('resource')) {
        return 'resource';
    }
    return 'unknown';
}

function stripBom(value: string): string {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function compareCandidates(left: ModDirectoryCandidate, right: ModDirectoryCandidate): number {
    if (left.isWorkspaceRoot !== right.isWorkspaceRoot) {
        return left.isWorkspaceRoot ? -1 : 1;
    }
    return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' });
}
