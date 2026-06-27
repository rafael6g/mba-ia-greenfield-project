import { nanoid } from 'nanoid';

const PUBLIC_ID_LENGTH = 11;

/**
 * Generates a short, opaque, URL-safe public identifier for a video
 * (the unique video URL). Persisted in a unique-indexed column; on the
 * (astronomically unlikely) collision, the caller retries.
 */
export function generatePublicId(): string {
  return nanoid(PUBLIC_ID_LENGTH);
}
