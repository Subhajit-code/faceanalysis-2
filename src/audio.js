/**
 * Biometric Audio & Voice Guidance System
 * Provides synthetic audio SFX using Web Audio API and voice guidance via Web Speech API.
 */

class BiometricAudioSystem {
  constructor() {
    this.audioCtx = null;
    this.speechSynth = window.speechSynthesis;
    this.voiceEnabled = true;
    this.soundFxEnabled = true;
    this.voiceVolume = 1.0;
    this.voicePitch = 1.0;
    this.voiceRate = 1.0;
    this.selectedVoice = null;
    this.voices = [];
    this.lastSpokenText = '';
    this.lastSpokenTime = 0;

    this.initVoices();
  }

  // Initialize Web Audio Context lazily on user interaction
  getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  initVoices() {
    if (!this.speechSynth) return;

    const loadVoices = () => {
      this.voices = this.speechSynth.getVoices();
      // Try to find a premium/natural English voice
      const preferred = this.voices.find(v => 
        (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Jenny') || v.name.includes('Karen') || v.name.includes('Zira')) && v.lang.startsWith('en')
      ) || this.voices.find(v => v.lang.startsWith('en')) || this.voices[0];
      
      this.selectedVoice = preferred || null;
    };

    loadVoices();
    if (this.speechSynth.onvoiceschanged !== undefined) {
      this.speechSynth.onvoiceschanged = loadVoices;
    }
  }

  setVoice(voiceName) {
    const v = this.voices.find(item => item.name === voiceName);
    if (v) this.selectedVoice = v;
  }

  getVoices() {
    return this.voices;
  }

  /**
   * Speak a prompt to guide the user
   * @param {string} text - Message to speak
   * @param {boolean} force - Force speak even if throttled
   */
  speak(text, force = false) {
    if (!this.voiceEnabled || !this.speechSynth) return;

    const now = Date.now();
    // Prevent repeating the exact same phrase within 3 seconds unless forced
    if (!force && this.lastSpokenText === text && (now - this.lastSpokenTime) < 3000) {
      return;
    }

    // Cancel current queue if it's high priority guidance
    if (force) {
      this.speechSynth.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (this.selectedVoice) {
      utterance.voice = this.selectedVoice;
    }
    utterance.volume = this.voiceVolume;
    utterance.pitch = this.voicePitch;
    utterance.rate = this.voiceRate;

    this.lastSpokenText = text;
    this.lastSpokenTime = now;

    this.speechSynth.speak(utterance);
  }

  stopSpeaking() {
    if (this.speechSynth) {
      this.speechSynth.cancel();
    }
  }

  /* --- Web Audio Synthetic SFX --- */

  playLaserSweep() {
    if (!this.soundFxEnabled) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.18);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.35);

      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.36);
    } catch (e) {
      console.warn('Audio SFX error', e);
    }
  }

  playTargetLock() {
    if (!this.soundFxEnabled) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      [880, 1174].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.08);

        gain.gain.setValueAtTime(0.08, now + i * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.12);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.13);
      });
    } catch (e) {
      console.warn('Audio SFX error', e);
    }
  }

  playAccessGranted() {
    if (!this.soundFxEnabled) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 chord
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);

        gain.gain.setValueAtTime(0.12, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.5);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.55);
      });
    } catch (e) {
      console.warn('Audio SFX error', e);
    }
  }

  playAccessDenied() {
    if (!this.soundFxEnabled) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      [220, 185].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + idx * 0.15);

        gain.gain.setValueAtTime(0.15, now + idx * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.15 + 0.25);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.15);
        osc.stop(now + idx * 0.15 + 0.28);
      });
    } catch (e) {
      console.warn('Audio SFX error', e);
    }
  }

  playCameraSnap() {
    if (!this.soundFxEnabled) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1400, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.09);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.09);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    } catch (e) {
      console.warn('Audio SFX error', e);
    }
  }
}

export const soundSystem = new BiometricAudioSystem();
