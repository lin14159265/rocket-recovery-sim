import { LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";

export interface PlaybackBarProps {
  currentTimeS: number;
  durationS: number;
  busy: boolean;
  playing: boolean;
  speed: number;
  stateLabel: string;
  stateTone: "idle" | "active" | "hot" | "success" | "danger";
  canPlay: boolean;
  onTogglePlaying: () => void;
  onReset: () => void;
  onSeek: (timeS: number) => void;
  onSpeedChange: (speed: number) => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

export function PlaybackBar({
  currentTimeS,
  durationS,
  busy,
  playing,
  speed,
  stateLabel,
  stateTone,
  canPlay,
  onTogglePlaying,
  onReset,
  onSeek,
  onSpeedChange
}: PlaybackBarProps) {
  const safeDuration = Math.max(0.001, durationS);
  const safeTime = Math.max(0, Math.min(safeDuration, currentTimeS));
  const progress = safeTime / safeDuration * 100;

  return (
    <footer className="playback-bar" aria-label="仿真播放控制">
      <div className="playback-actions">
        <button type="button" className="restart-button" disabled={busy} onClick={onReset}>
          {busy ? <LoaderCircle className="spin" size={21} /> : <RotateCcw size={21} />}
          {busy ? "计算中" : "重启"}
        </button>
        <button
          type="button"
          className="play-button"
          disabled={busy || !canPlay}
          onClick={onTogglePlaying}
          aria-label={playing ? "暂停仿真" : "播放仿真"}
        >
          {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
          {playing ? "暂停" : "播放"}
        </button>
      </div>

      <div className="timeline-control">
        <div className="timeline-readout">
          <strong>{safeTime.toFixed(2)}</strong>
          <span>/ {durationS.toFixed(2)} s</span>
        </div>
        <div className="timeline-slider-wrap" style={{ "--timeline-progress": `${progress}%` } as React.CSSProperties}>
          <input
            type="range"
            min={0}
            max={safeDuration}
            step={0.01}
            value={safeTime}
            disabled={!canPlay || busy}
            onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
            aria-label="仿真时间"
            aria-valuetext={`${safeTime.toFixed(2)} 秒，共 ${durationS.toFixed(2)} 秒`}
          />
          <div className="timeline-ticks" aria-hidden="true">
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) => (
              <span key={fraction} style={{ left: `${fraction * 100}%` }}>
                {Math.round(durationS * fraction)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <label className="speed-select">
        <span className="sr-only">播放速度</span>
        <select value={speed} disabled={busy} onChange={(event) => onSpeedChange(Number(event.currentTarget.value))}>
          {SPEED_OPTIONS.map((option) => <option key={option} value={option}>{option}×</option>)}
        </select>
      </label>

      <div className={`playback-status playback-status--${stateTone}`} role="status">
        <span>状态</span>
        <strong>{stateLabel}</strong>
      </div>
    </footer>
  );
}
