/**
 * Client-side face UX helper.
 *
 * IMPORTANT: this module no longer performs face recognition matching or
 * extracts biometric descriptors — that is deliberately server-side only now
 * (see /face-engine and /server), so a browser devtools user cannot read
 * thresholds, other employees' embeddings, or bypass matching logic.
 *
 * This module only does: lightweight local face detection for alignment/
 * guidance HUD, blink detection for *UX feedback* (the real liveness
 * enforcement happens server-side), and capturing frames as base64 JPEG to
 * send to the backend.
 */

import * as faceapi from '@vladmandic/face-api';

class FaceUXService {
  constructor() {
    this.modelsLoaded = false;
    this.modelsLoadingPromise = null;

    this.isBlinkDetected = false;
    this.consecutiveClosedFrames = 0;
  }

  /**
   * Load only the lightweight detector + landmark models needed for guidance.
   * No recognition model is loaded in the browser.
   */
  async loadModels(onProgress = null) {
    if (this.modelsLoaded) return true;
    if (this.modelsLoadingPromise) return this.modelsLoadingPromise;

    this.modelsLoadingPromise = (async () => {
      const MODEL_URL = '/models';
      if (onProgress) onProgress('Loading face detector...');
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);

      if (onProgress) onProgress('Loading landmark mesh...');
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);

      this.modelsLoaded = true;
      if (onProgress) onProgress('Ready.');
      return true;
    })();

    return this.modelsLoadingPromise;
  }

  getDetectorOptions() {
    return new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
  }

  /**
   * Detection for UI guidance only (alignment reticle, blink animation).
   * Does NOT return a biometric descriptor.
   */
  async detectFace(inputElement) {
    if (!this.modelsLoaded) return null;
    try {
      const detection = await faceapi
        .detectSingleFace(inputElement, this.getDetectorOptions())
        .withFaceLandmarks();
      return detection || null;
    } catch (err) {
      console.warn('Face detection error:', err);
      return null;
    }
  }

  calculateEAR(eyePoints) {
    const dist = (pA, pB) => Math.hypot(pA.x - pB.x, pA.y - pB.y);
    const verticalA = dist(eyePoints[1], eyePoints[5]);
    const verticalB = dist(eyePoints[2], eyePoints[4]);
    const horizontal = dist(eyePoints[0], eyePoints[3]);
    if (horizontal === 0) return 0.3;
    return (verticalA + verticalB) / (2.0 * horizontal);
  }

  /** UX-only blink animation trigger — NOT a security control. */
  checkLivenessForUI(landmarks) {
    if (!landmarks) return { ear: 0, blinkDetected: false };
    const leftEAR = this.calculateEAR(landmarks.getLeftEye());
    const rightEAR = this.calculateEAR(landmarks.getRightEye());
    const avgEAR = (leftEAR + rightEAR) / 2.0;
    const EYE_CLOSED_THRESHOLD = 0.2;

    if (avgEAR < EYE_CLOSED_THRESHOLD) {
      this.consecutiveClosedFrames++;
    } else {
      if (this.consecutiveClosedFrames >= 1 && this.consecutiveClosedFrames <= 6) {
        this.isBlinkDetected = true;
      }
      this.consecutiveClosedFrames = 0;
    }

    return { ear: Number(avgEAR.toFixed(3)), blinkDetected: this.isBlinkDetected };
  }

  resetLiveness() {
    this.isBlinkDetected = false;
    this.consecutiveClosedFrames = 0;
  }

  evaluateAlignment(landmarks, videoWidth, videoHeight, box) {
    const nose = landmarks.getNose();
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();

    const eyeCenterX = (leftEye[0].x + rightEye[3].x) / 2;
    const noseTip = nose[3] || nose[0];
    const eyeDistX = Math.abs(rightEye[3].x - leftEye[0].x);
    const noseOffset = (noseTip.x - eyeCenterX) / (eyeDistX || 1);
    const faceCoverage = (box.width * box.height) / (videoWidth * videoHeight);

    let status = 'GOOD';
    let message = 'Face centered and aligned';

    if (faceCoverage < 0.08) {
      status = 'TOO_FAR';
      message = 'Please move closer to camera';
    } else if (faceCoverage > 0.65) {
      status = 'TOO_CLOSE';
      message = 'Please step back slightly';
    } else if (noseOffset < -0.15) {
      status = 'TURNED_LEFT';
      message = 'Turn head slightly right to center';
    } else if (noseOffset > 0.15) {
      status = 'TURNED_RIGHT';
      message = 'Turn head slightly left to center';
    }

    return { status, message, faceCoverage: Math.round(faceCoverage * 100) };
  }

  /** Capture the current video frame as a base64 JPEG for the backend. */
  captureFrameBase64(videoElement, quality = 0.9) {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  captureFaceThumbnail(videoElement, box) {
    try {
      const canvas = document.createElement('canvas');
      const size = 160;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      const padX = box.width * 0.2;
      const padY = box.height * 0.25;
      const cropX = Math.max(0, box.x - padX);
      const cropY = Math.max(0, box.y - padY);
      const cropW = Math.min(videoElement.videoWidth - cropX, box.width + padX * 2);
      const cropH = Math.min(videoElement.videoHeight - cropY, box.height + padY * 2);

      ctx.drawImage(videoElement, cropX, cropY, cropW, cropH, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      console.warn('Could not capture thumbnail', e);
      return null;
    }
  }

  /** Futuristic biometric HUD overlay — purely visual. */
  drawBiometricOverlay(canvas, detection, options = {}) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!detection) return;

    const { box } = detection.detection;
    const { x, y, width: w, height: h } = box;
    const isMatched = options.isMatched || false;
    const isScanning = options.isScanning !== undefined ? options.isScanning : true;
    const scanTime = options.scanTime || Date.now();

    let primaryColor = '#00f2fe';
    let secondaryColor = 'rgba(0, 242, 254, 0.15)';
    if (isMatched) {
      primaryColor = '#10b981';
      secondaryColor = 'rgba(16, 185, 129, 0.2)';
    } else if (options.isDenied) {
      primaryColor = '#f43f5e';
      secondaryColor = 'rgba(244, 63, 94, 0.2)';
    }

    const bracketLen = Math.min(w, h) * 0.22;
    ctx.save();
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 3.5;
    ctx.shadowColor = primaryColor;
    ctx.shadowBlur = 12;

    ctx.beginPath();
    ctx.moveTo(x, y + bracketLen);
    ctx.lineTo(x, y);
    ctx.lineTo(x + bracketLen, y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + w - bracketLen, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + bracketLen);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x, y + h - bracketLen);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + bracketLen, y + h);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + w - bracketLen, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - bracketLen);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.strokeStyle = secondaryColor;
    ctx.strokeRect(x, y, w, h);

    if (isScanning && !isMatched && !options.isDenied) {
      const scanPeriod = 1600;
      const cycleProgress = (scanTime % scanPeriod) / scanPeriod;
      const scanPos = cycleProgress < 0.5 ? cycleProgress * 2 : (1 - cycleProgress) * 2;
      const scanY = y + h * scanPos;

      const grad = ctx.createLinearGradient(x, scanY - 14, x, scanY + 14);
      grad.addColorStop(0, 'rgba(0, 242, 254, 0)');
      grad.addColorStop(0.5, 'rgba(0, 242, 254, 0.45)');
      grad.addColorStop(1, 'rgba(0, 242, 254, 0)');

      ctx.fillStyle = grad;
      ctx.fillRect(x, scanY - 14, w, 28);

      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#00f2fe';
      ctx.shadowBlur = 15;
      ctx.moveTo(x, scanY);
      ctx.lineTo(x + w, scanY);
      ctx.stroke();
    }

    if (options.showLandmarks && detection.landmarks) {
      const positions = detection.landmarks.positions;
      ctx.fillStyle = isMatched ? '#34d399' : '#38bdf8';
      ctx.shadowBlur = 4;
      ctx.shadowColor = ctx.fillStyle;

      positions.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, 2 * Math.PI);
        ctx.fill();
      });
    }

    const tagText = isMatched
      ? `VERIFIED: ${options.matchName || 'EMPLOYEE'}`
      : (options.isDenied ? 'ACCESS DENIED' : 'ANALYZING BIOMETRICS');

    ctx.font = '600 12px "JetBrains Mono", monospace';
    const textWidth = ctx.measureText(tagText).width;
    const tagBgH = 22;
    const tagBgW = textWidth + 18;

    ctx.fillStyle = isMatched ? 'rgba(6, 78, 59, 0.9)' : (options.isDenied ? 'rgba(136, 19, 55, 0.9)' : 'rgba(15, 23, 42, 0.85)');
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + (w - tagBgW) / 2, y + h + 8, tagBgW, tagBgH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(tagText, x + (w - tagBgW) / 2 + 9, y + h + 23);

    ctx.restore();
  }
}

export const faceService = new FaceUXService();
