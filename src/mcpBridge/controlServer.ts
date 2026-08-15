/**
 * MCP 桥接工具的游戏生命周期控制通道
 *
 * mcdk_stdio_bridge 自己 spawn mcdk 时只能开新控制台，也看不到插件已经拉起的会话。
 * 这里在插件里开一个仅监听回环、带 token 的小 HTTP 服务，让桥接工具把 start/stop
 * 交回插件执行：先停掉旧会话，再在 VS Code 集成终端里启动，和侧边栏按钮完全一致。
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';

/** 由插件提供的实际动作 */
export interface GameLifecycleController {
    /** 停掉当前会话（若有），再在集成终端里启动一个新的 */
    start(): Promise<void>;
    /** 结束 mcdk 与 Minecraft 进程 */
    stop(): Promise<void>;
}

/** 请求体只用于占位，限制大小防止异常输入撑爆内存 */
const MAX_REQUEST_BODY_BYTES = 4096;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(address: string | undefined): boolean {
    return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

function tokensMatch(expected: string, candidate: string): boolean {
    const expectedBytes = Buffer.from(expected, 'utf8');
    const candidateBytes = Buffer.from(candidate, 'utf8');
    if (expectedBytes.length !== candidateBytes.length) {
        return false;
    }
    return crypto.timingSafeEqual(expectedBytes, candidateBytes);
}

function readBearerToken(request: http.IncomingMessage): string | undefined {
    const header = request.headers['authorization'];
    if (typeof header !== 'string') {
        return undefined;
    }
    const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
    return matched ? matched[1] : undefined;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
    });
    response.end(payload);
}

function drainRequest(request: http.IncomingMessage): void {
    let received = 0;
    request.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_REQUEST_BODY_BYTES) {
            request.destroy();
        }
    });
}

export class McpControlServer implements vscode.Disposable {
    private server: http.Server | undefined;
    /** 串行化生命周期操作，避免 AI 连点 start 时并发拉起多个会话 */
    private queue: Promise<void> = Promise.resolve();

    private constructor(
        server: http.Server,
        private readonly boundPort: number,
        private readonly authToken: string,
        private readonly controller: GameLifecycleController
    ) {
        this.server = server;
        server.on('request', (request, response) => this.handleRequest(request, response));
    }

    /**
     * 在回环地址上开一个随机端口。失败返回 undefined，桥接工具会退回自行 spawn。
     */
    public static async create(controller: GameLifecycleController): Promise<McpControlServer | undefined> {
        const server = http.createServer();
        const token = crypto.randomBytes(32).toString('hex');

        try {
            const port = await new Promise<number>((resolve, reject) => {
                const handleError = (error: Error) => {
                    server.off('listening', handleListening);
                    reject(error);
                };
                const handleListening = () => {
                    server.off('error', handleError);
                    const address = server.address();
                    if (!address || typeof address === 'string') {
                        reject(new Error('控制通道未能拿到 TCP 端口'));
                        return;
                    }
                    resolve(address.port);
                };
                server.once('error', handleError);
                server.once('listening', handleListening);
                server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
            });
            server.unref();
            return new McpControlServer(server, port, token, controller);
        } catch (error) {
            console.error('MCP 生命周期控制通道启动失败', error);
            server.close();
            return undefined;
        }
    }

    public get port(): number {
        return this.boundPort;
    }

    public get token(): string {
        return this.authToken;
    }

    public dispose(): void {
        const server = this.server;
        this.server = undefined;
        server?.close();
    }

    private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
        drainRequest(request);

        if (!isLoopback(request.socket.remoteAddress)) {
            sendJson(response, 403, { ok: false, message: '仅接受本机回环请求' });
            return;
        }

        const token = readBearerToken(request);
        if (!token || !tokensMatch(this.authToken, token)) {
            sendJson(response, 401, { ok: false, message: '控制通道鉴权失败' });
            return;
        }

        if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, message: '仅支持 POST' });
            return;
        }

        const route = (request.url ?? '').split('?')[0];
        if (route !== '/game/start' && route !== '/game/stop') {
            sendJson(response, 404, { ok: false, message: `未知控制路由: ${route}` });
            return;
        }

        const action = route === '/game/start'
            ? () => this.controller.start()
            : () => this.controller.stop();

        this.enqueue(action).then(
            () => sendJson(response, 200, { ok: true }),
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                sendJson(response, 500, { ok: false, message });
            }
        );
    }

    private enqueue(action: () => Promise<void>): Promise<void> {
        const result = this.queue.then(action, action);
        // 队列本身要保持 resolved，否则一次失败会卡死后续请求
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
