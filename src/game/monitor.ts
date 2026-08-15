/**
 * 游戏运行状态监视器
 * 侧边栏据此在「运行游戏」与「停止游戏」之间切换
 */

import * as vscode from 'vscode';
import { findMcdkProcesses, findMinecraftProcesses, terminateProcessTree } from './minecraftProcess';

export type GameRunState = 'stopped' | 'launching' | 'running';

export interface GameStatus {
    state: GameRunState;
    processCount: number;
}

/** 常规轮询间隔 */
const POLL_INTERVAL_MS = 2000;

/** 启动过程中的轮询间隔，让状态尽快跟上 */
const LAUNCHING_POLL_INTERVAL_MS = 800;

/** 等待进程退出的轮询间隔与上限 */
const STOP_WAIT_INTERVAL_MS = 300;
const STOP_WAIT_TIMEOUT_MS = 15000;

export class GameProcessMonitor implements vscode.Disposable {
    private readonly statusEmitter = new vscode.EventEmitter<GameStatus>();
    private readonly terminalSubscription: vscode.Disposable;
    private readonly launchTerminals = new Set<vscode.Terminal>();
    private status: GameStatus = { state: 'stopped', processCount: 0 };
    private timer: NodeJS.Timeout | undefined;
    private refreshing = false;
    private watchers = 0;
    private disposed = false;

    public readonly onDidChangeStatus = this.statusEmitter.event;

    constructor() {
        this.terminalSubscription = vscode.window.onDidCloseTerminal(terminal => {
            if (this.launchTerminals.delete(terminal)) {
                void this.refresh();
            }
        });
    }

    public get currentStatus(): GameStatus {
        return this.status;
    }

    /**
     * 声明一个状态观察者（如可见的侧边栏）。
     * 没有观察者、也没有游戏在跑时不进行轮询。
     */
    public watch(): vscode.Disposable {
        if (this.disposed) {
            return new vscode.Disposable(() => undefined);
        }
        this.watchers += 1;
        void this.refresh();
        this.scheduleNext();

        let released = false;
        return new vscode.Disposable(() => {
            if (released) {
                return;
            }
            released = true;
            this.watchers = Math.max(0, this.watchers - 1);
            this.scheduleNext();
        });
    }

    /**
     * 记录一次由插件发起的启动，终端存活期间视为「启动中」
     */
    public trackLaunch(terminal: vscode.Terminal): void {
        if (this.disposed) {
            return;
        }
        this.launchTerminals.add(terminal);
        this.applyProcessCount(this.status.processCount);
        void this.refresh();
    }

    /**
     * 结束游戏：先终止插件启动的 mcdk 进程树，再清理残留的 mcdk 与游戏进程
     *
     * mcdk 要排在 Minecraft 前面结束，否则它会把游戏进程的退出当成重启信号再拉一个起来。
     */
    public async stopGame(): Promise<void> {
        const terminals = [...this.launchTerminals];
        this.launchTerminals.clear();

        for (const terminal of terminals) {
            const pid = await terminal.processId;
            if (pid !== undefined) {
                try {
                    await terminateProcessTree(pid);
                } catch (error) {
                    console.warn('结束 mcdk 进程树失败', error);
                }
            }
            terminal.dispose();
        }

        // 桥接工具冷启动或上次会话遗留的 mcdk 没有终端归属，只能按映像名清理
        for (const target of await findMcdkProcesses()) {
            try {
                await terminateProcessTree(target.pid);
            } catch (error) {
                console.warn(`结束 mcdk 进程 ${target.pid} 失败`, error);
            }
        }

        for (const target of await findMinecraftProcesses()) {
            try {
                await terminateProcessTree(target.pid);
            } catch (error) {
                console.warn(`结束 Minecraft 进程 ${target.pid} 失败`, error);
            }
        }

        await this.refresh();
    }

    /**
     * 等待游戏进程真正消失。返回 false 表示超时仍有残留。
     */
    public async waitUntilStopped(timeoutMs = STOP_WAIT_TIMEOUT_MS): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if ((await findMinecraftProcesses()).length === 0 && (await findMcdkProcesses()).length === 0) {
                await this.refresh();
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, STOP_WAIT_INTERVAL_MS));
        }
        await this.refresh();
        return (await findMinecraftProcesses()).length === 0;
    }

    public dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.launchTerminals.clear();
        this.terminalSubscription.dispose();
        this.statusEmitter.dispose();
    }

    private async refresh(): Promise<void> {
        if (this.disposed || this.refreshing) {
            return;
        }
        this.refreshing = true;
        try {
            const processes = await findMinecraftProcesses();
            this.applyProcessCount(processes.length);
        } catch (error) {
            console.warn('检测 Minecraft 进程失败', error);
        } finally {
            this.refreshing = false;
        }
    }

    private applyProcessCount(count: number): void {
        const state: GameRunState = count > 0
            ? 'running'
            : this.launchTerminals.size > 0
                ? 'launching'
                : 'stopped';
        this.setStatus({ state, processCount: count });
    }

    private setStatus(next: GameStatus): void {
        const stateChanged = next.state !== this.status.state;
        if (!stateChanged && next.processCount === this.status.processCount) {
            return;
        }
        this.status = next;
        if (stateChanged) {
            void vscode.commands.executeCommand(
                'setContext',
                'mcdev-tools:gameRunning',
                next.state !== 'stopped'
            );
        }
        this.statusEmitter.fire(next);
        this.scheduleNext();
    }

    private scheduleNext(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (this.disposed || !this.shouldPoll()) {
            return;
        }
        const interval = this.status.state === 'launching'
            ? LAUNCHING_POLL_INTERVAL_MS
            : POLL_INTERVAL_MS;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().finally(() => this.scheduleNext());
        }, interval);
        this.timer.unref?.();
    }

    /** 游戏在跑或正在启动时保持轮询，否则只在有观察者时轮询 */
    private shouldPoll(): boolean {
        return this.watchers > 0
            || this.launchTerminals.size > 0
            || this.status.state !== 'stopped';
    }
}
