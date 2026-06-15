import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
    FluentProvider,
    Button,
    Slider,
    Switch,
    MessageBar,
    Select,
    makeStyles,
    shorthands,
    tokens,
    MessageBarBody,
    MessageBarTitle
} from '@fluentui/react-components';
import { Collapse } from '@fluentui/react-motion-components-preview';
import { getAppTheme, resolveModeFromBg } from './theme';

// === 统一管理（除坐标系/攻击/受击框外）UI 颜色 ===
// 说明：按你的要求，坐标系/攻击/受击框原色 (#ff4d4f/#52c41a/#1677ff/#fadb14/#13c2c2) 不改动；
// 其他原先散落的半透明与背景颜色集中在此，便于后期替换或接入主题 tokens。
// 这里尽量使用 Fluent tokens 代表语义；某些需要透明/渐变的仍保留自定义，同时集中到一个对象。
const UI_COLORS = {
    panelGradient: 'linear-gradient(180deg, rgba(30,30,30,0.92), rgba(30,30,30,0.88) 60%, rgba(30,30,30,0.75))',
    sectionBgToken: tokens.colorNeutralBackground1, // 原 rgba(255,255,255,0.02)
    sectionBorder: tokens.colorNeutralStroke1,
    valueBadgeBgToken: tokens.colorNeutralBackground3, // 原 rgba(255,255,255,0.07)
    overlayBarBg: 'rgba(0,0,0,0.35)',
    miniBarGradient: 'linear-gradient(180deg, rgba(0,0,0,0.78), rgba(0,0,0,0))',
    layerActiveBg: 'rgba(0,120,215,0.35)',
    layerInactiveBg: 'rgba(255,255,255,0.04)',
};

// 简化的 TimelineFrame / Layer 类型（与 webviewHtml.ts 中使用的关键字段一致）
interface LayerFrame {
    __main?: boolean;
    __id?: string;
    __sourceId?: string;
    __rel?: number;
    __order?: number;
    __start?: number;
    __startMs?: number;
    __durationMs?: number;
    __frameIndex?: number;
    __timeMs?: number;
    __img?: string;
    id?: string;
    dx: number; dy: number; w: number; h: number; ox: number; oy: number;
    fid?: number;
    rot?: number; sx?: number; sy?: number; rgba: string; tint?: number[]; gfx?: string;
    // 缓存轮廓路径，避免重复计算
    __outlinePath?: Path2D;
}
interface Box3D { x: number; y: number; z: number; w: number; h: number; d: number; }
interface TimelineFrame { layers?: LayerFrame[]; delay?: number; timeMs?: number; dx?: number; dy?: number; fid?: number; __img?: string; __frameIndex?: number; atk?: Box3D[]; dmg?: Box3D[]; }
interface StageKeyframeMeta { timeMs: number; durationMs: number; img: string; fid: number; frameIndex: number; dx?: number; dy?: number; }
interface LayerMeta { id: string; sourceId?: string; relLayer: number; order: number; kind?: string; seq?: number; startMs?: number; durationMs?: number; keyframes?: StageKeyframeMeta[]; }
interface UseDecl { id: string; path: string; }
interface PersistState { axes: boolean; atk: boolean; dmg: boolean; als: boolean; sync: boolean; bg: string; speed: number; zoom: number; }
interface StageTimelineRow {
    id: string;
    label: string;
    sourceId?: string;
    sourcePath?: string;
    relLayer: number;
    declaredStart: number;
    startMs: number;
    endMs: number;
    durationMs: number;
    keyframes: StageKeyframeMeta[];
    kind?: string;
    seq: number;
    isMain?: boolean;
    active: boolean;
}
interface LayerFrameStore {
    frames: Map<number, LayerFrame>;
    minLocalFrame: number;
    maxLocalFrame: number;
}

declare global { interface Window { __ANI_INIT?: { timeline: TimelineFrame[]; layers: LayerMeta[]; uses: UseDecl[]; state: PersistState; }; __PVF_VSCODE_API?: any; acquireVsCodeApi?: any; } }

const vscode = typeof window !== 'undefined'
    ? (window.__PVF_VSCODE_API || (window.__PVF_VSCODE_API = typeof window.acquireVsCodeApi === 'function' ? window.acquireVsCodeApi() : null))
    : null;

const TIMELINE_UNIT_MS = 10;
const TIMELINE_UNIT_WIDTH = 4;
const TIMELINE_ROW_HEIGHT = 24;
const MAX_KEYFRAME_MARKERS_PER_ROW = 240;

function basenameForDisplay(value: string | undefined): string {
    if (!value) return '';
    const normalized = value.replace(/\\/g, '/');
    const name = normalized.split('/').filter(Boolean).pop() || normalized;
    return name || value;
}

function sourceIdForLayer(meta: LayerMeta): string {
    return meta.sourceId || meta.id.replace(/#\d+$/i, '');
}

function timelineMarkStepMs(durationMs: number): number {
    if (durationMs > 6000) return 1000;
    if (durationMs > 3000) return 500;
    if (durationMs > 1200) return 200;
    return 100;
}

function timeToTimelineX(ms: number): number {
    return Math.max(0, Math.round(ms / TIMELINE_UNIT_MS) * TIMELINE_UNIT_WIDTH);
}

function timelineXToTime(px: number): number {
    return Math.max(0, Math.round(px / TIMELINE_UNIT_WIDTH) * TIMELINE_UNIT_MS);
}

function durationToTimelineWidth(ms: number): number {
    return Math.max(TIMELINE_UNIT_WIDTH, Math.ceil(Math.max(TIMELINE_UNIT_MS, ms) / TIMELINE_UNIT_MS) * TIMELINE_UNIT_WIDTH);
}

function frameStartTimes(timeline: TimelineFrame[]): number[] {
    const out: number[] = [];
    let cursor = 0;
    for (let i = 0; i < timeline.length; i++) {
        const explicit = typeof timeline[i].timeMs === 'number' ? timeline[i].timeMs! : cursor;
        out.push(explicit);
        cursor = explicit + Math.max(1, timeline[i].delay || TIMELINE_UNIT_MS);
    }
    return out;
}

function timelineDurationMs(timeline: TimelineFrame[], starts: number[]): number {
    if (!timeline.length) return 0;
    const lastIndex = timeline.length - 1;
    return (starts[lastIndex] || 0) + Math.max(1, timeline[lastIndex].delay || TIMELINE_UNIT_MS);
}

function frameIndexAtTimeMs(starts: number[], timeline: TimelineFrame[], ms: number): number {
    if (!timeline.length) return 0;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const start = starts[mid] || 0;
        const end = start + Math.max(1, timeline[mid]?.delay || TIMELINE_UNIT_MS);
        if (ms < start) hi = mid - 1;
        else if (ms >= end) lo = mid + 1;
        else return mid;
    }
    return Math.max(0, Math.min(timeline.length - 1, lo));
}

