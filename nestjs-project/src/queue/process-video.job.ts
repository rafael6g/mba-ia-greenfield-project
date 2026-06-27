/**
 * Payload of the `process-video` job carried over the `video-processing`
 * queue: only the video id — the worker loads everything else from the DB.
 */
export interface ProcessVideoJobData {
  videoId: string;
}
