const MIB = 1024 * 1024;
export const MAX_CHUNK_SIZE = 64 * MIB;
export const MAX_FINAL_CHUNK_SIZE = 128 * MIB;
export const MAX_VIDEO_SIZE = 4 * 1024 * MIB;

export function createUploadPlan(videoSize) {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) throw new TypeError("Video size must be a positive integer.");
  if (videoSize > MAX_VIDEO_SIZE) throw new RangeError("Video exceeds TikTok's 4 GiB limit.");

  const chunkSize = Math.min(videoSize, MAX_CHUNK_SIZE);
  const totalChunkCount = Math.max(1, Math.floor(videoSize / chunkSize));
  const chunks = [];
  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    const end = index === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    chunks.push({ start, end, length: end - start + 1 });
  }
  if (chunks.at(-1).length > MAX_FINAL_CHUNK_SIZE) throw new RangeError("Final upload chunk exceeds TikTok's 128 MiB limit.");
  return { videoSize, chunkSize, totalChunkCount, chunks };
}
