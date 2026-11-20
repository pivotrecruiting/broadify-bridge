/**
 * ATEM house timecode for the SessionEventLog.
 *
 * atem-connection 2.5 has no timecode stream: the switcher answers a
 * `requestTime()` with one `TimeCommand`, stored as `state.info.lastTime`.
 * The adapter polls it once per second and this module turns the last
 * reading plus the wall-clock delta into an "hh:mm:ss:ff" string for each
 * event, so the post-production worker can align events to the recording
 * (ATEM recorders stamp the file with the same timecode).
 */

export type AtemTimeT = {
  hour: number;
  minute: number;
  second: number;
  frame: number;
  dropFrame: boolean;
};

export type TimecodeReadingT = {
  time: AtemTimeT;
  /** Bridge wall clock when the reading arrived. */
  atMs: number;
};

/** atem-connection Enums.VideoMode → frames per second (integer modes rounded as the ATEM counts them). */
const VIDEO_MODE_FPS: Record<number, number> = {
  0: 29.97, 1: 25, 2: 29.97, 3: 25, 4: 50, 5: 59.94, 6: 25, 7: 29.97, 8: 23.98, 9: 24, 10: 25, 11: 29.97, 12: 50, 13: 59.94,
  14: 23.98, 15: 24, 16: 25, 17: 29.97, 18: 50, 19: 59.94, 20: 23.98, 21: 24, 22: 25, 23: 29.97, 24: 50, 25: 59.94, 26: 30, 27: 60,
};

export function videoModeFps(videoMode: number | undefined): number | null {
  return videoMode === undefined ? null : (VIDEO_MODE_FPS[videoMode] ?? null);
}

/** Nominal frame count per second used for the hh:mm:ss:ff display (29.97 counts 30 frames). */
function nominalFps(fps: number): number {
  return Math.round(fps);
}

export function timecodeToFrames(time: AtemTimeT, fps: number): number {
  const n = nominalFps(fps);
  return ((time.hour * 60 + time.minute) * 60 + time.second) * n + time.frame;
}

export function framesToTimecode(frames: number, fps: number): string {
  const n = nominalFps(fps);
  const day = 24 * 60 * 60 * n;
  let total = Math.floor(frames) % day;
  if (total < 0) {
    total += day;
  }
  const hour = Math.floor(total / (3600 * n));
  const minute = Math.floor((total % (3600 * n)) / (60 * n));
  const second = Math.floor((total % (60 * n)) / n);
  const frame = total % n;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}:${pad(second)}:${pad(frame)}`;
}

export function formatAtemTime(time: AtemTimeT): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}:${pad(time.frame)}`;
}

/**
 * Timecode at `nowMs`, extrapolated from the last reading. Returns the plain
 * reading when fps is unknown, and null when there is no reading at all.
 * Drop-frame counting is ignored for the extrapolated part (error < 2 frames
 * per minute, well below the alignment tolerance of the worker).
 */
export function extrapolateTimecode(reading: TimecodeReadingT | null, nowMs: number, fps: number | null): string | null {
  if (!reading) {
    return null;
  }
  if (fps === null || nowMs <= reading.atMs) {
    return formatAtemTime(reading.time);
  }
  const elapsedFrames = ((nowMs - reading.atMs) / 1000) * fps;
  return framesToTimecode(timecodeToFrames(reading.time, fps) + elapsedFrames, fps);
}

export function sameAtemTime(a: AtemTimeT | undefined, b: AtemTimeT | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.hour === b.hour && a.minute === b.minute && a.second === b.second && a.frame === b.frame;
}
