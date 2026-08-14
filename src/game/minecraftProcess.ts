/**
 * Minecraft 进程探测与终止
 * 供 ptvsd 子进程模式判断与侧边栏运行状态显示共用
 */

import * as cp from 'child_process';

/** tasklist 过滤用的游戏映像名 */
const MINECRAFT_IMAGE_NAME = 'Minecraft.Windows.exe';

/** 探测与终止命令的最长等待时间，避免轮询被卡住的命令拖住 */
const COMMAND_TIMEOUT_MS = 5000;

export interface MinecraftProcess {
    pid: number;
    name: string;
}

function execFileText(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(
            command,
            args,
            // 控制台命令按 OEM 代码页输出，latin1 不会破坏我们只关心的 ASCII 字段
            { encoding: 'latin1', timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

/**
 * 列出系统中正在运行的 Minecraft 进程
 */
export async function findMinecraftProcesses(): Promise<MinecraftProcess[]> {
    if (process.platform !== 'win32') {
        return [];
    }

    let stdout: string;
    try {
        stdout = await execFileText('tasklist', [
            '/FI', `IMAGENAME eq ${MINECRAFT_IMAGE_NAME}`,
            '/FO', 'CSV',
            '/NH'
        ]);
    } catch {
        return [];
    }

    const processes: MinecraftProcess[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        // 命中的行形如 "Minecraft.Windows.exe","12345","Console","1","1,234 K"
        // 无命中时 tasklist 输出一行本地化提示，正则天然会跳过
        const matched = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (matched) {
            processes.push({
                pid: Number(matched[2]),
                name: matched[1].replace(/\.exe$/i, '')
            });
        }
    }
    return processes;
}

/**
 * 检查是否有 Minecraft 进程在运行
 */
export async function isMinecraftRunning(): Promise<boolean> {
    const processes = await findMinecraftProcesses();
    return processes.length > 0;
}

/**
 * 强制结束指定进程及其子进程
 */
export async function terminateProcessTree(pid: number): Promise<void> {
    if (process.platform !== 'win32') {
        process.kill(pid, 'SIGKILL');
        return;
    }
    await execFileText('taskkill', ['/PID', String(pid), '/T', '/F']);
}
