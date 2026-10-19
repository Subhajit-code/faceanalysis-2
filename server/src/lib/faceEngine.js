const FACE_ENGINE_URL = process.env.FACE_ENGINE_URL;
const INTERNAL_TOKEN = process.env.FACE_ENGINE_INTERNAL_TOKEN;

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (INTERNAL_TOKEN) h['X-Internal-Token'] = INTERNAL_TOKEN;
  return h;
}

/**
 * Sends a base64 JPEG frame to the Python face-engine microservice.
 * Returns { success, embedding: number[512], liveness: { isLive, score }, box, error }
 * Throws if the engine is unreachable — callers must treat that as a hard failure,
 * never fall back to trusting an unverified frame.
 */
export async function extractFaceData(imageBase64) {
  const res = await fetch(`${FACE_ENGINE_URL}/extract`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ image: imageBase64 })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`face-engine returned ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Active liveness: sends a short sequence of frames captured during a
 * challenge (e.g. "turn head left then right") for passive+motion liveness scoring.
 */
export async function verifyLivenessSequence(framesBase64) {
  const res = await fetch(`${FACE_ENGINE_URL}/liveness-sequence`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ frames: framesBase64 })
  });

  if (!res.ok) {
    throw new Error(`face-engine liveness check failed: ${res.status}`);
  }

  return res.json();
}
