import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { discoverModDirectories } from './modDiscovery';

async function createPack(modDirectory: string, packName: string, type: 'data' | 'resources'): Promise<void> {
    const packDirectory = path.join(modDirectory, packName);
    await fs.mkdir(packDirectory, { recursive: true });
    await fs.writeFile(
        path.join(packDirectory, 'manifest.json'),
        JSON.stringify({ header: { name: packName }, modules: [{ type }] }),
        'utf8'
    );
}

async function createMod(root: string, relativePath: string): Promise<string> {
    const modDirectory = path.join(root, relativePath);
    await createPack(modDirectory, 'behavior_pack_test', 'data');
    await createPack(modDirectory, 'resource_pack_test', 'resources');
    return modDirectory;
}

test('MOD 发现能找到工作区下按目录归类的 MOD', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-mod-discovery-'));
    await createMod(root, path.join('mods', 'alpha'));
    await createMod(root, path.join('mods', 'beta'));
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'readme.md'), '# docs', 'utf8');

    const candidates = await discoverModDirectories([root], { refresh: true });

    assert.deepEqual(candidates.map(candidate => candidate.path), ['./mods/alpha', './mods/beta']);
    assert.deepEqual(candidates.map(candidate => candidate.name), ['alpha', 'beta']);
    assert.equal(candidates[0].behaviorPacks, 1);
    assert.equal(candidates[0].resourcePacks, 1);
    assert.equal(candidates[0].isWorkspaceRoot, false);
});

test('MOD 发现支持直接打开单个 MOD 目录的工作区', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-mod-discovery-single-'));
    await createMod(root, '.');

    const candidates = await discoverModDirectories([root], { refresh: true });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].path, './');
    assert.equal(candidates[0].isWorkspaceRoot, true);
});

test('MOD 发现不会下探到 MOD 内部，也会跳过忽略目录', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-mod-discovery-nested-'));
    const mod = await createMod(root, path.join('mods', 'alpha'));
    // MOD 内部的包目录里再嵌套一个"像 MOD"的结构，不应被当成独立候选
    await createMod(mod, path.join('behavior_pack_test', 'inner'));
    await createMod(root, path.join('node_modules', 'ignored'));
    await createMod(root, path.join('.hidden', 'ignored'));

    const candidates = await discoverModDirectories([root], { refresh: true });

    assert.deepEqual(candidates.map(candidate => candidate.path), ['./mods/alpha']);
});

test('MOD 发现对工作区外的目录使用绝对路径', async () => {
    const first = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-mod-discovery-primary-'));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-mod-discovery-secondary-'));
    await createMod(first, 'inside');
    const outside = await createMod(second, 'outside');

    const candidates = await discoverModDirectories([first, second], { refresh: true });

    const paths = candidates.map(candidate => candidate.path);
    assert.ok(paths.includes('./inside'));
    assert.ok(paths.includes(outside.replace(/\\/g, '/')));
});
