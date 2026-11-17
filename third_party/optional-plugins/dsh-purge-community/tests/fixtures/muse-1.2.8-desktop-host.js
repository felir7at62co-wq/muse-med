var DesktopHostProcess = class {
	node;
	runtimeDir;
	projectDir;
	inspectPort;
	environment;
	onFailure;
	primaryRuntime;
	packageManager;
	onPlatformSession;
	onAttentionSound;
	onDouyinRequest;
	onDouyinDisconnect;
	onDouyinDataRequest;
	onComputerUseState;
	/** @param taskId - main-owned task revoked by navigation, lifetime or cancellation. */
	notifyDouyinRevoked(taskId, code) {
		if (this.child?.connected) this.child.send({
			type: "douyin-browser-revoked",
			taskId,
			code
		});
	}
	child;
	readyResolve;
	readyReject;
	readyPromise = new Promise((resolve, reject) => {
		this.readyResolve = resolve;
		this.readyReject = reject;
	});
	exitPromise;
	stderr = "";
	failureReported = false;
	stopping = false;
	shutdownCompleted = false;
	douyinCleanup;
	nextControlId = 1;
	controlRequests = /* @__PURE__ */ new Map();
	/**
	* @param node - Absolute Electron executable in Node mode.
	* @param runtimeDir - Immutable packages carried by the current application.
	* @param projectDir - Desktop plugin profile and child working directory.
	* @param inspectPort - Optional loopback inspector port for workspace development.
	* @param environment - Environment inherited by the Host and its plugin subprocesses.
	* @param onFailure - Receives the first unexpected child failure, including after readiness.
	* @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
	*   `office-skills` resources fail Host startup.
	* @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
	* @param onPlatformSession - Private credential updates for embedded Platform views.
	* @param onAttentionSound - A live user-owned turn or question needs an audible cue.
	*/
	constructor(node, runtimeDir, projectDir, inspectPort, environment = process.env, onFailure, primaryRuntime, packageManager, onPlatformSession, onAttentionSound, onDouyinRequest, onDouyinDisconnect, onDouyinDataRequest, onComputerUseState) {
		this.node = node;
		this.runtimeDir = runtimeDir;
		this.projectDir = projectDir;
		this.inspectPort = inspectPort;
		this.environment = environment;
		this.onFailure = onFailure;
		this.primaryRuntime = primaryRuntime;
		this.packageManager = packageManager;
		this.onPlatformSession = onPlatformSession;
		this.onAttentionSound = onAttentionSound;
		this.onDouyinRequest = onDouyinRequest;
		this.onDouyinDisconnect = onDouyinDisconnect;
		this.onDouyinDataRequest = onDouyinDataRequest;
		this.onComputerUseState = onComputerUseState;
	}
	/**
	* Start this child once and await its Web application URL.
	* @returns Ready facts supplied by the child after application startup.
	*/
	async start() {
		if (this.child !== void 0) return this.readyPromise;
		const entry = join(this.runtimeDir, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");
		const child = spawn(this.node, [
			"--expose-internals",
			...this.inspectPort === void 0 ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`],
			entry,
			this.runtimeDir,
			this.projectDir,
			this.primaryRuntime ?? join(this.runtimeDir, "..", "runtime", "primary-runtime"),
			...this.packageManager === void 0 ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
			...this.inspectPort === void 0 ? [] : ["--allow-linked-profile"]
		], {
			cwd: this.projectDir,
			env: desktopNodeEnvironment(this.node, void 0, this.environment),
			stdio: [
				"ignore",
				"pipe",
				"pipe",
				"ipc"
			],
			windowsHide: true
		});
		this.child = child;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-65536);
		});
		child.stdout?.pipe(process.stdout);
		child.on("message", (message) => {
			if (typeof message === "object" && message !== null && "type" in message && message.type === "computer-use-state" && "requestId" in message && Number.isSafeInteger(message.requestId) && "state" in message && (message.state === "active" || message.state === "paused" || message.state === "idle")) {
				const { requestId, state } = message;
				(async () => {
					let ok = false;
					try {
						if (this.onComputerUseState === void 0 || this.stopping) throw new Error("Computer-use indicator unavailable");
						await this.onComputerUseState(state);
						ok = true;
					} catch (error) {
						console.warn("Computer-use indicator failed:", error);
					}
					if (child.connected) child.send({
						type: "computer-use-state-ready",
						requestId,
						ok
					});
				})();
				return;
			}
			const dataRequest = parseDouyinDataRequest(message);
			if (dataRequest !== void 0) {
				(async () => {
					let result;
					try {
						result = await this.onDouyinDataRequest?.(dataRequest) ?? {
							type: "douyin-browser-data-result",
							requestId: dataRequest.requestId,
							code: "HOST_UNAVAILABLE"
						};
					} catch (_error) {
						result = {
							type: "douyin-browser-data-result",
							requestId: dataRequest.requestId,
							code: "HOST_UNAVAILABLE"
						};
					}
					if (child.connected) child.send(result);
				})().catch(() => {
					this.disconnectDouyin();
				});
				return;
			}
			const downloadRequest = parseDouyinRequest(message);
			if (downloadRequest !== void 0) {
				(async () => {
					let result;
					try {
						result = await this.onDouyinRequest?.(downloadRequest) ?? {
							type: "douyin-browser-result",
							requestId: downloadRequest.requestId,
							code: "HOST_UNAVAILABLE"
						};
					} catch (_error) {
						result = {
							type: "douyin-browser-result",
							requestId: downloadRequest.requestId,
							code: "HOST_UNAVAILABLE"
						};
					}
					if (child.connected) child.send(result);
				})().catch(() => {
					this.disconnectDouyin();
				});
				return;
			}
			if (!isDesktopHostEvent(message)) {
				this.fail(/* @__PURE__ */ new Error("muse-med host sent an invalid IPC event"));
				child.kill("SIGTERM");
				return;
			}
			if (message.type === "ready") {
				if (child.pid === void 0) {
					this.fail(/* @__PURE__ */ new Error("muse-med host reached ready without a process id"));
					return;
				}
				this.readyResolve({
					pid: child.pid,
					url: message.url,
					injections: message.injections
				});
			} else if (message.type === "platform-session") this.onPlatformSession?.(message.session);
			else if (message.type === "attention-sound") this.onAttentionSound?.(message.kind);
			else if (message.type === "shutdown-complete") if (this.stopping) this.shutdownCompleted = true;
			else this.fail(/* @__PURE__ */ new Error("muse-med host acknowledged an unrequested shutdown"));
			else if (message.type === "fatal") this.fail(new DesktopHostFatalError(message.message, message.diagnostic));
			else {
				const request = this.controlRequests.get(message.requestId);
				if (message.error === void 0) request?.resolve(message);
				else request?.reject(new Error(message.error));
			}
		});
		child.once("error", (error) => {
			this.fail(error);
		});
		this.exitPromise = new Promise((resolve) => {
			child.once("disconnect", () => {
				this.disconnectDouyin();
			});
			child.once("close", () => {
				this.disconnectDouyin();
			});
			child.once("close", (code) => {
				const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;
				if (code !== 0 && code !== null) this.fail(/* @__PURE__ */ new Error(`muse-med host exited with ${String(code)}${suffix}`));
				else this.fail(/* @__PURE__ */ new Error(`muse-med host stopped${suffix}`));
				resolve();
			});
		});
		return this.readyPromise;
	}
	/**
	* Inspect active work or lock request admission for update handoff.
	* @param action - Read-only inspection, admission lock, or recovery unlock.
	* @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
	* an unanswered drain fails at the control-request deadline without authorizing installation.
	*/
	async updateTasks(action) {
		const response = await this.control({
			type: "update-tasks",
			action
		}, 1e4, `desktop update: task ${action} timed out`);
		if (response.type !== "update-tasks") throw new Error("desktop update: Host answered with a different control response");
		return response.active;
	}
	/**
	* Ask the Host what quitting now would interrupt.
	* @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
	* {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
	*/
	async inspectQuit() {
		const response = await this.control({ type: "quit-inspection" }, QUIT_INSPECTION_DEADLINE_MS, "desktop quit: inspection timed out");
		if (response.type !== "quit-inspection") throw new Error("desktop quit: Host answered with a different control response");
		return {
			activeTasks: response.activeTasks,
			scheduledTasks: response.scheduledTasks
		};
	}
	async control(request, deadlineMs, deadlineMessage) {
		const child = this.child;
		if (child === void 0 || !child.connected || this.failureReported || this.stopping) throw new Error(`${request.type === "update-tasks" ? "desktop update" : "desktop quit"}: Host is unavailable`);
		const requestId = this.nextControlId++;
		let timer;
		try {
			return await new Promise((resolve, reject) => {
				this.controlRequests.set(requestId, {
					resolve,
					reject
				});
				timer = setTimeout(() => {
					reject(new Error(deadlineMessage));
				}, deadlineMs);
				child.send({
					...request,
					requestId
				}, (error) => {
					if (error !== null) reject(error);
				});
			});
		} finally {
			clearTimeout(timer);
			this.controlRequests.delete(requestId);
		}
	}
	/**
	* Request teardown and await child exit, escalating termination when needed.
	* @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
	* @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
	* other failures do not confirm exit.
	*/
	async stop(requireGraceful = false) {
		const child = this.child;
		if (child === void 0) {
			await this.douyinCleanup;
			return;
		}
		this.stopping = true;
		this.onPlatformSession?.(null);
		if (child.connected) child.send({ type: "shutdown" }, (error) => {
			if (error !== null) this.fail(error);
		});
		const exited = this.exitPromise ?? Promise.resolve();
		const graceful = await exitsWithin(exited, DESKTOP_HOST_SHUTDOWN_DEADLINE_MS);
		if (!graceful) child.kill("SIGTERM");
		if (!await exitsWithin(exited, 5e3)) {
			child.kill("SIGKILL");
			if (!await exitsWithin(exited, 5e3)) throw new Error("muse-med host did not exit after SIGKILL");
		}
		this.child = void 0;
		this.disconnectDouyin();
		await this.douyinCleanup;
		if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`);
	}
	disconnectDouyin() {
		if (this.douyinCleanup !== void 0) return;
		this.douyinCleanup = Promise.resolve().then(() => this.onDouyinDisconnect?.());
		this.douyinCleanup.catch(() => {
			this.fail(/* @__PURE__ */ new Error("desktop download cleanup failed"));
		});
	}
	fail(error) {
		this.onPlatformSession?.(null);
		this.readyReject(error);
		for (const request of this.controlRequests.values()) request.reject(error);
		this.controlRequests.clear();
		if (!this.failureReported && !this.stopping) {
			this.failureReported = true;
			try {
				this.onFailure?.(error);
			} catch (listenerError) {
				console.error("desktop host failure listener failed", listenerError);
			}
		}
	}
};
