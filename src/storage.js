/**
 * Local UI-preference storage only.
 *
 * Employee records, face embeddings, attendance, and audit logs now live
 * server-side (PostgreSQL via the /server API) — nothing biometric or
 * identity-related is kept in the browser anymore.
 */

const SETTINGS_KEY = 'sentinel_ui_settings_v2';

const DEFAULT_SETTINGS = {
  voiceEnabled: true,
  soundFxEnabled: true,
  showLandmarks: true,
  autoScan: true
};

export class StorageService {
  constructor() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.load());
  }

  load() {
    try {
      const data = localStorage.getItem(SETTINGS_KEY);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.warn('Failed reading UI settings from localStorage', e);
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) {
      console.error('Failed saving UI settings', e);
    }
  }

  getSettings() {
    return this.settings;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.save();
    return this.settings;
  }
}

export const storage = new StorageService();
