import crypto from 'crypto';

const KEY = Buffer.from(process.env.AES_KEY, 'hex');
if (KEY.length !== 32) {
  throw new Error('AES_KEY must be a 32-byte (64 hex char) key');
}

// Encrypt a Float32Array embedding for storage. Output: iv(12) + authTag(16) + ciphertext
export function encryptVector(float32Array) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const plain = Buffer.from(float32Array.buffer);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptVector(buffer) {
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return new Float32Array(decrypted.buffer, decrypted.byteOffset, decrypted.length / 4);
}

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Cosine similarity, the standard metric for ArcFace embeddings (range -1..1,
 * 1 = identical direction). Preferred over Euclidean distance for face
 * matching here because it maps far more intuitively onto a confidence
 * percentage and gives a cleaner separation between genuine/impostor scores
 * for this embedding space.
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
