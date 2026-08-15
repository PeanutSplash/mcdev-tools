import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { getMcdkPath } from '../debugger/ptvsd';
import { GameLifecycleController, McpControlServer } from './controlServer';

const READY_TIMEOUT_MS = 15000;
const CHECK_INTERVAL_MS = 300;
const PROBE_TIMEOUT_MS = 1000;

/**
 * 探测端口是否已有服务在监听
 */
async function isPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(PROBE_TIMEOUT_MS);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, host);
    });
}

/**
 * 等待端口就绪。mcp::server 非阻塞启动时不会同步报告绑定失败，
 * 只能靠探活判断桥接工具是否真的起来了。
 */
async function waitForPort(host: string, port: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        if (await isPortOpen(host, port)) {
            return true;
        }
        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
    }

    return false;
}

/**
 * 管理常驻的 mcdk_stdio_bridge HTTP 进程。
 *
 * 桥接工具始终在线，游戏未启动时也能响应 tools/list，并可通过 start_game
 * 冷启动游戏。它随插件一起启停，不做 detached 常驻。
 */
export class McpBridgeManager implements vscode.Disposable {
    private process: cp.ChildProcess | undefined;
    private controlServer: McpControlServer | undefined;
    private disposed = false;

    private constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly ownsProcess: boolean
    ) {}

    /**
     * 启动桥接工具。返回 undefined 表示未启用或启动失败，此时插件其余功能不受影响。
     *
     * gameController 用于把 start_game / stop_game 交回插件执行，这样 AI 拉起的游戏
     * 也走 VS Code 集成终端，并且会先停掉已有会话。
     */
    public static async create(
        context: vscode.ExtensionContext,
        gameController: GameLifecycleController
    ): Promise<McpBridgeManager | undefined> {
        const config = vscode.workspace.getConfiguration('mcdev-tools');
        if (!config.get<boolean>('mcpBridge.enabled', true)) {
            return undefined;
        }

        const host = '127.0.0.1';
        const port = config.get<number>('mcpBridge.port', 19134);
        const gamePort = config.get<number>('mcpBridge.gamePort', 19133);

        // 端口已被占用时不抢占：大概率是另一个 VSCode 窗口的桥接工具。
        if (await isPortOpen(host, port)) {
            console.log(`MCP 桥接端口 ${port} 已被占用，跳过启动`);
            return new McpBridgeManager(host, port, false);
        }

        const bridgePath = path.join(
            context.extensionPath, 'bin', 'native', 'windows', 'x64', 'mcdk_stdio_bridge.exe'
        );
        if (!fs.existsSync(bridgePath)) {
            console.error(`找不到 mcdk_stdio_bridge.exe: ${bridgePath}`);
            return undefined;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const args = [
            '--http',
            '--listen-host', host,
            '--listen-port', String(port),
            '--port', String(gamePort)
        ];

        // 冷启动游戏时桥接工具需要项目根目录和 mcdk.exe 的位置
        if (workspaceFolder) {
            args.push('--cwd', workspaceFolder.uri.fsPath);
            args.push('--mcdk', getMcdkPath(
                workspaceFolder,
                config.get<string>('mcdkPath', ''),
                context.extensionPath
            ));
        }

        // 控制通道拿不到时桥接工具会退回自行 spawn，功能降级但不至于不可用
        const controlServer = await McpControlServer.create(gameController);
        if (controlServer) {
            args.push('--control-port', String(controlServer.port));
            args.push('--control-token', controlServer.token);
        }

        const child = cp.spawn(bridgePath, args, {
            cwd: workspaceFolder?.uri.fsPath,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const manager = new McpBridgeManager(host, port, true);
        manager.process = child;
        manager.controlServer = controlServer;

        child.stderr?.on('data', (data: Buffer) => {
            console.log(`[mcdk_stdio_bridge] ${data.toString().trim()}`);
        });
        child.once('error', (error) => {
            console.error('MCP 桥接进程启动失败', error);
        });
        child.once('close', (code) => {
            if (!manager.disposed) {
                console.warn(`MCP 桥接进程意外退出，退出码 ${code}`);
            }
            manager.process = undefined;
        });

        if (!await waitForPort(host, port, READY_TIMEOUT_MS)) {
            vscode.window.showWarningMessage(
                `MCP 桥接服务启动失败，端口 ${port} 未就绪。可在设置中调整 mcdev-tools.mcpBridge.port。`
            );
            await manager.disposeAsync();
            return undefined;
        }

        console.log(`MCP 桥接服务已就绪: ${manager.url}`);
        return manager;
    }

    /**
     * 供 MCP 客户端连接的地址
     */
    public get url(): string {
        return `http://${this.host}:${this.port}/mcp`;
    }

    public dispose(): void {
        void this.disposeAsync();
    }

    public async disposeAsync(): Promise<void> {
        this.disposed = true;
        const child = this.process;
        const controlServer = this.controlServer;
        this.process = undefined;
        this.controlServer = undefined;
        controlServer?.dispose();

        if (!child || !this.ownsProcess) {
            return;
        }

        child.kill();
        // 给进程一点时间自行退出，超时后强杀
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
                resolve();
            }, 2000);
            child.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
