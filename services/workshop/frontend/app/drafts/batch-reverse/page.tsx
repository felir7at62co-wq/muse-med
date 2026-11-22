"use client";
/**
 * 批量文件夹视频反推
 *
 * 用户选一个根文件夹, 结构固定为:
 *
 *     大文件夹 / 剧名 / 01.mp4, 02.mp4, ...
 *
 * 每个子文件夹 = 一个独立草稿。后端 `POST /v1/video/from-oss` 本来就是
 * 「一次调用 = 一个草稿」, 所以这里做的事就是: 分组 → 排集号 → 传文件 →
 * 每传完一个剧就立刻提交一次。**后端零改动。**
 *
 * ⚠ 与单个反推弹窗最大的行为差异: **提交成功后不跳页**。
 * `_VideoUploadModal` 末尾会 `router.push('/drafts/<id>')`, 那在批量场景下
 * 等于把整个批次打断, 所以这里只在卡片上给一个链接。
 *
 * ⚙️ 并发: 本页不改任何既有并发默认值。
 *   - 单文件内部的 4 分片并发 (ossUpload) 不动
 *   - 集内并发沿用 from-oss 的 1-5, 默认 1 (串行, 让后一集能看到前一集认出的人物)
 *   - 「同时上传几个文件」是本页新增的用户可控档位, **默认 1 = 与现状一致**
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { FolderOpen, Play, Square, ArrowLeft, Info, Trash2 } from "lucide-react";
import { authFetch, getToken } from "@/lib/auth";
import { uploadToOss, formatBytes, type UploadController } from "@/lib/ossUpload";
import {
  groupByFolder, renumber, UNGROUPED_TITLE,
  type DramaGroup, type ParsedEpisode,
} from "@/lib/episodeOrder";
import {
  loadBatch, saveBatch, clearBatch, hasUnfinished, buildRecoveryIndex, recoveryKey,
  type StoredBatch,
} from "@/lib/batchReverseStore";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { notify, notifyError, notifySuccess, confirmAsync } from "@/lib/dialog";
import { DramaCard, type DramaRuntime } from "./_DramaCard";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

function emptyRuntime(): DramaRuntime {
  return { status: "pending", episodes: {} };
}

export default function BatchReversePage() {
  const folderRef = useRef<HTMLInputElement>(null);

  const [groups, setGroups] = useState<DramaGroup[]>([]);
  const [rootName, setRootName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runtime, setRuntime] = useState<Record<string, DramaRuntime>>({});
  const [running, setRunning] = useState(false);
  const [uploadLimit, setUploadLimit] = useState(1);
  const [episodeConcurrency, setEpisodeConcurrency] = useState(1);
  const [pendingBatch, setPendingBatch] = useState<StoredBatch | null>(null);

  // ── 权威可变状态放 ref, React state 只用来触发渲染 ──
  // 上传池是并发的, 直接读 state 会读到旧值 (闭包快照), 必须走 ref。
  const groupsRef = useRef<DramaGroup[]>([]);
  const runtimeRef = useRef<Record<string, DramaRuntime>>({});
  const ctrlsRef = useRef<Map<string, UploadController>>(new Map());
  const stopRef = useRef(false);

  groupsRef.current = groups;

  const flushRuntime = useCallback(() => {
    setRuntime({ ...runtimeRef.current });
  }, []);

  // ── 上次未完成的批次 ──
  useEffect(() => {
    const b = loadBatch();
    if (hasUnfinished(b)) setPendingBatch(b);
  }, []);

  // ── 批次进行中拦一下关页 ──
  useEffect(() => {
    if (!running) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [running]);

  // ── 把当前进度写回 localStorage ──
  const persist = useCallback(() => {
    const batch: StoredBatch = {
      batchId: String(Date.now()),
      createdAt: Date.now(),
      rootName,
      dramas: groupsRef.current.map((g) => {
        const rt = runtimeRef.current[g.title] ?? emptyRuntime();
        return {
          title: g.title,
          status: rt.status,
          draftId: rt.draftId,
          error: rt.error,
          files: g.episodes.map((e) => ({
            relPath: e.relPath,
            size: e.size,
            epNo: e.epNo ?? 0,
            uploadId: rt.episodes[e.relPath]?.uploadId,
          })),
        };
      }),
    };
    saveBatch(batch);
  }, [rootName]);

  // ── 选文件夹 ──
  function handleFolderPicked(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;

    const first = fileList[0] as any;
    const root = String(first.webkitRelativePath || "").split("/")[0] || "";
    const gs = groupByFolder(fileList);

    if (gs.length === 0) {
      notifyError("这个文件夹里没找到视频文件");
      return;
    }

    // 认回上次的进度: 只有 relPath + size 都对得上才认, 避免错配到别的文件夹
    const stored = loadBatch();
    const { fileUploadIds, dramaByTitle } = buildRecoveryIndex(stored);

    const rt: Record<string, DramaRuntime> = {};
    let recoveredFiles = 0;
    let recoveredDramas = 0;

    for (const g of gs) {
      const prev = dramaByTitle.get(g.title);
      const eps: DramaRuntime["episodes"] = {};
      for (const e of g.episodes) {
        const uid = fileUploadIds.get(recoveryKey(e.relPath, e.size));
        if (uid) {
          eps[e.relPath] = { percent: 100, uploadId: uid };
          recoveredFiles++;
        } else {
          eps[e.relPath] = { percent: 0 };
        }
      }
      const wasDone = prev?.status === "submitted" && prev.draftId;
      if (wasDone) recoveredDramas++;
      rt[g.title] = {
        status: wasDone ? "submitted" : "pending",
        draftId: wasDone ? prev!.draftId : undefined,
        episodes: eps,
      };
    }

    runtimeRef.current = rt;
    setGroups(gs);
    groupsRef.current = gs;
    setRootName(root);
    setRuntime(rt);
    setPendingBatch(null);
    // 默认选中所有真剧,「未分组」不选
    setSelected(new Set(gs.filter((g) => g.title !== UNGROUPED_TITLE).map((g) => g.title)));

    const totalFiles = gs.reduce((s, g) => s + g.episodes.length, 0);
    if (recoveredFiles > 0 || recoveredDramas > 0) {
      notify(
        `识别到 ${gs.length} 个剧 / ${totalFiles} 个视频；` +
        `已认回 ${recoveredDramas} 个完成的剧、${recoveredFiles} 个已上传文件，不会重复处理`,
      );
    } else {
      notify(`识别到 ${gs.length} 个剧 / ${totalFiles} 个视频`);
    }
  }

  // ── 拖动改序 ──
  function reorder(title: string, from: number, to: number) {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.title !== title) return g;
        const eps = [...g.episodes];
        const [moved] = eps.splice(from, 1);
        eps.splice(to, 0, moved);
        // 手动排过序就认为用户已经拍板, 重编 1..N 并清掉「需确认」
        return { ...g, episodes: renumber(eps), reviewReasons: [] };
      }),
    );
  }

  function setDrama(title: string, patch: Partial<DramaRuntime>) {
    const cur = runtimeRef.current[title] ?? emptyRuntime();
    runtimeRef.current[title] = { ...cur, ...patch };
    flushRuntime();
  }

  function setEpisode(title: string, relPath: string, patch: Partial<DramaRuntime["episodes"][string]>) {
    const cur = runtimeRef.current[title] ?? emptyRuntime();
    const ep = cur.episodes[relPath] ?? { percent: 0 };
    runtimeRef.current[title] = {
      ...cur,
      episodes: { ...cur.episodes, [relPath]: { ...ep, ...patch } },
    };
  }

  /** 某个剧的文件是不是全传完了 */
  function isDramaUploaded(g: DramaGroup): boolean {
    const rt = runtimeRef.current[g.title];
    if (!rt) return false;
    return g.episodes.length > 0 && g.episodes.every((e) => rt.episodes[e.relPath]?.uploadId);
  }

  /**
   * 建草稿。按用户决策「全部立即启动, 不排队」—— 传完一个就发一个, 不等别的剧。
   *
   * ⚠ 只收 title, 不收 group 对象: 调用点握的可能是开跑那一刻的旧 group,
   * 而集顺序决定 upload_ids 的顺序、进而决定整部剧的剧情顺序。
   * 一律从 groupsRef 现取最新的, 避免提交一个和界面不一致的顺序。
   */
  async function submitDrama(title: string) {
    const g = groupsRef.current.find((x) => x.title === title);
    if (!g) return;
    const rt = runtimeRef.current[title];
    if (!rt || rt.status === "submitted" || rt.status === "submitting") return;

    const uploadIds = g.episodes.map((e) => rt.episodes[e.relPath]?.uploadId);
    if (uploadIds.some((id) => !id)) return;   // 还没齐, 不该走到这

    setDrama(g.title, { status: "submitting", error: undefined });
    try {
      const r = await authFetch(`${BASE}/v1/video/from-oss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_ids: uploadIds as string[],
          title: g.title,
          concurrency: episodeConcurrency,
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      }
      const data = await r.json();
      setDrama(g.title, { status: "submitted", draftId: data.draft_id });
      persist();
    } catch (e: any) {
      setDrama(g.title, { status: "failed", error: `创建草稿失败 — ${e?.message || e}` });
      persist();
    }
  }

  /** 开跑: worker pool 消费任务队列 */
  async function start() {
    const targets = groupsRef.current.filter(
      (g) => selected.has(g.title) && runtimeRef.current[g.title]?.status !== "submitted",
    );
    if (targets.length === 0) {
      notifyError("没有可处理的剧");
      return;
    }

    const needReview = targets.filter((g) => g.reviewReasons.length > 0);
    if (needReview.length > 0) {
      const ok = await confirmAsync({
        title: `${needReview.length} 个剧的集号需要确认`,
        description:
          `${needReview.slice(0, 5).map((g) => g.title).join("、")}` +
          `${needReview.length > 5 ? ` 等 ${needReview.length} 个` : ""}` +
          ` 的集号是猜的或有重号/缺集。集号错了反推出来的剧情顺序就是乱的，` +
          `而且从结果上很难看出来。建议先展开核对，确认无误再跑。仍要继续吗？`,
        confirmText: "仍然继续",
      });
      if (!ok) return;
    }

    const token = getToken();
    if (!token) {
      notifyError("登录状态失效，请重新登录");
      return;
    }

    stopRef.current = false;
    setRunning(true);

    // 任务队列: 按剧聚簇, 让单个剧尽早传完从而尽早提交
    type Task = { group: DramaGroup; ep: ParsedEpisode; epIndex: number };
    const queue: Task[] = [];
    for (const g of targets) {
      setDrama(g.title, { status: "uploading", error: undefined });
      g.episodes.forEach((ep, i) => {
        if (!runtimeRef.current[g.title]?.episodes[ep.relPath]?.uploadId) {
          queue.push({ group: g, ep, epIndex: i });
        }
      });
    }

    // 已经全传完的(全靠认回来的)直接进提交
    for (const g of targets) {
      if (isDramaUploaded(g)) {
        setDrama(g.title, { status: "uploaded" });
        void submitDrama(g.title);
      }
    }

    let cursor = 0;
    const workerCount = Math.max(1, Math.min(8, uploadLimit));

    async function worker() {
      while (!stopRef.current) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const { group, ep, epIndex } = queue[idx];

        let lastPercent = -1;
        const ctrl = uploadToOss({
          file: ep.file,
          token: token!,
          namespace: "video",
          extra: { episode_index: epIndex + 1 },
          kind: "auto",
          concurrency: 4,
          // ⚠ 必须传: 每个子文件夹都有 01.mp4, 不隔离会把续传状态串到别的剧上
          resumeScope: ep.relPath,
          onProgress: (p) => {
            const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
            if (pct === lastPercent) return;   // 限流, 不然几千个文件会把主线程刷爆
            lastPercent = pct;
            setEpisode(group.title, ep.relPath, { percent: pct });
            flushRuntime();
          },
        });
        ctrlsRef.current.set(ep.relPath, ctrl);

        try {
          const res = await ctrl.promise;
          setEpisode(group.title, ep.relPath, {
            percent: 100, uploadId: res.upload_id, error: undefined,
          });
          flushRuntime();
          persist();

          if (isDramaUploaded(group)) {
            setDrama(group.title, { status: "uploaded" });
            void submitDrama(group.title);   // 不 await, 不挡住 worker 继续传别的剧
          }
        } catch (e: any) {
          if (stopRef.current) return;
          const msg = e?.name === "AbortError" ? "已取消" : (e?.message || String(e));
          setEpisode(group.title, ep.relPath, { error: msg });
          setDrama(group.title, {
            status: "failed",
            error: `第 ${ep.epNo} 集上传失败 — ${msg}`,
          });
          persist();
        } finally {
          ctrlsRef.current.delete(ep.relPath);
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    setRunning(false);
    if (!stopRef.current) {
      const done = groupsRef.current.filter(
        (g) => runtimeRef.current[g.title]?.status === "submitted",
      ).length;
      const failed = groupsRef.current.filter(
        (g) => runtimeRef.current[g.title]?.status === "failed",
      ).length;
      if (failed > 0) notifyError(`批次结束：${done} 个剧已提交，${failed} 个失败，可单独重试`);
      else notifySuccess(`批次完成：${done} 个剧已提交，反推在后台继续跑`);
    }
  }

  function stop() {
    stopRef.current = true;
    for (const c of ctrlsRef.current.values()) c.abort();
    ctrlsRef.current.clear();
    setRunning(false);
    notify("已停止。已传完的文件不会丢，重新开始会跳过它们");
  }

  /** 单个剧重试: 清掉它的错误, 重跑没传完的文件 */
  async function retryDrama(g: DramaGroup) {
    setDrama(g.title, { status: "pending", error: undefined });
    for (const e of g.episodes) {
      const cur = runtimeRef.current[g.title]?.episodes[e.relPath];
      if (cur?.error) setEpisode(g.title, e.relPath, { error: undefined, percent: 0 });
    }
    flushRuntime();
    setSelected((prev) => new Set(prev).add(g.title));
    if (!running) notify(`「${g.title}」已重置，点「开始」继续`);
  }

  function skipDrama(g: DramaGroup) {
    setDrama(g.title, { status: "skipped" });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(g.title);
      return next;
    });
    persist();
  }

  async function discardBatch() {
    const ok = await confirmAsync({
      title: "清除上次批次记录？",
      description: "只清本地记录，已经建好的草稿不受影响。",
      confirmText: "清除",
    });
    if (!ok) return;
    clearBatch();
    setPendingBatch(null);
  }

  // ── 汇总 ──
  const stats = useMemo(() => {
    const chosen = groups.filter((g) => selected.has(g.title));
    const files = chosen.reduce((s, g) => s + g.episodes.length, 0);
    const bytes = chosen.reduce((s, g) => s + g.episodes.reduce((a, e) => a + e.size, 0), 0);
    const submitted = groups.filter((g) => runtime[g.title]?.status === "submitted").length;
    return { dramas: chosen.length, files, bytes, submitted };
  }, [groups, selected, runtime]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* ── 页头 ── */}
      <div className="flex items-center gap-3">
        <Link href="/drafts" className="text-ink-muted hover:text-ink-primary">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-page-title text-ink-primary">批量文件夹反推</h1>
          <p className="text-caption text-ink-muted">
            选一个大文件夹，里面每个子文件夹反推成一个独立草稿
          </p>
        </div>
      </div>

      {/* ── 上次未完成 ── */}
      {pendingBatch && groups.length === 0 && (
        <Card className="border-warning/40">
          <div className="flex items-start gap-3">
            <Info className="w-4 h-4 text-warning mt-0.5 shrink-0" />
            <div className="flex-1 text-caption text-ink-secondary">
              上次有个没跑完的批次（{pendingBatch.dramas.length} 个剧
              {pendingBatch.rootName && `，根文件夹「${pendingBatch.rootName}」`}）。
              <br />
              浏览器不允许网页记住文件本身，所以需要
              <b className="text-ink-primary">重新选一次同一个文件夹</b>
              —— 已经传上去的文件和已建好的草稿都会自动认回来，不会重复处理。
            </div>
            <Button size="sm" variant="ghost" leftIcon={<Trash2 className="w-3 h-3" />} onClick={discardBatch}>
              清除记录
            </Button>
          </div>
        </Card>
      )}

      {/* ── 工具条 ── */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <input
            ref={folderRef}
            type="file"
            hidden
            multiple
            {...({ webkitdirectory: "", directory: "" } as any)}
            onChange={(e) => {
              handleFolderPicked(e.target.files);
              e.target.value = "";   // 允许重选同一个文件夹
            }}
          />
          <Button
            variant={groups.length === 0 ? "primary" : "secondary"}
            leftIcon={<FolderOpen className="w-4 h-4" />}
            disabled={running}
            onClick={() => folderRef.current?.click()}
          >
            {groups.length === 0 ? "选择根文件夹" : "重新选择"}
          </Button>

          <label className="flex flex-col gap-1">
            <span className="text-micro text-ink-muted">同时上传</span>
            <Select
              size="sm"
              value={uploadLimit}
              disabled={running}
              onChange={(e) => setUploadLimit(Number(e.target.value))}
              className="w-24"
            >
              <option value={1}>1 个文件</option>
              <option value={2}>2 个文件</option>
              <option value={4}>4 个文件</option>
              <option value={8}>8 个文件</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-micro text-ink-muted">集内并发</span>
            <Select
              size="sm"
              value={episodeConcurrency}
              disabled={running}
              onChange={(e) => setEpisodeConcurrency(Number(e.target.value))}
              className="w-28"
            >
              <option value={1}>1（推荐）</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </Select>
          </label>

          <div className="flex-1" />

          {running ? (
            <Button variant="danger" leftIcon={<Square className="w-4 h-4" />} onClick={stop}>
              停止
            </Button>
          ) : (
            <Button
              leftIcon={<Play className="w-4 h-4" />}
              disabled={stats.dramas === 0}
              onClick={start}
            >
              开始批量反推
            </Button>
          )}
        </div>

        {groups.length > 0 && (
          <div className="mt-3 pt-3 border-t border-line text-caption text-ink-muted">
            已选 <b className="text-ink-primary tabular-nums">{stats.dramas}</b> 个剧 ·
            <span className="tabular-nums"> {stats.files}</span> 个视频 ·
            <span className="tabular-nums"> {formatBytes(stats.bytes)}</span>
            {stats.submitted > 0 && (
              <> · 已提交 <b className="text-success tabular-nums">{stats.submitted}</b></>
            )}
          </div>
        )}

        <p className="mt-2 text-micro text-ink-muted">
          集内并发保持 1 时，后一集能看到前面几集认出的人物与造型，人物一致性更好；
          调高只是更快。
        </p>
      </Card>

      {/* ── 剧列表 ── */}
      {groups.length === 0 ? (
        <EmptyState
          icon={<FolderOpen className="w-8 h-8" />}
          title="还没选文件夹"
          description="目录结构应为：大文件夹 / 剧名 / 已按集号命名的视频。每个子文件夹会反推成一个独立草稿。"
        />
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <DramaCard
              key={g.title}
              group={g}
              runtime={runtime[g.title] ?? emptyRuntime()}
              selected={selected.has(g.title)}
              busy={running}
              onToggleSelect={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(g.title)) next.delete(g.title);
                  else next.add(g.title);
                  return next;
                })
              }
              onReorder={(from, to) => reorder(g.title, from, to)}
              onRetry={() => retryDrama(g)}
              onSkip={() => skipDrama(g)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