function layerBarColor(row: StageTimelineRow): string {
    if (row.isMain) return '#6aa6ff';
    const colors = ['#7bd88f', '#f8c555', '#ff8a65', '#b084f5', '#4dd0e1', '#f06292', '#a3e635'];
    const seed = Math.abs(row.relLayer * 17 + row.seq * 11 + row.id.length);
    return colors[seed % colors.length];
}

function visibleKeyframesForRow(row: StageTimelineRow): StageKeyframeMeta[] {
    if (row.keyframes.length <= MAX_KEYFRAME_MARKERS_PER_ROW) return row.keyframes;
    const step = Math.ceil(row.keyframes.length / MAX_KEYFRAME_MARKERS_PER_ROW);
    return row.keyframes.filter((_frame, index) => index === 0 || index === row.keyframes.length - 1 || index % step === 0);
}

const useStyles = makeStyles({
    root: {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
        width: '100%',
        fontFamily: '"Microsoft YaHei","微软雅黑","Segoe UI",Arial',
        background: 'var(--vscode-editor-background)',
        overflow: 'visible',
        padding: '8px',
        boxSizing: 'border-box'
    },
    topPanelShell: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        zIndex: 10,
        pointerEvents: 'none'
    },
    topPanelInner: {
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        rowGap: '10px',
    padding: '12px 16px 18px 16px',
    background: UI_COLORS.panelGradient,
        backdropFilter: 'blur(6px)',
    borderBottom: `1px solid ${UI_COLORS.sectionBorder}`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)'
    },
    panelGroups: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        rowGap: '12px'
    },
    section: {
        display: 'flex',
        flexDirection: 'column',
        rowGap: '6px',
    background: UI_COLORS.sectionBgToken,
    border: `1px solid ${UI_COLORS.sectionBorder}`,
        borderRadius: '4px',
        padding: '6px 8px'
    },
    sectionHeader: {
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.5px',
        opacity: .85,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
    },
    inlineRow: {
        display: 'flex',
        alignItems: 'center',
        columnGap: '6px',
        flexWrap: 'wrap'
    },
    labelSmall: { fontSize: '11px', opacity: .75 },
    valueBadge: {
        fontSize: '11px',
        padding: '2px 6px',
        borderRadius: '4px',
    background: UI_COLORS.valueBadgeBgToken
    },
    canvasWrap: {
        position: 'relative',
        flex: '1 1 auto',
        height: 'max(520px, 62vh)',
        minHeight: '520px',
        ...shorthands.overflow('hidden'),
        display: 'flex',
        marginTop: 0,
        border: `1px solid ${UI_COLORS.sectionBorder}`,
        borderRadius: '4px',
        background: tokens.colorNeutralBackground1
    },
    canvas: { width: '100%', height: '100%', display: 'block', outline: 'none', flex: 1 },
    topOverlayBar: {
        position: 'absolute',
        top: '4px',
        right: '8px',
        display: 'flex',
        columnGap: '8px',
        fontSize: '11px',
        padding: '4px 6px',
    background: UI_COLORS.overlayBarBg,
        borderRadius: '4px',
        backdropFilter: 'blur(3px)'
    },
    collapseToggleBtn: {
        position: 'absolute',
        top: '4px',
        left: '8px',
        zIndex: 11,
        pointerEvents: 'auto'
    },
    miniBar: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        display: 'flex',
        alignItems: 'flex-start', // 允许多行时顶部对齐
        gap: '8px',
        padding: '4px 10px',
    background: UI_COLORS.miniBarGradient,
        fontSize: '12px',
        zIndex: 5,
        pointerEvents: 'none'
    },
    miniBarContent: { display: 'flex', alignItems: 'center', gap: '8px', pointerEvents: 'auto', flexWrap: 'wrap', rowGap: '4px', maxWidth: '100%' },
    stageTimelineShell: {
        flex: '0 0 auto',
        marginTop: '8px',
        minHeight: '84px',
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${UI_COLORS.sectionBorder}`,
        borderRadius: '4px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'visible'
    },
    stageTimelineHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '6px 8px',
        borderBottom: `1px solid ${UI_COLORS.sectionBorder}`,
        fontSize: '11px'
    },
    stageTimelineTitle: {
        fontWeight: 600,
        whiteSpace: 'nowrap'
    },
    stageTimelineStats: {
        display: 'flex',
        gap: '8px',
        opacity: .75,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
    },
    stageTimelineBody: {
        overflow: 'auto',
        flex: '0 0 auto',
        minHeight: 0
    },
    stageTimelineGrid: {
        display: 'grid',
        alignItems: 'stretch',
        minWidth: '100%'
    },
    stageTimelineCorner: {
        position: 'sticky',
        left: 0,
        top: 0,
        zIndex: 4,
        background: tokens.colorNeutralBackground2,
        borderRight: `1px solid ${UI_COLORS.sectionBorder}`,
        borderBottom: `1px solid ${UI_COLORS.sectionBorder}`,
        padding: '4px 8px',
        fontSize: '11px',
        fontWeight: 600
    },
    stageTimelineRuler: {
        position: 'sticky',
        top: 0,
        zIndex: 3,
        height: `${TIMELINE_ROW_HEIGHT}px`,
        borderBottom: `1px solid ${UI_COLORS.sectionBorder}`,
        background: tokens.colorNeutralBackground2,
        overflow: 'hidden'
    },
    stageTimelineLabel: {
        position: 'sticky',
        left: 0,
        zIndex: 2,
        borderRight: `1px solid ${UI_COLORS.sectionBorder}`,
        borderBottom: `1px solid ${UI_COLORS.sectionBorder}`,
        background: tokens.colorNeutralBackground1,
        padding: '3px 7px',
        minWidth: 0,
        cursor: 'pointer'
    },
    stageTimelineLabelActive: {
        background: UI_COLORS.layerActiveBg
    },
    stageTimelineLabelName: {
        fontSize: '11px',
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
    },
    stageTimelineLabelMeta: {
        marginTop: '1px',
        fontSize: '10px',
        opacity: .68,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
    },
    stageTimelineTrack: {
        position: 'relative',
        height: `${TIMELINE_ROW_HEIGHT}px`,
        borderBottom: `1px solid ${UI_COLORS.sectionBorder}`,
        backgroundImage: 'linear-gradient(90deg, rgba(128,128,128,0.18) 1px, transparent 1px)',
        backgroundRepeat: 'repeat',
        cursor: 'pointer'
    },
    stageTimelineTrackActive: {
        backgroundColor: 'rgba(0,120,215,0.10)'
    },
    stageTimelineBar: {
        position: 'absolute',
        top: '5px',
        height: '14px',
        borderRadius: '3px',
        border: '1px solid rgba(0,0,0,0.38)',
        boxShadow: 'inset 0 1px rgba(255,255,255,0.28)',
        overflow: 'hidden'
    },
    stageTimelineBarText: {
        display: 'block',
        padding: '0 5px',
        fontSize: '10px',
        lineHeight: '13px',
        color: '#101010',
        textShadow: '0 1px rgba(255,255,255,0.28)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        pointerEvents: 'none'
    },
    stageTimelinePlayhead: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: '2px',
        background: '#ff4d4f',
        pointerEvents: 'none',
        zIndex: 1
    },
    stageTimelineKeyframe: {
        position: 'absolute',
        top: '2px',
        width: '4px',
        height: '20px',
        borderRadius: '2px',
        background: 'rgba(255,255,255,0.88)',
        border: '1px solid rgba(0,0,0,0.35)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.16)',
        cursor: 'default',
        zIndex: 2
    },
    stageTimelineEmpty: {
        padding: '10px 12px',
        fontSize: '12px',
        opacity: .65
    }
});


const useAniLogic = () => {
    const init = React.useMemo(() => window.__ANI_INIT!, []);
    const [playing, setPlaying] = React.useState(false);
    const [idx, setIdx] = React.useState(0);
    const [speed, setSpeed] = React.useState(init.state.speed || 1);
    const [zoom, setZoom] = React.useState(init.state.zoom || 1);
    // 画布平移偏移
    const [cam, setCam] = React.useState({ x: 0, y: 0 });
    const [bg, setBg] = React.useState(init.state.bg || 'dark');
    const [axes, setAxes] = React.useState(!!init.state.axes);
    const [atk, setAtk] = React.useState(init.state.atk !== false);
    const [dmg, setDmg] = React.useState(init.state.dmg !== false);
    const [alsOn, setAlsOn] = React.useState(!!init.state.als);
    const [syncEnabled, setSyncEnabled] = React.useState(init.state.sync !== false);
    const rafRef = React.useRef<number>();
    const lastTick = React.useRef<number>(performance.now());
    const acc = React.useRef(0);
    const lastFrameNotifyRef = React.useRef<number>(0);

    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    // ALS 工作层元数据（按原 seq 排序，不主动重排）
    const [workingLayers, setWorkingLayers] = React.useState<LayerMeta[]>(() => init.layers.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)));
    const [selectedLayerId, setSelectedLayerId] = React.useState<string | null>(null);
    const hasTimeBasedLayers = React.useMemo(() => workingLayers.some(meta => typeof meta.startMs === 'number' || typeof meta.durationMs === 'number' || !!meta.keyframes?.length), [workingLayers]);
    const layerFrameStore = React.useMemo(() => {
        const originalMetaById = new Map<string, LayerMeta>();
        for (const meta of init.layers || []) originalMetaById.set(meta.id, meta);
        const m = new Map<string, LayerFrameStore>();
        const tl = init.timeline;
        for (let i = 0; i < tl.length; i++) {
            const arr = Array.isArray(tl[i].layers) ? tl[i].layers! : [];
            for (const lf of arr) {
                if ((lf as any).__main) continue;
                const id = lf.id || lf.__id || '';
                if (!id) continue;
                const declaredStart = originalMetaById.get(id)?.order ?? lf.__start ?? lf.__order ?? i;
                const localFrame = i - declaredStart;
                let rec = m.get(id);
                if (!rec) {
                    rec = { frames: new Map<number, LayerFrame>(), minLocalFrame: localFrame, maxLocalFrame: localFrame };
                    m.set(id, rec);
                }
                rec.frames.set(localFrame, lf);
                rec.minLocalFrame = Math.min(rec.minLocalFrame, localFrame);
                rec.maxLocalFrame = Math.max(rec.maxLocalFrame, localFrame);
            }
        }
        return m;
    }, [init.layers, init.timeline]);
    const timelineStartMs = React.useMemo(() => frameStartTimes(init.timeline), [init.timeline]);
    const totalDurationMs = React.useMemo(() => timelineDurationMs(init.timeline, timelineStartMs), [init.timeline, timelineStartMs]);
    const currentTimeMs = timelineStartMs[idx] || 0;
    const useDeclById = React.useMemo(() => {
        const m = new Map<string, UseDecl>();
        for (const use of init.uses || []) m.set(use.id, use);
        return m;
    }, [init.uses]);
    const keyframesFromTimeline = React.useCallback((id: string, meta?: LayerMeta): StageKeyframeMeta[] => {
        const out: StageKeyframeMeta[] = [];
        let lastFrameIndex = -1;
        let lastImg = '';
        let lastFid: number | undefined = undefined;
        for (let i = 0; i < init.timeline.length; i++) {
            const frame = init.timeline[i];
            const arr = Array.isArray(frame.layers) ? frame.layers! : [];
            const layer = arr.find(item => {
                const layerId = item.__main ? 'MAIN' : (item.id || item.__id || '');
                return layerId === id;
            }) || (id === 'MAIN' && !arr.length ? ({ dx: frame.dx || 0, dy: frame.dy || 0, fid: frame.fid, __img: frame.__img, __frameIndex: frame.__frameIndex } as LayerFrame) : undefined);
            if (!layer) continue;
            const frameIndex = typeof layer.__frameIndex === 'number' ? layer.__frameIndex : i - (meta?.order || 0);
            const img = layer.__img || '';
            const fid = typeof layer.fid === 'number' ? layer.fid : 0;
            if (frameIndex === lastFrameIndex && img === lastImg && fid === lastFid) continue;
            const timeMs = timelineStartMs[i] || 0;
            out.push({
                timeMs,
                durationMs: Math.max(1, init.timeline[i].delay || TIMELINE_UNIT_MS),
                img,
                fid,
                frameIndex,
                dx: layer.dx,
                dy: layer.dy,
            });
            lastFrameIndex = frameIndex;
            lastImg = img;
            lastFid = fid;
        }
        return out;
    }, [init.timeline, timelineStartMs]);
    const stageTimelineRows = React.useMemo<StageTimelineRow[]>(() => {
        const rows: StageTimelineRow[] = [];
        const mainUse = useDeclById.get('MAIN');
        if (init.timeline.length > 0) {
            const mainMeta = workingLayers.find(meta => meta.id === 'MAIN');
            const mainKeyframes = mainMeta?.keyframes?.length ? mainMeta.keyframes : keyframesFromTimeline('MAIN', mainMeta);
            rows.push({
                id: 'MAIN',
                label: basenameForDisplay(mainUse?.path) || 'MAIN',
                sourceId: 'MAIN',
                sourcePath: mainUse?.path,
                relLayer: 0,
                declaredStart: 0,
                startMs: 0,
                endMs: totalDurationMs,
                durationMs: totalDurationMs,
                keyframes: mainKeyframes,
                seq: -1,
                isMain: true,
                active: currentTimeMs >= 0 && currentTimeMs < totalDurationMs
            });
        }
        workingLayers.forEach((meta, seq) => {
            if (meta.id === 'MAIN') return;
            const rec = layerFrameStore.get(meta.id);
            const sourceId = sourceIdForLayer(meta);
            const sourcePath = useDeclById.get(sourceId)?.path;
            const keyframes = meta.keyframes?.length ? meta.keyframes : keyframesFromTimeline(meta.id, meta);
            const startMs = typeof meta.startMs === 'number'
                ? meta.startMs
                : (keyframes[0]?.timeMs ?? (rec ? (timelineStartMs[Math.max(0, meta.order + rec.minLocalFrame)] || 0) : 0));
            const inferredEndMs = keyframes.length
                ? Math.max(...keyframes.map(frame => frame.timeMs + Math.max(1, frame.durationMs || TIMELINE_UNIT_MS)))
                : startMs;
            const durationMs = typeof meta.durationMs === 'number' ? meta.durationMs : Math.max(0, inferredEndMs - startMs);
            const endMs = Math.max(startMs + durationMs, inferredEndMs);
            rows.push({
                id: meta.id,
                label: basenameForDisplay(sourcePath) || sourceId || meta.id,
                sourceId,
                sourcePath,
                relLayer: meta.relLayer,
                declaredStart: meta.order,
                startMs,
                endMs,
                durationMs: Math.max(0, endMs - startMs),
                keyframes,
                kind: meta.kind,
                seq: typeof meta.seq === 'number' ? meta.seq : seq,
                active: endMs > startMs && currentTimeMs >= startMs && currentTimeMs < endMs
            });
        });
        return rows.sort((a, b) => {
            if (a.relLayer !== b.relLayer) return b.relLayer - a.relLayer;
            if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
            return a.seq - b.seq;
        });
        }, [currentTimeMs, init.timeline.length, keyframesFromTimeline, layerFrameStore, timelineStartMs, totalDurationMs, useDeclById, workingLayers]);

    // base64 -> Uint8Array
    const b64ToU8 = React.useCallback((s: string) => {
        const b = atob(s); const len = b.length; const u8 = new Uint8Array(len); for (let i = 0; i < len; i++) u8[i] = b.charCodeAt(i); return u8;
    }, []);

    const offscreenRef = React.useRef<HTMLCanvasElement | null>(null);

    // 基于 alpha 通道生成轮廓（外轮廓 + 内洞边界）。简单边缘扫描：对每个非透明像素，如果相邻方向为空则添加一条边线段。
    const buildOutlinePath = React.useCallback((imgData: ImageData, ox: number, oy: number, threshold = 20): Path2D => {
        const { data, width: W, height: H } = imgData;
        const alphaAt = (x: number, y: number) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return 0;
            return data[(y * W + x) * 4 + 3];
        };
        const path = new Path2D();
        // 扫描生成四类边：上、下、左、右；每类尝试合并连续段减少 moveTo/lineTo 数量
        // 上边
        for (let y = 0; y < H; y++) {
            let run = false; let sx = 0;
            for (let x = 0; x <= W; x++) {
                const inside = x < W && alphaAt(x, y) >= threshold;
                const neighbor = x < W && alphaAt(x, y - 1) >= threshold;
                const edge = inside && !neighbor;
                if (edge && !run) { run = true; sx = x; }
                if ((!edge || x === W) && run) { // 结束一段
                    path.moveTo(ox + sx, oy + y);
                    path.lineTo(ox + x, oy + y);
                    run = false;
                }
            }
        }
        // 下边
        for (let y = 0; y < H; y++) {
            let run = false; let sx = 0;
            for (let x = 0; x <= W; x++) {
                const inside = x < W && alphaAt(x, y) >= threshold;
                const neighbor = x < W && alphaAt(x, y + 1) >= threshold;
                const edge = inside && !neighbor;
                if (edge && !run) { run = true; sx = x; }
                if ((!edge || x === W) && run) {
                    path.moveTo(ox + sx, oy + y + 1);
                    path.lineTo(ox + x, oy + y + 1);
                    run = false;
                }
            }
        }
        // 左边
        for (let x = 0; x < W; x++) {
            let run = false; let sy = 0;
            for (let y = 0; y <= H; y++) {
                const inside = y < H && alphaAt(x, y) >= threshold;
                const neighbor = y < H && alphaAt(x - 1, y) >= threshold;
                const edge = inside && !neighbor;
                if (edge && !run) { run = true; sy = y; }
                if ((!edge || y === H) && run) {
                    path.moveTo(ox + x, oy + sy);
                    path.lineTo(ox + x, oy + y);
                    run = false;
                }
            }
        }
        // 右边
        for (let x = 0; x < W; x++) {
            let run = false; let sy = 0;
            for (let y = 0; y <= H; y++) {
                const inside = y < H && alphaAt(x, y) >= threshold;
                const neighbor = y < H && alphaAt(x + 1, y) >= threshold;
                const edge = inside && !neighbor;
                if (edge && !run) { run = true; sy = y; }
                if ((!edge || y === H) && run) {
                    path.moveTo(ox + x + 1, oy + sy);
                    path.lineTo(ox + x + 1, oy + y);
                    run = false;
                }
            }
        }
        return path;
    }, []);

    const draw = React.useCallback(() => {
        try {
            const canvas = canvasRef.current; if (!canvas) return;
            const ctx = canvas.getContext('2d'); if (!ctx) return;
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (canvas.width !== w * dpr) canvas.width = w * dpr;
            if (canvas.height !== h * dpr) canvas.height = h * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // background
            ctx.clearRect(0, 0, w, h);
            if (bg === 'checker') {
                const size = 32;
                for (let y = 0; y < h; y += size) {
                    for (let x = 0; x < w; x += size) {
                        ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#555' : '#666';
                        ctx.fillRect(x, y, size, size);
                    }
                }
            } else if (bg === 'light') {
                ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, w, h);
            } else if (bg === 'transparent') {
                ctx.fillStyle = '#00000000'; ctx.fillRect(0, 0, w, h);
            } else {
                ctx.fillStyle = '#1e1e1e'; ctx.fillRect(0, 0, w, h);
            }
            ctx.save();
            ctx.translate(w / 2 + cam.x, h / 2 + cam.y);
            if (zoom !== 1) ctx.scale(zoom, zoom);
            const rawFrame = init.timeline[idx] as any;
            // 组合 ALS: 若 alsOn 开启且存在 workingLayers，则动态组合；否则直接使用当前帧 layers
            let compositeLayers: any[] = [];
            if (rawFrame) {
                if (hasTimeBasedLayers) {
                    compositeLayers = Array.isArray(rawFrame.layers) ? rawFrame.layers.slice() : [];
                } else if (alsOn) {
                    const mainLayer = rawFrame.layers?.find((l: any) => (l as any).__main) || rawFrame.layers?.[0];
                    if (mainLayer) compositeLayers.push(mainLayer);
                    for (const meta of workingLayers) {
                        if (meta.id === 'MAIN') continue;
                        const rec = layerFrameStore.get(meta.id); if (!rec) continue;
                        const relIndex = idx - meta.order;
                        const baseFrame = rec.frames.get(relIndex);
                        if (!baseFrame) continue;
                        compositeLayers.push({ ...baseFrame, __rel: meta.relLayer, __start: meta.order, __id: meta.id });
                    }
                    compositeLayers.sort((a, b) => {
                        const ra = (a as any).__main ? 0 : ((a as any).__rel || 0);
                        const rb = (b as any).__main ? 0 : ((b as any).__rel || 0);
                        if (ra !== rb) return ra - rb; return 0;
                    });
                } else {
                    // 仅主层
                    const mainLayer = rawFrame.layers?.find((l: any) => (l as any).__main) || rawFrame.layers?.[0];
                    if (mainLayer) compositeLayers.push(mainLayer);
                }
            }
            let frameLayersToDraw = hasTimeBasedLayers || alsOn ? compositeLayers : (compositeLayers.length ? compositeLayers : (rawFrame?.layers || []));
            // 兼容旧结构：时间轴帧没有 layers 属性时，将根帧视为主层
            if ((!frameLayersToDraw || frameLayersToDraw.length === 0) && rawFrame && !rawFrame.layers && rawFrame.rgba) {
                frameLayersToDraw = [{ ...rawFrame, __main: true }];
            }
            if (frameLayersToDraw.length) {
                const buf = offscreenRef.current || (offscreenRef.current = document.createElement('canvas'));
                const bctx = buf.getContext('2d')!;
                for (const L of frameLayersToDraw) {
                    const raw = b64ToU8(L.rgba);
                    const imgData = new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), L.w, L.h);
                    // 线性减淡 (Linear Dodge) 合成：旧实现通过最大通道推导透明度后提升 RGB
                    // 原逻辑参考旧版 webviewHtml.ts: gfx === 'LINEARDODGE'
                    if (L.gfx === 'LINEARDODGE') {
                        try {
                            const d = imgData.data;
                            for (let i = 0; i < d.length; i += 4) {
                                const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
                                const max = Math.max(r, g, b);
                                const sub = 255 - max; // 剩余空间
                                const na = Math.min(a, max); // 透明度受亮度限制，避免过亮溢出
                                d[i + 3] = na;
                                d[i] = Math.min(255, r + sub);
                                d[i + 1] = Math.min(255, g + sub);
                                d[i + 2] = Math.min(255, b + sub);
                            }
                        } catch {}
                    }
                    if (L.tint) {
                        const d = imgData.data; const tr = L.tint[0] / 255, tg = L.tint[1] / 255, tb = L.tint[2] / 255, ta = L.tint[3];
                        for (let i = 0; i < d.length; i += 4) {
                            d[i] = Math.min(255, Math.round(d[i] * tr));
                            d[i + 1] = Math.min(255, Math.round(d[i + 1] * tg));
                            d[i + 2] = Math.min(255, Math.round(d[i + 2] * tb));
                            if (!Number.isNaN(ta)) d[i + 3] = Math.min(255, Math.round(d[i + 3] * (ta / 255)));
                        }
                    }
                    if (buf.width !== L.w || buf.height !== L.h) { buf.width = L.w; buf.height = L.h; }
                    bctx.clearRect(0, 0, buf.width, buf.height);
                    bctx.putImageData(imgData, 0, 0);
                    ctx.save();
                    ctx.translate(L.dx, L.dy);
                    if (L.rot) ctx.rotate(L.rot * Math.PI / 180);
                    const sx = typeof L.sx === 'number' ? L.sx : 1; const sy = typeof L.sy === 'number' ? L.sy : 1; if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
                    ctx.drawImage(buf, L.ox | 0, L.oy | 0);
                    // 仅在主层绘制 SUPERARMOR 像素轮廓线
                    if (rawFrame?.superArmor && (L as any).__main) {
                        try {
                            if (!L.__outlinePath) {
                                L.__outlinePath = buildOutlinePath(imgData, (L.ox | 0), (L.oy | 0));
                            }
                            ctx.save();
                            const scaleX = typeof L.sx === 'number' && L.sx ? L.sx : 1;
                            const lw = Math.max(1, 2 / scaleX);
                            ctx.lineWidth = lw;
                            ctx.strokeStyle = '#ff0000';
                            ctx.lineJoin = 'round';
                            ctx.lineCap = 'round';
                            ctx.stroke(L.__outlinePath!);
                            ctx.restore();
                        } catch {}
                    }
                    ctx.restore();
                }
            }
            // overlays
            const proj = (x: number, y: number, z: number) => { const k = 0.5; return { x: x + k * y, y: -z + k * y }; };
            const drawAxes = () => {
                const axisLen = 200;
                ctx.save(); ctx.lineWidth = 1;
                ctx.strokeStyle = '#ff4d4f'; ctx.beginPath(); let p0 = proj(0, 0, 0); let p1 = proj(axisLen, 0, 0); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
                ctx.strokeStyle = '#52c41a'; ctx.beginPath(); p0 = proj(0, 0, 0); p1 = proj(0, axisLen, 0); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
                ctx.strokeStyle = '#1677ff'; ctx.beginPath(); p0 = proj(0, 0, 0); p1 = proj(0, 0, axisLen); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
                ctx.restore();
            };
            const drawBox = (box: Box3D, color: string) => {
                const { x, y, z, w, h, d } = box;
                const c = [
                    proj(x, y, z), proj(x + w, y, z), proj(x + w, y + h, z), proj(x, y + h, z),
                    proj(x, y, z + d), proj(x + w, y, z + d), proj(x + w, y + h, z + d), proj(x, y + h, z + d)
                ];
                ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (const i of [1, 2, 3, 0]) ctx.lineTo(c[i].x, c[i].y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(c[4].x, c[4].y); for (const i of [5, 6, 7, 4]) ctx.lineTo(c[i].x, c[i].y); ctx.stroke();
                ctx.beginPath(); for (const i of [0, 1, 2, 3]) { ctx.moveTo(c[i].x, c[i].y); ctx.lineTo(c[i + 4].x, c[i + 4].y); } ctx.stroke();
                ctx.restore();
            };
            if (axes) drawAxes();
            if (atk && rawFrame?.atk) for (const b of rawFrame.atk) drawBox(b, '#fadb14');
            if (dmg && rawFrame?.dmg) for (const b of rawFrame.dmg) drawBox(b, '#13c2c2');
            ctx.restore();
        } catch (e) {
            console.error('[aniPreview draw error]', e);
        }
    }, [idx, bg, zoom, axes, atk, dmg, alsOn, hasTimeBasedLayers, init.timeline, cam.x, cam.y, b64ToU8, workingLayers]);

    React.useEffect(() => { draw(); });
    React.useEffect(() => { const r = () => draw(); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, [draw]);

    // （上方已重新注册 draw 与 resize effect）

    React.useEffect(() => {
        if (!playing) { return; }
        const step = (now: number) => {
            const dt = now - lastTick.current; lastTick.current = now; acc.current += dt;
            setIdx(currentIdx => {
                if (!init.timeline.length) return currentIdx;
                let nextIdx = currentIdx;
                let guard = 0;
                while (guard < init.timeline.length) {
                    const frame = init.timeline[nextIdx];
                    const delay = Math.max(1, (frame.delay || 40) / Math.max(0.01, speed));
                    if (acc.current < delay) break;
                    acc.current -= delay;
                    nextIdx = (nextIdx + 1) % init.timeline.length;
                    guard++;
                }
                return nextIdx;
            });
            rafRef.current = requestAnimationFrame(step);
        };
        lastTick.current = performance.now();
        rafRef.current = requestAnimationFrame(step);
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }, [playing, speed, init.timeline]);

    // 同步来自扩展的消息 (gotoFrame)
    React.useEffect(() => {
        const handler = (e: MessageEvent) => { const m = e.data; if (!m) return; if (!syncEnabled) return; if (m.type === 'gotoFrame' && typeof m.idx === 'number') { setIdx(Math.max(0, Math.min(init.timeline.length - 1, m.idx))); } };
        window.addEventListener('message', handler); return () => window.removeEventListener('message', handler);
    }, [init.timeline.length, syncEnabled]);

    // 持久化状态通知扩展
    React.useEffect(() => { vscode?.postMessage({ type: 'persistState', state: { axes, atk, dmg, als: alsOn, sync: syncEnabled, bg, speed, zoom } }); }, [axes, atk, dmg, alsOn, syncEnabled, bg, speed, zoom]);

    // 帧变更通知扩展 (节流)
    React.useEffect(() => {
        if (!syncEnabled) return;
        const now = Date.now();
        if (now - lastFrameNotifyRef.current > 80 || idx === 0) {
            lastFrameNotifyRef.current = now;
            vscode?.postMessage({ type: 'frameChange', idx });
        }
    }, [idx, syncEnabled]);

    const gotoPrev = () => setIdx(i => (i - 1 + init.timeline.length) % init.timeline.length);
    const gotoNext = () => setIdx(i => (i + 1) % init.timeline.length);

    // 画布交互：拖动平移与 Ctrl+滚轮缩放
    React.useEffect(() => {
        const canvas = canvasRef.current; if (!canvas) return;
        let dragging = false; let lastX = 0, lastY = 0;
        const onDown = (e: MouseEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.style.cursor = 'grabbing'; };
        const onMove = (e: MouseEvent) => { if (!dragging) return; const dx = e.clientX - lastX; const dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; setCam(c => ({ x: c.x + dx, y: c.y + dy })); };
        const onUp = () => { dragging = false; canvas.style.cursor = 'default'; };
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return; // 仅 Ctrl+滚轮触发缩放
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            setZoom(z => { const nz = Math.min(4, Math.max(0.25, parseFloat((z + delta).toFixed(4)))); return nz; });
        };
        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            canvas.removeEventListener('mousedown', onDown);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            canvas.removeEventListener('wheel', onWheel);
        };
    }, []);

    const styles = useStyles();
    const fluentTheme = React.useMemo(() => getAppTheme(resolveModeFromBg(bg)), [bg]);
    const [panelOpen, setPanelOpen] = React.useState(false);
    const resetView = () => { setCam({ x: 0, y: 0 }); setZoom(1); };
    const frameInfo = `${idx + 1}/${init.timeline.length}`;
    // === ALS 编辑操作 ===
    const mutateLayer = (id: string, mut: (m: LayerMeta) => void) => {
        // 之前实现里 mut({ ...l }) 后又返回 { ...l }，导致修改未写回；这里改为真正返回被修改的副本
        setWorkingLayers(ws => ws.map(l => {
            if (l.id !== id) return l;
            const clone = { ...l };
            mut(clone);
            return clone;
        }));
    };
    const incDepth = () => { if (!selectedLayerId) return; mutateLayer(selectedLayerId, m => { m.relLayer += 1; }); };
    const decDepth = () => { if (!selectedLayerId) return; mutateLayer(selectedLayerId, m => { m.relLayer -= 1; }); };
    const incStart = () => { if (!selectedLayerId) return; mutateLayer(selectedLayerId, m => { m.order += 1; }); };
    const decStart = () => { if (!selectedLayerId) return; mutateLayer(selectedLayerId, m => { m.order -= 1; }); };
    const saveAls = () => {
        if (!vscode) return;
        const seq = workingLayers; // 保持当前顺序
        vscode.postMessage({ type: 'saveAls', adds: seq.map(l => ({ id: l.sourceId || l.id, start: l.order, depth: l.relLayer, relLayer: l.relLayer, order: l.order, kind: l.kind })), uses: init.uses });
    };
    const [alsPanelOpen, setAlsPanelOpen] = React.useState(false);
    const [stageTimelineOpen, setStageTimelineOpen] = React.useState(true);
    const currentDelay = init.timeline[idx]?.delay || 0;
    const frameCount = init.timeline.length;
    const timelineWidth = Math.max(durationToTimelineWidth(totalDurationMs), 1);
    const rulerStepMs = timelineMarkStepMs(totalDurationMs);
    const rulerMarks = React.useMemo(() => {
        const marks: number[] = [];
        for (let time = 0; time <= totalDurationMs; time += rulerStepMs) {
            marks.push(time);
        }
        if (totalDurationMs > 0) marks.push(totalDurationMs);
        return Array.from(new Set(marks)).sort((a, b) => a - b);
    }, [totalDurationMs, rulerStepMs]);
    const gotoFrameFromTrack = (event: React.MouseEvent<HTMLElement>) => {
        if (!frameCount) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ms = timelineXToTime(event.clientX - rect.left);
        setIdx(frameIndexAtTimeMs(timelineStartMs, init.timeline, ms));
    };
    const selectedTimelineRow = selectedLayerId ? stageTimelineRows.find(row => row.id === selectedLayerId) : undefined;
    const depthCount = React.useMemo(() => new Set(stageTimelineRows.map(row => row.relLayer)).size, [stageTimelineRows]);
    const timelineHeight = Math.max(84, 32 + (stageTimelineRows.length + 1) * TIMELINE_ROW_HEIGHT);
    const stageTimeline = stageTimelineOpen ? (
        <div className={styles.stageTimelineShell} style={{ minHeight: timelineHeight }}>
            <div className={styles.stageTimelineHeader}>
                <div className={styles.stageTimelineTitle}>舞台时间轴</div>
                <div className={styles.stageTimelineStats}>
                    <span>时间 {currentTimeMs}ms / {totalDurationMs}ms</span>
                    <span>元件 {Math.max(0, stageTimelineRows.length - 1)}</span>
                    <span>图层 {depthCount}</span>
                    {selectedTimelineRow && <span>{selectedTimelineRow.id} layer={selectedTimelineRow.relLayer} start={selectedTimelineRow.startMs}ms</span>}
                </div>
            </div>
            {stageTimelineRows.length ? (
                <div className={styles.stageTimelineBody}>
                    <div
                        className={styles.stageTimelineGrid}
                        style={{ gridTemplateColumns: `190px ${timelineWidth}px`, gridAutoRows: `${TIMELINE_ROW_HEIGHT}px` }}
                    >
                        <div className={styles.stageTimelineCorner}>图层 / 元件</div>
                        <div
                            className={styles.stageTimelineRuler}
                            onClick={gotoFrameFromTrack}
                            style={{ width: timelineWidth, backgroundSize: `${TIMELINE_UNIT_WIDTH}px 100%` }}
                        >
                            {rulerMarks.map(mark => (
                                <div key={mark} style={{ position: 'absolute', left: timeToTimelineX(mark) + 2, top: 3, fontSize: 10, opacity: .72 }}>
                                    {mark}ms
                                </div>
                            ))}
                            <div className={styles.stageTimelinePlayhead} style={{ left: timeToTimelineX(currentTimeMs) }} />
                        </div>
                        {stageTimelineRows.map(row => {
                            const activeClass = row.active ? ` ${styles.stageTimelineLabelActive}` : '';
                            const barWidth = durationToTimelineWidth(row.durationMs);
                            const color = layerBarColor(row);
                            const visibleKeyframes = visibleKeyframesForRow(row);
                            const markerSampled = visibleKeyframes.length < row.keyframes.length;
                            const labelTitle = [
                                row.isMain ? `主 ANI ${row.sourcePath || ''}` : row.sourcePath,
                                `layer=${row.relLayer}`,
                                `start=${row.startMs}ms`,
                                `duration=${row.durationMs}ms`,
                                markerSampled ? `keyframes=${row.keyframes.length}, markers=${visibleKeyframes.length}` : `keyframes=${row.keyframes.length}`,
                                row.kind
                            ].filter(Boolean).join('  ');
                            return (
                                <React.Fragment key={row.id}>
                                    <div
                                        className={styles.stageTimelineLabel + activeClass}
                                        title={labelTitle}
                                        onClick={() => setSelectedLayerId(row.isMain ? null : row.id)}
                                    >
                                        <div className={styles.stageTimelineLabelName}>{row.isMain ? row.label : row.label}</div>
                                        <div className={styles.stageTimelineLabelMeta}>
                                            {row.isMain ? '主时间轴' : `layer ${row.relLayer}  ${row.startMs}ms${row.kind ? `  ${row.kind}` : ''}`}
                                        </div>
                                    </div>
                                    <div
                                        className={styles.stageTimelineTrack + (row.active ? ` ${styles.stageTimelineTrackActive}` : '')}
                                        onClick={gotoFrameFromTrack}
                                        style={{ width: timelineWidth, backgroundSize: `${TIMELINE_UNIT_WIDTH}px 100%` }}
                                    >
                                        {row.durationMs > 0 && (
                                            <div
                                                className={styles.stageTimelineBar}
                                                title={labelTitle}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setSelectedLayerId(row.isMain ? null : row.id);
                                                    setIdx(frameIndexAtTimeMs(timelineStartMs, init.timeline, row.startMs));
                                                }}
                                                style={{
                                                    left: timeToTimelineX(row.startMs),
                                                    width: barWidth,
                                                    background: `linear-gradient(180deg, ${color}, ${color}cc)`
                                                }}
                                            >
                                                <span className={styles.stageTimelineBarText}>
                                                    {row.isMain ? `MAIN ${row.durationMs}ms` : `${row.sourceId || row.id} ${row.durationMs}ms`}
                                                </span>
                                            </div>
                                        )}
                                        {visibleKeyframes.map((frame, keyframeIndex) => {
                                            const title = [
                                                `t=${frame.timeMs}ms`,
                                                `delay=${frame.durationMs}ms`,
                                                `frame=${frame.frameIndex}`,
                                                `fid=${frame.fid}`,
                                                frame.img ? `img=${frame.img}` : 'img=<empty>',
                                                typeof frame.dx === 'number' && typeof frame.dy === 'number' ? `pos=${frame.dx},${frame.dy}` : '',
                                                markerSampled ? `marker ${keyframeIndex + 1}/${visibleKeyframes.length} sampled from ${row.keyframes.length}` : ''
                                            ].filter(Boolean).join('  ');
                                            return (
                                                <div
                                                    key={`${frame.timeMs}-${frame.frameIndex}-${keyframeIndex}`}
                                                    className={styles.stageTimelineKeyframe}
                                                    title={title}
                                                    style={{ left: Math.max(0, timeToTimelineX(frame.timeMs) - 2) }}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        setSelectedLayerId(row.isMain ? null : row.id);
                                                        setIdx(frameIndexAtTimeMs(timelineStartMs, init.timeline, frame.timeMs));
                                                    }}
                                                />
                                            );
                                        })}
                                        <div className={styles.stageTimelinePlayhead} style={{ left: timeToTimelineX(currentTimeMs) }} />
                                    </div>
                                </React.Fragment>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div className={styles.stageTimelineEmpty}>没有可显示的时间轴帧。</div>
            )}
        </div>
    ) : null;
    const ui = (
    <FluentProvider theme={fluentTheme} className={styles.root}>
            <div className={styles.topPanelShell}>
                <Collapse orientation='vertical' animateOpacity={true} visible={panelOpen}>
                    <div className={styles.topPanelInner} style={{ transformOrigin: 'top' }}>
                        <div className={styles.panelGroups}>
                            <MessageBar shape="rounded">
                                <MessageBarBody>
                                    <MessageBarTitle>提示</MessageBarTitle>
                                    拖动: 左键 | 缩放: Ctrl+滚轮 | 重置: 按钮/双击画布
                                </MessageBarBody>
                            </MessageBar>

                            <div className={styles.section} style={{ width: '100%' }}>
                                <Button size='small' appearance='primary' onClick={() => setPanelOpen(false)}>收起</Button>
                            </div>
                            <div className={styles.section} style={{ width: '100%' }}>
                                <div className={styles.sectionHeader}>速度</div>
                                <div className={styles.inlineRow}><span className={styles.labelSmall}>{speed.toFixed(2)}x</span><Slider min={0.25} max={4} step={0.05} value={speed} onChange={(_, d) => setSpeed(d.value)} style={{ flex: 1, minWidth: 160 }} /></div>
                            </div>
                            <div className={styles.section} style={{ width: '100%' }}>
                                <div className={styles.sectionHeader}>视图</div>
                                <div className={styles.inlineRow}><span className={styles.labelSmall}>{Math.round(zoom * 100)}%</span><Slider min={0.25} max={4} step={0.05} value={zoom} onChange={(_, d) => setZoom(d.value)} style={{ flex: 1, minWidth: 160 }} /></div>
                                <div style={{ display: 'flex', flexDirection: 'row', gap: 8, alignItems: 'center' }} title='拖动: 左键 | 缩放: Ctrl+滚轮 | 重置: 按钮/双击画布'>
                                    <Select size='small' value={bg} onChange={(e, data) => { if (data.value) setBg(data.value); }} style={{ minWidth: 140 }}>
                                        <option value='dark'>深色背景</option>
                                        <option value='light'>浅色背景</option>
                                        <option value='checker'>棋盘格</option>
                                        <option value='transparent'>透明</option>
                                    </Select>
                                    <Button size='small' appearance='secondary' onClick={resetView}>重置视图</Button>
                                </div>
                            </div>
                            <div className={styles.section} style={{ width: '100%' }}>
                                <div className={styles.sectionHeader}>视图</div>
                                <div className={styles.inlineRow} style={{ rowGap: 4 }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}><Switch checked={axes} onChange={(_, d) => setAxes(!!d.checked)} />坐标系</label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}><Switch checked={atk} onChange={(_, d) => setAtk(!!d.checked)} />攻击框</label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}><Switch checked={dmg} onChange={(_, d) => setDmg(!!d.checked)} />受击框</label>
                                </div>
                            </div>
                            <div className={styles.section} style={{ width: '100%' }}>
                                <div className={styles.sectionHeader}>同步</div>
                                <div className={styles.inlineRow}><label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }} title='与文本编辑器中ani的帧/光标同步'><Switch checked={syncEnabled} onChange={(_, d) => { const v = !!d.checked; setSyncEnabled(v); vscode?.postMessage({ type: 'syncToggle', enabled: v }); }} />与文档编辑器光标同步</label></div>
                            </div>
                        </div>
                    </div>
                </Collapse>
                {/* ALS 独立面板 */}
                <Collapse orientation='vertical' animateOpacity={true} visible={alsPanelOpen}>
                    <div className={styles.topPanelInner} style={{ transformOrigin: 'top', marginTop: panelOpen ? 6 : 0 }}>
                        <div className={styles.panelGroups}>
                            <div className={styles.section} style={{ width: '100%' }}>
                                <div className={styles.sectionHeader}>{hasTimeBasedLayers ? '舞台图层' : 'ALS 图层'} <div style={{ display: 'flex', gap: 6 }}><Switch checked={hasTimeBasedLayers ? true : alsOn} disabled={hasTimeBasedLayers} onChange={(_, d) => setAlsOn(!!d.checked)} /> <Button size='small' appearance='primary' onClick={() => setAlsPanelOpen(false)}>收起</Button></div></div>
                                {!hasTimeBasedLayers && !alsOn && <div style={{ fontSize: 12, opacity: .6 }}>开启 ALS 开关后可编辑附加图层。</div>}
                                {(hasTimeBasedLayers || alsOn) && (
                                    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6, gap: 6 }}>
                                        {!hasTimeBasedLayers && (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                                <Button size='small' onClick={incStart}>起始帧+1</Button>
                                                <Button size='small' onClick={decStart}>起始帧-1</Button>
                                                <Button size='small' onClick={incDepth}>图层+1</Button>
                                                <Button size='small' onClick={decDepth}>图层-1</Button>
                                                <Button size='small' appearance='primary' onClick={saveAls}>保存ALS</Button>
                                            </div>
                                        )}
                                        <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--vscode-panel-border)', padding: 4, borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            {workingLayers.map(l => {
                                                const active = l.id === selectedLayerId;
                                                return <div key={l.id} onClick={() => setSelectedLayerId(p => p === l.id ? null : l.id)} style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 4, background: active ? UI_COLORS.layerActiveBg : UI_COLORS.layerInactiveBg, display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                                                    <span style={{ fontWeight: 600, marginRight: 8 }}>{l.id}</span>
                                                    <span style={{ opacity: .8 }}>{hasTimeBasedLayers ? `start=${l.startMs || 0}ms layer=${l.relLayer}` : `start=${l.order} depth=${l.relLayer}`}{l.kind ? (' ' + l.kind) : ''}</span>
                                                </div>;
                                            })}
                                            {!workingLayers.length && <div style={{ fontSize: 12, opacity: .6 }}>无 ALS 图层</div>}
                                        </div>
                                        <div style={{ fontSize: 11, opacity: .6, lineHeight: 1.4 }}>
                                            {hasTimeBasedLayers ? '当前为技能舞台时间轴，按真实 delay 以 10ms 单位预览。' : '提示: 选择图层后使用按钮进行变更图层以及该图层相对于主ani的起始帧。保存会写回 .ani.als，你需要手动保存。'}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </Collapse>
            </div>
            {/* 主视图 */}
            {!panelOpen && <div className={styles.miniBar}>
                <div className={styles.miniBarContent}>
                    <Button appearance='primary' onClick={() => setPanelOpen(true)}>展开控制</Button>
                    <Button appearance={playing ? 'primary' : 'secondary'} onClick={() => setPlaying(p => !p)}>{playing ? '暂停' : '播放'}</Button>
                    <Button onClick={gotoPrev}>上帧</Button>
                    <Button onClick={gotoNext}>下帧</Button>
                    {!alsPanelOpen && <Button onClick={() => setAlsPanelOpen(true)}>ALS</Button>}
                    <Button onClick={() => setStageTimelineOpen(v => !v)}>{stageTimelineOpen ? '隐藏时间轴' : '时间轴'}</Button>

                    <span>帧 {frameInfo}</span>
                    <span>延时 {currentDelay}ms</span>
                </div>
            </div>}
            {/* {!alsPanelOpen && <div style={{ position: 'absolute', top: 4, right: 8, zIndex: 20 }}><Button size='small' onClick={() => setAlsPanelOpen(true)}>展开 ALS</Button></div>} */}
            <div className={styles.canvasWrap}>
                <canvas ref={canvasRef} className={styles.canvas} onDoubleClick={resetView} />
            </div>
            {stageTimeline}
        </FluentProvider>
    );
    return { ui };
};

const App: React.FC = () => {
    const { ui } = useAniLogic();
    return ui;
};

function main() {
    const rootEl = document.getElementById('root'); if (!rootEl) { return; }
    // 全局错误捕获，避免静默白屏
    window.addEventListener('error', (e) => { console.error('GlobalError', e.error || e.message); });
    window.addEventListener('unhandledrejection', (e: any) => { console.error('UnhandledRejection', e.reason); });
    createRoot(rootEl).render(<App />);
}

main();
