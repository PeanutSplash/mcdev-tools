import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { getNonce } from '../utils';
import { ensureMcdevDirectory } from '../utils/mcdevDirectory';
import { discoverModDirectories } from '../utils/modDiscovery';
import { McdevConfigSnapshot, McdevConfigStore } from '../config';
import {
    getGameExecutablePaths,
    isGameExecutableDiscoverySupported
} from '../native/gameDiscovery';
import { GameProcessMonitor, GameStatus } from '../game';

/**
 * 侧边栏 Webview 提供者，用于可视化编辑 .mcdev.json
 */
export class McDevToolsSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private _view?: vscode.WebviewView;
    private _configSubscription?: vscode.Disposable;
    private _reviewProcess?: cp.ChildProcess;
    private _messageSubscription?: vscode.Disposable;
    private _gameStatusSubscription?: vscode.Disposable;
    private _gameWatch?: vscode.Disposable;
    private _visibilitySubscription?: vscode.Disposable;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _configStore: McdevConfigStore,
        private readonly _gameMonitor: GameProcessMonitor
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView, 
        _context: vscode.WebviewViewResolveContext, 
        _token: vscode.CancellationToken
    ): void {
        try {
            console.log('McDevToolsSidebarProvider.resolveWebviewView called');
            this._view = webviewView;
            const webview = webviewView.webview;

            this.configureWebview(webview);

            webviewView.webview.html = this.getHtmlForWebview(webview);

            // 立即通知前端已注册
            try { 
                webview.postMessage({ type: 'providerRegistered' }); 
            } catch (e) { 
                console.error('postMessage(providerRegistered) failed', e); 
            }

            this.setupMessageHandler(webview);
            this.setupConfigSubscription(webview);
            this.setupGameStatusSubscription(webview);

            // 只在侧边栏可见时观察游戏进程，隐藏时停止轮询
            this.setGameWatchActive(webviewView.visible);
            this._visibilitySubscription?.dispose();
            this._visibilitySubscription = webviewView.onDidChangeVisibility(() => {
                this.setGameWatchActive(webviewView.visible);
                if (webviewView.visible) {
                    this.postGameStatus(webview, this._gameMonitor.currentStatus);
                }
            });

            // Clean up watcher when view is disposed
            webviewView.onDidDispose(() => {
                this.dispose();
            });
        } catch (err) {
            console.error('resolveWebviewView top-level error', err);
        }
    }

    public resolveWebviewPanel(panel: vscode.WebviewPanel): void {
        const webview = panel.webview;
        this.configureWebview(webview);
        webview.html = this.getHtmlForWebview(webview);
        this.setupMessageHandler(webview);
        this.setupConfigSubscription(webview);
        this.setupGameStatusSubscription(webview);
        this.setGameWatchActive(true);
        panel.onDidDispose(() => this.dispose());
    }

    public dispose(): void {
        this._messageSubscription?.dispose();
        this._messageSubscription = undefined;
        this._configSubscription?.dispose();
        this._configSubscription = undefined;
        this._gameStatusSubscription?.dispose();
        this._gameStatusSubscription = undefined;
        this._visibilitySubscription?.dispose();
        this._visibilitySubscription = undefined;
        this.setGameWatchActive(false);
        if (this._reviewProcess && !this._reviewProcess.killed) {
            this._reviewProcess.kill();
        }
        this._reviewProcess = undefined;
    }

    private configureWebview(webview: vscode.Webview): void {
        const roots: vscode.Uri[] = [this._extensionUri];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            roots.push(workspaceFolder.uri);
            try {
                const parsed = path.parse(workspaceFolder.uri.fsPath);
                if (parsed.root) {
                    roots.push(vscode.Uri.file(parsed.root));
                }
            } catch {
                // The extension root remains sufficient if the workspace root cannot be parsed.
            }
        }
        webview.options = { enableScripts: true, localResourceRoots: roots };
    }

    /**
     * 设置消息处理器
     */
    private setupMessageHandler(webview: vscode.Webview): void {
        this._messageSubscription?.dispose();
        this._messageSubscription = webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === 'ready') {
                await this.handleReady(webview);
            } else if (msg?.type === 'save') {
                await this.handleSave(webview, msg.content);
            } else if (msg?.type === 'browseFolder') {
                await this.handleBrowseFolder(webview, msg.index);
            } else if (msg?.type === 'browseSkin') {
                await this.handleBrowseSkin(webview);
            } else if (msg?.type === 'updateSkinPreview') {
                await this.handleUpdateSkinPreview(webview, msg.path);
            } else if (msg?.type === 'runGame') {
                await vscode.commands.executeCommand('mcdev-tools.runGame');
            } else if (msg?.type === 'stopGame') {
                await vscode.commands.executeCommand('mcdev-tools.stopGame');
            } else if (msg?.type === 'startDebug') {
                await vscode.commands.executeCommand('mcdev-tools.startDebug');
            } else if (msg?.type === 'browseGameExecutable') {
                await this.handleBrowseGameExecutable(webview, msg.currentPath);
            } else if (msg?.type === 'getGameExecutablePaths') {
                await this.handleGetGameExecutablePaths(webview);
            } else if (msg?.type === 'getModDirCandidates') {
                await this.handleGetModDirCandidates(webview, msg.refresh === true);
            } else if (msg?.type === 'openExternal') {
                await this.handleOpenExternal(msg.url);
            } else if (msg?.type === 'runCodeReview') {
                await this.handleCodeReview(webview, msg);
            } else if (msg?.type === 'openReviewReport') {
                await this.handleOpenReviewReport(msg.path);
            } else if (msg?.type === 'openGameDebugger') {
                await vscode.commands.executeCommand('mcdev-tools.openGameDebugger');
            } else if (msg?.type === 'log') {
                const prefix = `[Webview ${msg.level || 'log'}]`;
                if (msg.level === 'error') {
                    console.error(prefix, ...msg.args);
                } else if (msg.level === 'warn') {
                    console.warn(prefix, ...msg.args);
                } else {
                    console.log(prefix, ...msg.args);
                }
            }
        });
    }

    /**
     * 订阅游戏运行状态，变化时推送给 Webview
     */
    private setupGameStatusSubscription(webview: vscode.Webview): void {
        this._gameStatusSubscription?.dispose();
        this._gameStatusSubscription = this._gameMonitor.onDidChangeStatus(status => {
            this.postGameStatus(webview, status);
        });
    }

    /**
     * 按需开关游戏进程轮询
     */
    private setGameWatchActive(active: boolean): void {
        if (active) {
            this._gameWatch ??= this._gameMonitor.watch();
            return;
        }
        this._gameWatch?.dispose();
        this._gameWatch = undefined;
    }

    private postGameStatus(webview: vscode.Webview, status: GameStatus): void {
        void webview.postMessage({
            type: 'gameStatus',
            state: status.state,
            processCount: status.processCount
        });
    }

    /**
     * 处理 ready 消息
     */
    private async handleReady(webview: vscode.Webview): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const language = vscode.env.language; // 获取 VS Code 语言设置

        this.postGameStatus(webview, this._gameMonitor.currentStatus);

        if (!workspaceFolder) {
            webview.postMessage({
                type: 'init',
                content: '{}',
                language,
                gameExecutableDiscoverySupported: isGameExecutableDiscoverySupported
            });
            return;
        }

        try {
            const snapshot = await this._configStore.getSnapshot(workspaceFolder.uri.fsPath);
            await this.postConfig(webview, workspaceFolder, snapshot, {
                language,
                needsInitialSave: !snapshot.exists
            });
        } catch (e) {
            webview.postMessage({
                type: 'init',
                content: '{}',
                error: String(e),
                language,
                gameExecutableDiscoverySupported: isGameExecutableDiscoverySupported
            });
        }
    }

    /**
     * 处理 save 消息
     */
    private async handleSave(webview: vscode.Webview, content: string): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开工作区以保存 .mcdev.json');
            return;
        }
        try {
            await this._configStore.write(workspaceFolder.uri.fsPath, content);
            await webview.postMessage({ type: 'saved' });
            vscode.window.showInformationMessage('.mcdev.json 已保存');
        } catch (e) {
            vscode.window.showErrorMessage(`保存 .mcdev.json 失败: ${e}`);
        }
    }

    /**
     * 处理 browseFolder 消息
     */
    private async handleBrowseFolder(webview: vscode.Webview, index: number): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择 MOD 目录',
            title: '选择 MOD 目录'
        });
        if (result && result.length > 0) {
            webview.postMessage({ 
                type: 'folderSelected', 
                index: index,
                path: result[0].fsPath 
            });
        }
    }

    /**
     * 处理皮肤文件选择
     */
    private async handleBrowseSkin(webview: vscode.Webview): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: '选择皮肤 PNG 文件',
            title: '选择皮肤 PNG 文件',
            filters: {
                'PNG Images': ['png'],
                'All Files': ['*']
            }
        });

        if (result && result.length > 0) {
            const fileUri = result[0];
            const webviewUri = webview.asWebviewUri(fileUri);

            webview.postMessage({
                type: 'skinSelected',
                path: fileUri.fsPath,
                previewUri: webviewUri.toString()
            });
        }
    }

    /**
     * 根据给定路径更新皮肤预览（不修改配置文件）
     */
    private async handleUpdateSkinPreview(webview: vscode.Webview, skinPath: string | undefined): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        if (!skinPath || !skinPath.trim()) {
            webview.postMessage({ type: 'skinPreview', previewUri: undefined });
            return;
        }

        try {
            let filePath = skinPath;
            if (!path.isAbsolute(filePath)) {
                filePath = path.join(workspaceFolder.uri.fsPath, filePath);
            }
            const fileUri = vscode.Uri.file(filePath);
            const webviewUri = webview.asWebviewUri(fileUri);
            webview.postMessage({ type: 'skinPreview', previewUri: webviewUri.toString() });
        } catch (e) {
            console.error('Failed to build skin preview URI:', e);
            webview.postMessage({ type: 'skinPreview', previewUri: undefined });
        }
    }

    /**
     * 处理浏览游戏可执行文件路径
     */
    private async handleBrowseGameExecutable(webview: vscode.Webview, currentPath?: string): Promise<void> {
        let defaultUri: vscode.Uri | undefined;
        if (currentPath && currentPath.trim()) {
            try {
                const parentDir = path.dirname(currentPath.trim());
                if (parentDir && fs.existsSync(parentDir)) {
                    defaultUri = vscode.Uri.file(parentDir);
                }
            } catch {
                // ignore invalid path
            }
        }

        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri,
            openLabel: '选择 Minecraft 可执行文件',
            title: '选择 Minecraft.Windows.exe',
            filters: {
                'Executable': ['exe'],
                'All Files': ['*']
            }
        });

        if (result && result.length > 0) {
            webview.postMessage({
                type: 'gameExecutableSelected',
                path: result[0].fsPath
            });
        }
    }

    private async handleGetGameExecutablePaths(webview: vscode.Webview): Promise<void> {
        if (!isGameExecutableDiscoverySupported) {
            return;
        }

        try {
            const paths = await getGameExecutablePaths(this._extensionUri.fsPath);
            await webview.postMessage({ type: 'gameExecutablePaths', paths });
        } catch (error) {
            console.error('Failed to discover game executable paths:', error);
            await webview.postMessage({ type: 'gameExecutablePaths', paths: [] });
        }
    }

    /**
     * 扫描工作区并返回可选的 MOD 目录
     */
    private async handleGetModDirCandidates(webview: vscode.Webview, refresh: boolean): Promise<void> {
        const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        try {
            const candidates = await discoverModDirectories(roots, { refresh });
            await webview.postMessage({ type: 'modDirCandidates', candidates });
        } catch (error) {
            console.error('Failed to discover mod directories:', error);
            await webview.postMessage({ type: 'modDirCandidates', candidates: [] });
        }
    }

    /**
     * 打开外部链接
     */
    private async handleOpenExternal(url: string | undefined): Promise<void> {
        if (!url || typeof url !== 'string') {
            return;
        }

        const uri = vscode.Uri.parse(url);
        if (uri.scheme === 'https' || uri.scheme === 'http') {
            await vscode.env.openExternal(uri);
        }
    }

    private async handleCodeReview(webview: vscode.Webview, message: any): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const targetId = typeof message?.targetId === 'string' ? message.targetId : '';
        const sendStatus = (status: string, extra: Record<string, unknown> = {}) => {
            webview.postMessage({ type: 'codeReviewStatus', targetId, status, ...extra });
        };

        if (!workspaceFolder || !targetId || typeof message?.targetPath !== 'string') {
            sendStatus('error');
            vscode.window.showErrorMessage('无法启动代码诊断：工作区或目标路径无效。');
            return;
        }

        if (this._reviewProcess && !this._reviewProcess.killed) {
            sendStatus('error');
            vscode.window.showWarningMessage('已有代码诊断任务正在运行。');
            return;
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        const targetPath = path.isAbsolute(message.targetPath)
            ? path.resolve(message.targetPath)
            : path.resolve(workspacePath, message.targetPath);
        const executablePath = vscode.Uri.joinPath(
            this._extensionUri,
            'bin',
            'mcdk-python-review.exe'
        ).fsPath;
        const reportDirectory = path.resolve(workspacePath, '.mcdev', 'reviews');
        const requestedName = typeof message.outputPath === 'string'
            ? path.basename(message.outputPath)
            : 'python-review.md';
        const safeName = requestedName
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
            .replace(/[. ]+$/g, '') || 'python-review.md';
        const reportName = safeName.toLowerCase().endsWith('.md')
            ? safeName
            : `${safeName}.md`;
        const reportPath = path.join(reportDirectory, reportName);

        try {
            if (!fs.existsSync(executablePath)) {
                throw new Error(`诊断工具不存在: ${executablePath}`);
            }
            if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
                throw new Error(`目标目录不存在: ${targetPath}`);
            }
            await ensureMcdevDirectory(workspacePath);
        } catch (error) {
            sendStatus('error');
            vscode.window.showErrorMessage(`无法启动代码诊断：${String(error)}`);
            return;
        }

        const args = [
            targetPath,
            '--format',
            'markdown',
            '--output',
            reportPath,
        ];
        let stderr = '';
        let finished = false;

        try {
            const child = cp.spawn(executablePath, args, {
                cwd: workspacePath,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this._reviewProcess = child;
            sendStatus('running');

            child.stderr.on('data', (chunk: Buffer) => {
                if (stderr.length < 32768) stderr += chunk.toString('utf8');
            });

            child.once('error', (error) => {
                if (finished) return;
                finished = true;
                this._reviewProcess = undefined;
                sendStatus('error');
                vscode.window.showErrorMessage(`代码诊断启动失败：${error.message}`);
            });

            child.once('close', (code) => {
                if (finished) return;
                finished = true;
                this._reviewProcess = undefined;

                if (code !== 0) {
                    sendStatus('error');
                    const detail = stderr.trim() || `退出码 ${code ?? 'unknown'}`;
                    vscode.window.showErrorMessage(`代码诊断失败：${detail}`);
                    return;
                }

                try {
                    const report = fs.readFileSync(reportPath, 'utf8');
                    const overview = report.match(
                        /^\|\s*\*\*\d+\*\*[^|]*\|\s*\*\*\d+\*\*[^|]*\|\s*\*\*(\d+)\*\*/m
                    );
                    if (!overview) {
                        throw new Error('无法从 Markdown 概览中解析诊断数量。');
                    }
                    const issueCount = Number.parseInt(overview[1], 10);
                    sendStatus(issueCount > 0 ? 'issues' : 'clean', {
                        issueCount,
                        outputPath: reportPath,
                    });
                } catch (error) {
                    sendStatus('error');
                    vscode.window.showErrorMessage(`诊断报告读取失败：${String(error)}`);
                }
            });
        } catch (error) {
            this._reviewProcess = undefined;
            sendStatus('error');
            vscode.window.showErrorMessage(`代码诊断启动失败：${String(error)}`);
        }
    }

    private async handleOpenReviewReport(reportPath: string | undefined): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || !reportPath || typeof reportPath !== 'string') {
            return;
        }

        const reportsRoot = path.resolve(workspaceFolder.uri.fsPath, '.mcdev', 'reviews');
        const resolvedReport = path.resolve(reportPath);
        if (
            resolvedReport !== reportsRoot &&
            !resolvedReport.startsWith(`${reportsRoot}${path.sep}`)
        ) {
            vscode.window.showErrorMessage('拒绝打开工作区诊断目录之外的文件。');
            return;
        }
        if (!fs.existsSync(resolvedReport) || path.extname(resolvedReport).toLowerCase() !== '.md') {
            vscode.window.showErrorMessage('诊断报告不存在。');
            return;
        }

        const document = await vscode.workspace.openTextDocument(resolvedReport);
        await vscode.window.showTextDocument(document, { preview: true });
    }

    private setupConfigSubscription(webview: vscode.Webview): void {
        this._configSubscription?.dispose();
        this._configSubscription = undefined;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const currentWorkspacePath = normalizeWorkspacePath(workspaceFolder.uri.fsPath);
        this._configSubscription = this._configStore.onDidChange(async workspacePath => {
            if (normalizeWorkspacePath(workspacePath) !== currentWorkspacePath) {
                return;
            }
            try {
                const snapshot = await this._configStore.getSnapshot(workspaceFolder.uri.fsPath);
                await this.postConfig(webview, workspaceFolder, snapshot);
            } catch (error) {
                console.error('Error refreshing shared .mcdev.json configuration:', error);
            }
        });
    }

    private async postConfig(
        webview: vscode.Webview,
        workspaceFolder: vscode.WorkspaceFolder,
        snapshot: McdevConfigSnapshot,
        options: { language?: string; needsInitialSave?: boolean } = {}
    ): Promise<void> {
        const skinPath = snapshot.config.skin_info?.skin;
        let skinPreviewUri: string | undefined;
        if (typeof skinPath === 'string' && skinPath.trim()) {
            const filePath = path.isAbsolute(skinPath)
                ? skinPath
                : path.join(workspaceFolder.uri.fsPath, skinPath);
            skinPreviewUri = webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
        }

        await webview.postMessage({
            type: 'init',
            content: JSON.stringify(snapshot.config),
            language: options.language,
            needsInitialSave: options.needsInitialSave,
            skinPreviewUri,
            gameExecutableDiscoverySupported: isGameExecutableDiscoverySupported
        });
    }

    /**
     * 获取 Webview HTML
     */
    public getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const vscodeLanguage = vscode.env.language;
        const lang = (vscodeLanguage && vscodeLanguage.startsWith('zh')) ? 'zh' : 'en';

        // Get URIs for built webview assets
        const webviewPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'sidebar.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'sidebar.css'));
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'codicons', 'codicon.css'));

        return `<!doctype html>
<html lang="${lang}">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MC Dev Tools</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function normalizeWorkspacePath(workspacePath: string): string {
    const normalized = path.normalize(workspacePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
