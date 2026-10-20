"""
Sentinel Face Engine — ArcFace embedding extraction + liveness scoring.

Uses InsightFace (buffalo_l: RetinaFace detector + ArcFace r100 recognition,
512-D embeddings) for production-grade accuracy, far stronger than the
browser-side dlib-ResNet model used in the original prototype.

IMPORTANT: the passive liveness score here is a texture/sharpness heuristic,
not a dedicated anti-spoof neural net. For real deployments, swap
`passive_liveness_score` for a trained presentation-attack-detection model
(e.g. MiniFASNet / Silent-Face-Anti-Spoofing) — heuristics alone are not
reliable against high-quality printed photos or tablet replay attacks.
"""

import base64
import hmac
import io
import os

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from insightface.app import FaceAnalysis
from pydantic import BaseModel

app = FastAPI(title="Sentinel Face Engine")

# Shared-secret gate: this service has no face-matching logic or database of
# its own, but it still shouldn't be callable by the public internet — only
# by our own Node API. Required whenever INTERNAL_TOKEN is set (e.g. in any
# hosted deployment where this runs as its own publicly-reachable service).
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN")


def require_internal_token(x_internal_token: str | None = Header(default=None)):
    if INTERNAL_TOKEN and not (x_internal_token and hmac.compare_digest(x_internal_token, INTERNAL_TOKEN)):
        raise HTTPException(status_code=401, detail="Missing or invalid internal token")

# Running on Hugging Face Spaces' free Docker tier (16GB RAM), so the
# 512MB-constrained buffalo_s workaround is no longer needed — back to the
# full-accuracy buffalo_l pack. allowed_modules still skips the landmark/
# genderage models we never use (no downside, just less to load either way).
# FACE_MODEL_PACK stays overridable via env var if you move hosts again.
FACE_MODEL_PACK = os.environ.get("FACE_MODEL_PACK", "buffalo_l")
face_app = FaceAnalysis(
    name=FACE_MODEL_PACK,
    providers=["CPUExecutionProvider"],
    allowed_modules=["detection", "recognition"],
)
face_app.prepare(ctx_id=0, det_size=(640, 640))


class ExtractRequest(BaseModel):
    image: str  # base64-encoded JPEG/PNG, optionally with data: prefix


class LivenessSequenceRequest(BaseModel):
    frames: list[str]


def decode_base64_image(b64_string: str) -> np.ndarray:
    if "," in b64_string[:60]:
        b64_string = b64_string.split(",", 1)[1]
    raw = base64.b64decode(b64_string)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


def passive_liveness_score(face_crop: np.ndarray) -> float:
    """Cheap heuristic: real faces under normal webcam lighting have some
    high-frequency detail; a flat/blank or extremely blurry capture (printed
    photo held far from a weak camera, or a frozen/corrupt frame) scores low.
    Returns a score in [0, 1]; NOT a substitute for a trained PAD model.

    Calibration note: measured against this project's own webcam pipeline,
    genuine live frames land roughly in the 15-60 raw-variance range (varies
    a lot with webcam quality, lighting, and face-crop size.) The /40 divisor
    and threshold below are set to comfortably pass that real-world range,
    not derived from any spoof-attempt dataset. If the real anti-spoof model
    (MiniFASNet etc., see PRODUCTION_SETUP.md) is wired in later, this
    function and the threshold in `verify.js` should be retired entirely
    rather than tuned further — a sharpness heuristic has a hard ceiling on
    how well it can distinguish a photo from a live face."""
    gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    score = np.clip(laplacian_var / 40.0, 0.0, 1.0)
    return float(score)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/extract", dependencies=[Depends(require_internal_token)])
def extract(req: ExtractRequest):
    try:
        img = decode_base64_image(req.image)
    except Exception as e:
        return {"success": False, "error": f"Invalid image: {e}"}

    faces = face_app.get(img)
    if not faces:
        return {"success": False, "error": "No face detected"}

    # Use the largest face in frame (closest to camera) to avoid matching a
    # bystander in the background
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))

    x1, y1, x2, y2 = [int(v) for v in face.bbox]
    x1, y1 = max(0, x1), max(0, y1)
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        return {"success": False, "error": "Face crop out of bounds"}

    liveness_score = passive_liveness_score(crop)

    avatar_b64 = None
    try:
        resized = cv2.resize(crop, (160, 160))
        ok, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if ok:
            avatar_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode()
    except Exception:
        pass

    return {
        "success": True,
        "embedding": face.normed_embedding.tolist(),  # 512-D ArcFace vector
        "liveness": {"isLive": liveness_score >= 0.5, "score": liveness_score},
        "box": {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
        "avatarDataUrl": avatar_b64,
    }


@app.post("/liveness-sequence", dependencies=[Depends(require_internal_token)])
def liveness_sequence(req: LivenessSequenceRequest):
    """Active liveness: checks that face position/yaw actually changes across
    a short frame sequence (e.g. during a 'turn your head' challenge), which
    a static photo cannot satisfy."""
    if len(req.frames) < 3:
        return {"success": False, "error": "Need at least 3 frames"}

    centers = []
    for b64 in req.frames:
        try:
            img = decode_base64_image(b64)
        except Exception:
            continue
        faces = face_app.get(img)
        if not faces:
            continue
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        x1, y1, x2, y2 = face.bbox
        centers.append(((x1 + x2) / 2, (y1 + y2) / 2))

    if len(centers) < 3:
        return {"success": False, "error": "Face not consistently detected across frames"}

    xs = [c[0] for c in centers]
    movement_range = max(xs) - min(xs)

    # Require meaningful horizontal movement (head turn), but not a full jump
    # (which would suggest a frame swap / replay splice)
    is_live = 15 <= movement_range <= 400
    return {"success": True, "isLive": is_live, "movementRange": movement_range}
