/**
 * SENTINEL AI — Biometric Face Recognition System
 * Main Orchestration & UI Controller
 *
 * All face matching, liveness enforcement, and employee/attendance/audit data
 * now live on the backend (see /server + /face-engine). This file only
 * captures camera frames, shows guidance/HUD, and talks to the API.
 */

import './style.css';
import confetti from 'canvas-confetti';
import {
  createIcons, icons,
  Scan, UserCheck, ShieldCheck, Clock, Settings, LogOut,
  Volume2, VolumeX, Camera, AlertCircle, CheckCircle2,
  UserPlus, Users, Activity, FileSpreadsheet, Download,
  Upload, Sparkles, RefreshCw, Eye, Lock, Mail
} from 'lucide';

import { faceService } from './faceService.js';
import { storage } from './storage.js';
import { soundSystem } from './audio.js';
import { api } from './api.js';

class BiometricApp {
  constructor() {
    this.currentView = 'login'; // 'login' | 'adminLogin' | 'register' | 'dashboard'
    this.currentSubTab = 'attendance';

    this.videoStream = null;
    this.animationFrameId = null;
    this.isCameraActive = false;
    this.autoScan = storage.getSettings().autoScan;
    this.showLandmarks = storage.getSettings().showLandmarks;

    // Login state
    this.employeeSession = null; // { id, employeeCode, name, role, department, ... }
    this.matchConfidence = 0;
    this.verifyInFlight = false;
    this.lastVerifyAttemptTime = 0;
    this.loginMessage = null;

    // Registration state (admin-only)
    this.capturedSamples = []; // base64 jpeg frames
    this.targetSamples = 3;

    this.settings = storage.getSettings();

    this.appContainer = document.getElementById('app');
    this.init();
  }

  async init() {
    this.renderSkeleton();
    this.initLucideIcons();

    // Try to restore an existing employee session (short-lived JWT)
    if (api.getEmployeeToken()) {
      try {
        const { employee } = await api.getMe();
        this.employeeSession = employee;
        this.currentView = 'dashboard';
      } catch {
        api.employeeLogout();
      }
    }

    try {
      this.showModelLoader('Initializing camera guidance models...');
      await faceService.loadModels((msg) => this.updateModelLoader(msg));
      this.hideModelLoader();
      this.showToast('Camera guidance ready. Face matching runs on the secure server.', 'success');
    } catch (err) {
      console.error('Failed to load guidance models:', err);
      this.hideModelLoader();
      this.showToast('Guidance models failed to load (non-critical — verification still works).', 'warning');
    }

    this.render();

    if (this.currentView === 'login' || this.currentView === 'register') {
      this.startCamera();
    }

    setInterval(() => this.updateClock(), 1000);
  }

  /* --- Shell --- */

  renderSkeleton() {
    this.appContainer.innerHTML = `
      <div id="modelLoader" class="model-loading-overlay">
        <div class="neural-ring-loader"></div>
        <h2 style="font-size: 1.25rem; font-weight: 700; color: #fff;">SENTINEL AI BIOMETRICS</h2>
        <p id="loaderStatusText" style="font-size: 0.85rem; color: var(--cyan-primary); font-family: var(--font-mono);">
          Loading...
        </p>
      </div>

      <header class="app-header">
        <a href="#" class="brand-wrapper" id="brandLogoBtn">
          <div class="brand-icon-box"><i data-lucide="scan"></i></div>
          <div class="brand-title">
            SENTINEL AI
            <span class="brand-sub">Biometric Security Suite</span>
          </div>
        </a>

        <nav class="nav-pills" id="navTabs">
          <button class="nav-pill-btn ${this.currentView === 'login' ? 'active' : ''}" data-view="login">
            <i data-lucide="scan"></i> Face Login
          </button>
          <button class="nav-pill-btn ${this.currentView === 'register' ? 'active' : ''}" data-view="register">
            <i data-lucide="user-plus"></i> Register Employee
          </button>
          <button class="nav-pill-btn ${this.currentView === 'dashboard' ? 'active' : ''}" data-view="dashboard">
            <i data-lucide="shield-check"></i> Dashboard
          </button>
        </nav>

        <div class="header-actions">
          <div class="system-status-chip">
            <span class="pulse-dot"></span>
            <span>SECURE API ONLINE</span>
          </div>
          <button class="icon-btn" id="adminAuthBtn" title="Admin login/logout">
            <i data-lucide="${api.isAdminLoggedIn() ? 'lock' : 'user-check'}"></i>
          </button>
          <button class="icon-btn ${soundSystem.voiceEnabled ? 'active-state' : ''}" id="toggleVoiceBtn" title="Toggle Voice Guidance">
            <i data-lucide="${soundSystem.voiceEnabled ? 'volume-2' : 'volume-x'}"></i>
          </button>
        </div>
      </header>

      <main class="main-content" id="viewContainer"></main>
      <div class="toast-container" id="toastContainer"></div>
    `;

    this.bindHeaderEvents();
  }

  render() {
    const container = document.getElementById('viewContainer');
    if (!container) return;

    document.querySelectorAll('.nav-pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === this.currentView);
    });

    if (this.currentView === 'login') {
      container.innerHTML = this.getLoginViewHTML();
      this.bindLoginEvents();
      soundSystem.speak('Biometric scanner initialized. Please look directly into the camera.');
    } else if (this.currentView === 'adminLogin') {
      container.innerHTML = this.getAdminLoginViewHTML();
      this.bindAdminLoginEvents();
    } else if (this.currentView === 'register') {
      if (!api.isAdminLoggedIn()) {
        container.innerHTML = this.getAdminRequiredHTML('register new employees');
        this.bindAdminRequiredEvents();
      } else {
        container.innerHTML = this.getRegisterViewHTML();
        this.bindRegisterEvents();
        soundSystem.speak('Employee registration mode. Center the employee face to capture biometric samples.');
      }
    } else if (this.currentView === 'dashboard') {
      container.innerHTML = this.getDashboardViewHTML();
      this.bindDashboardEvents();
      this.loadDashboardData();
    }

    this.initLucideIcons();
  }

  /* --- VIEW: FACE LOGIN --- */

  getLoginViewHTML() {
    return `
      <div class="login-view-layout">
        <div class="scanner-viewport-card">
          <div class="scanner-header-bar">
            <div class="scanner-title-group">
              <h2><i data-lucide="camera" style="color: var(--cyan-primary)"></i> Biometric Optical Scanner</h2>
              <p>Live frames are verified server-side against encrypted ArcFace embeddings</p>
            </div>
            <div class="telemetry-badge-group">
              <span class="telemetry-chip" id="fpsDisplay">FPS: 30</span>
              <span class="telemetry-chip" id="livenessTelemetry">SERVER LIVENESS CHECK ACTIVE</span>
            </div>
          </div>

          <div class="video-stage-container" id="videoStage">
            <video id="webcamVideo" class="camera-video" playsinline muted autoplay></video>
            <canvas id="faceCanvas" class="face-canvas-overlay"></canvas>
            <div class="hud-target-reticle" id="targetReticle"></div>

            <div class="guidance-banner" id="guidanceBanner">
              <div class="guidance-text" id="guidanceText">
                <i data-lucide="sparkles" style="color: var(--cyan-primary)"></i>
                <span>Looking for face...</span>
              </div>
              <div class="guidance-voice-waves"><span></span><span></span><span></span></div>
            </div>
          </div>

          <div class="scanner-controls-bar">
            <div style="display: flex; gap: 0.75rem; align-items: center;">
              <button class="btn-primary" id="manualScanBtn">
                <i data-lucide="scan"></i> Scan Face Now
              </button>
              <button class="btn-secondary" id="toggleMeshBtn" title="Toggle Landmark Points">
                <i data-lucide="eye"></i> Landmarks
              </button>
            </div>
            <label class="toggle-switch-label">
              <span>Auto Continuous Scan</span>
              <div class="toggle-switch">
                <input type="checkbox" id="autoScanToggle" ${this.autoScan ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </div>
            </label>
          </div>
        </div>

        <div class="match-status-card" id="matchStatusCard">
          <div class="card-title-bar">
            <h2>Authentication Status</h2>
            <p>512-D ArcFace Matching — verified on the server</p>
          </div>
          <div id="matchCardContent">
            ${this.employeeSession ? this.getMatchedProfileHTML(this.employeeSession, this.matchConfidence) : `
              <div class="verification-radar-display">
                <div class="radar-circle"><i data-lucide="shield-check" class="radar-center-icon"></i></div>
                <h3 style="font-size: 1.1rem; font-weight: 700; color: #fff; margin-bottom: 0.35rem;">Awaiting Facial Vector</h3>
                <p style="font-size: 0.85rem; color: var(--text-muted); max-width: 320px; margin: 0 auto;">
                  Look steadily into the camera. Lighting and an unobstructed face improve match accuracy.
                </p>
              </div>
              <div class="liveness-indicator-box">
                <div>
                  <div style="font-size: 0.85rem; font-weight: 700; color: #fff;">Anti-Spoofing Liveness</div>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">Enforced server-side on every verification</div>
                </div>
                <span class="liveness-badge pending" id="livenessBadge">
                  <i data-lucide="alert-circle"></i> SERVER-SIDE
                </span>
              </div>
              <div style="background: rgba(0,0,0,0.25); border-radius: 12px; padding: 1rem; border: 1px solid var(--border-subtle);">
                <p style="font-size: 0.78rem; color: var(--text-muted);">
                  Not registered yet? Employee enrollment is admin-controlled for security — contact your administrator.
                </p>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  getMatchedProfileHTML(employee, confidence) {
    const avatar = employee.avatarUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80';
    return `
      <div class="verified-profile-box">
        <div class="profile-avatar-circle"><img src="${avatar}" alt="${employee.name}"></div>
        <div class="verified-name">${employee.name}</div>
        <div class="verified-role">${employee.role} — ${employee.department}</div>
        <div class="verified-meta-chips">
          <span class="meta-chip">ID: ${employee.employeeCode}</span>
          <span class="meta-chip">${employee.clearance || 'Level 1'}</span>
          <span class="meta-chip" style="color: var(--emerald-success);">BIOMETRICS VERIFIED</span>
        </div>
        <div class="match-metric-bar">
          <div class="metric-labels">
            <span style="color: var(--text-muted);">Biometric Similarity</span>
            <span style="font-weight: 700; color: var(--emerald-success);">${confidence}%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width: ${confidence}%"></div></div>
        </div>
        <div style="margin-top: 1.25rem; display: flex; gap: 0.75rem;">
          <button class="btn-primary" id="enterDashboardBtn" style="flex: 1; justify-content: center;">
            <i data-lucide="shield-check"></i> Enter Dashboard
          </button>
          <button class="btn-secondary" id="scanAgainBtn" title="Reset Scanner"><i data-lucide="refresh-cw"></i></button>
        </div>
      </div>
    `;
  }

  /* --- VIEW: ADMIN LOGIN --- */

  getAdminLoginViewHTML() {
    return `
      <div style="max-width: 420px; margin: 3rem auto;" class="register-card">
        <div class="card-title-bar">
          <h2><i data-lucide="lock"></i> Administrator Login</h2>
          <p>Required to register employees or view attendance/audit data</p>
        </div>
        <form id="adminLoginForm" class="form-grid">
          <div class="form-group full-width">
            <label class="form-label"><i data-lucide="mail"></i> Admin Email</label>
            <input type="email" id="adminEmail" class="form-input" required>
          </div>
          <div class="form-group full-width">
            <label class="form-label"><i data-lucide="lock"></i> Password</label>
            <input type="password" id="adminPassword" class="form-input" required>
          </div>
          <div class="form-group full-width">
            <button type="submit" class="btn-primary" style="width: 100%; justify-content: center;">
              <i data-lucide="log-out"></i> Sign In
            </button>
          </div>
        </form>
      </div>
    `;
  }

  getAdminRequiredHTML(actionLabel) {
    return `
      <div style="max-width: 480px; margin: 4rem auto; text-align: center;" class="register-card">
        <i data-lucide="lock" style="width: 40px; height: 40px; color: var(--cyan-primary);"></i>
        <h2 style="margin-top: 1rem;">Admin Login Required</h2>
        <p style="color: var(--text-muted); margin-bottom: 1.5rem;">You must be signed in as an administrator to ${actionLabel}.</p>
        <button class="btn-primary" id="goToAdminLoginBtn" style="justify-content: center;">
          <i data-lucide="log-out"></i> Go to Admin Login
        </button>
      </div>
    `;
  }

  bindAdminRequiredEvents() {
    document.getElementById('goToAdminLoginBtn')?.addEventListener('click', () => this.switchView('adminLogin'));
  }

  bindAdminLoginEvents() {
    const form = document.getElementById('adminLoginForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('adminEmail').value.trim();
      const password = document.getElementById('adminPassword').value;
      try {
        await api.adminLogin(email, password);
        this.showToast('Admin signed in.', 'success');
        this.refreshAdminIcon();
        this.switchView('dashboard');
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });
  }

  /* --- VIEW: REGISTER EMPLOYEE (admin-only) --- */

  getRegisterViewHTML() {
    return `
      <div class="register-view-layout">
        <div class="register-card">
          <div class="card-title-bar">
            <h2>Biometric Enrollment Capture</h2>
            <p>Capture 3 face samples (front, angle, smile) sent to the secure ArcFace server</p>
          </div>

          <div id="sampleStepperWrap">${this.getSampleStepperHTML()}</div>

          <div class="video-stage-container" style="aspect-ratio: 4/3;">
            <video id="webcamVideo" class="camera-video" playsinline muted autoplay></video>
            <canvas id="faceCanvas" class="face-canvas-overlay"></canvas>
            <div class="hud-target-reticle" id="targetReticle"></div>
            <div class="guidance-banner">
              <div class="guidance-text" id="guidanceText">
                <i data-lucide="camera" style="color: var(--cyan-primary)"></i>
                <span>Align face within the guide reticle</span>
              </div>
            </div>
          </div>

          <div id="captureControlsWrap" style="margin-top: 1.25rem; display: flex; gap: 0.75rem;">${this.getCaptureControlsHTML()}</div>
        </div>

        <div class="register-card">
          <div class="card-title-bar">
            <h2>Employee Credentials</h2>
            <p>Personnel metadata linked to biometric fingerprint</p>
          </div>

          <form id="employeeRegisterForm" class="form-grid">
            <div class="form-group full-width">
              <label class="form-label" for="empFullName"><i data-lucide="user"></i> Full Legal Name *</label>
              <input type="text" id="empFullName" class="form-input" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="empId"><i data-lucide="shield-check"></i> Employee Code *</label>
              <input type="text" id="empId" class="form-input" value="EMP-${Math.floor(1000 + Math.random() * 9000)}" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="empEmail"><i data-lucide="mail"></i> Corporate Email *</label>
              <input type="email" id="empEmail" class="form-input" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="empDepartment"><i data-lucide="building"></i> Department *</label>
              <select id="empDepartment" class="form-select" required>
                <option value="Artificial Intelligence">Artificial Intelligence</option>
                <option value="Engineering & IT">Engineering & IT</option>
                <option value="Cybersecurity">Cybersecurity</option>
                <option value="Product Design">Product Design</option>
                <option value="Executive Management">Executive Management</option>
                <option value="Operations">Operations</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="empRole"><i data-lucide="briefcase"></i> Designation / Role *</label>
              <input type="text" id="empRole" class="form-input" required>
            </div>
            <div class="form-group full-width">
              <label class="form-label" for="empClearance"><i data-lucide="shield"></i> Security Clearance Level</label>
              <select id="empClearance" class="form-select">
                <option value="Level 1 — Standard Staff">Level 1 — Standard Staff</option>
                <option value="Level 2 — Elevated Access">Level 2 — Elevated Access</option>
                <option value="Level 3 — Confidential Research">Level 3 — Confidential Research</option>
                <option value="Level 4 — High Clearance" selected>Level 4 — High Clearance</option>
                <option value="Level 5 — Top Secret Executive">Level 5 — Top Secret Executive</option>
              </select>
            </div>
            <div class="form-group full-width" style="margin-top: 1rem;">
              <button type="submit" class="btn-primary" id="saveEnrollmentBtn" style="width: 100%; justify-content: center; padding: 0.95rem;">
                <i data-lucide="shield-check"></i> Enroll Biometric Profile
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  getSampleStepperHTML() {
    return `
      <div class="sample-stepper">
        ${[0, 1, 2].map(i => `
          <div class="sample-step-box ${this.capturedSamples.length === i ? 'active' : (this.capturedSamples.length > i ? 'completed' : '')}">
            <div class="step-label">Sample ${i + 1}</div>
            <div class="step-thumb-circle">
              ${this.capturedSamples[i] ? `<img src="${this.capturedSamples[i]}" />` : i + 1}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  getCaptureControlsHTML() {
    return `
      <button class="btn-primary" id="captureSampleBtn" style="flex: 1; justify-content: center;">
        <i data-lucide="camera"></i>
        ${this.capturedSamples.length >= 3 ? 'Recapture Samples' : `Capture Sample (${this.capturedSamples.length + 1}/3)`}
      </button>
      ${this.capturedSamples.length > 0 ? `
        <button class="btn-secondary" id="resetSamplesBtn" title="Reset all samples"><i data-lucide="refresh-cw"></i></button>
      ` : ''}
    `;
  }

  /** Re-renders just the sample stepper + capture controls, leaving the live
   * <video>/<canvas> elements untouched — a full this.render() would recreate
   * them and drop the active camera stream (black screen bug). */
  refreshRegisterCaptureUI() {
    const stepperWrap = document.getElementById('sampleStepperWrap');
    if (stepperWrap) stepperWrap.innerHTML = this.getSampleStepperHTML();

    const controlsWrap = document.getElementById('captureControlsWrap');
    if (controlsWrap) controlsWrap.innerHTML = this.getCaptureControlsHTML();

    this.bindCaptureControlsEvents();
    this.initLucideIcons();
  }

  /* --- VIEW: DASHBOARD --- */

  getDashboardViewHTML() {
    const isAdmin = api.isAdminLoggedIn();
    const session = this.employeeSession;

    return `
      <div class="dashboard-view-layout">
        ${session ? `
          <div class="employee-hero-banner">
            <div class="hero-profile-group">
              <div class="hero-avatar-wrapper">
                <img src="${session.avatarUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'}" alt="${session.name}">
                <div class="hero-badge-verified"><i data-lucide="check"></i></div>
              </div>
              <div class="hero-info-text">
                <h1>${session.name} <span class="status-pill success" style="font-size: 0.75rem;">BIOMETRICALLY VERIFIED</span></h1>
                <p>${session.role} • ${session.department}</p>
                <div class="hero-stats-row">
                  <span class="hero-chip">ID: ${session.employeeCode}</span>
                  <span class="hero-chip">${session.clearance || 'Level 1'}</span>
                  <span class="hero-chip">PORTAL ACTIVE</span>
                </div>
              </div>
            </div>
            <div class="hero-clock-actions">
              <div class="digital-time-clock" id="liveDigitalClock">00:00:00</div>
              <div style="display: flex; gap: 0.75rem;">
                <button class="btn-primary" id="clockOutBtn"><i data-lucide="clock"></i> Clock Out Shift</button>
                <button class="btn-secondary" id="logoutBtn" title="Lock & Logout"><i data-lucide="log-out"></i> Logout</button>
              </div>
            </div>
          </div>
        ` : `
          <div class="employee-hero-banner">
            <div class="hero-info-text">
              <h1>Administrator Console</h1>
              <p>Signed in as admin — no face session active</p>
            </div>
          </div>
        `}

        ${isAdmin ? `
          <div class="dashboard-subtabs">
            <button class="subtab-btn ${this.currentSubTab === 'attendance' ? 'active' : ''}" data-subtab="attendance"><i data-lucide="clock"></i> Attendance Records</button>
            <button class="subtab-btn ${this.currentSubTab === 'audit' ? 'active' : ''}" data-subtab="audit"><i data-lucide="shield"></i> Security Audit Trail</button>
            <button class="subtab-btn ${this.currentSubTab === 'directory' ? 'active' : ''}" data-subtab="directory"><i data-lucide="users"></i> Employee Directory</button>
          </div>
          <div id="subtabContent"><div style="padding: 2rem; text-align: center; color: var(--text-muted);">Loading...</div></div>
        ` : `
          <div class="register-card" style="text-align: center; color: var(--text-muted);">
            Admin login required to view attendance records, audit trail, or employee directory.
          </div>
        `}
      </div>
    `;
  }

  async loadDashboardData() {
    if (!api.isAdminLoggedIn()) return;
    const contentEl = document.getElementById('subtabContent');
    if (!contentEl) return;

    try {
      if (this.currentSubTab === 'attendance') {
        const { records } = await api.listAttendance();
        this.cachedAttendance = records;
        contentEl.innerHTML = this.renderAttendanceTable(records);
        document.getElementById('exportCsvBtn')?.addEventListener('click', () => this.exportAttendanceCSV(records));
      } else if (this.currentSubTab === 'audit') {
        const { logs } = await api.listAudit();
        contentEl.innerHTML = this.renderAuditTable(logs);
      } else if (this.currentSubTab === 'directory') {
        const { employees } = await api.listEmployees();
        contentEl.innerHTML = this.renderDirectory(employees);
        document.querySelectorAll('.delete-emp-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            if (confirm("Deactivate this employee's biometric access?")) {
              await api.deactivateEmployee(id);
              this.showToast('Employee deactivated.', 'success');
              this.loadDashboardData();
            }
          });
        });
      }
      this.initLucideIcons();
    } catch (err) {
      contentEl.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--ruby-danger);">${err.message}</div>`;
    }
  }

  renderAttendanceTable(records) {
    return `
      <div class="table-container">
        <div class="table-toolbar">
          <div style="font-weight: 700; color: #fff;">Attendance Shift History</div>
          <button class="btn-secondary" id="exportCsvBtn" style="font-size: 0.82rem;"><i data-lucide="file-spreadsheet"></i> Export CSV</button>
        </div>
        <table class="custom-table">
          <thead><tr><th>Date</th><th>Employee</th><th>Time In</th><th>Time Out</th><th>Confidence</th><th>Status</th></tr></thead>
          <tbody>
            ${records.length === 0 ? `<tr><td colspan="6" style="text-align:center; padding:2rem; color: var(--text-muted);">No attendance records yet.</td></tr>` :
              records.map(r => `
                <tr>
                  <td style="font-family: var(--font-mono);">${r.date}</td>
                  <td style="font-weight: 600;">${r.employee?.name || 'Unknown'}</td>
                  <td style="font-family: var(--font-mono); color: var(--emerald-success);">${new Date(r.timeIn).toLocaleTimeString()}</td>
                  <td style="font-family: var(--font-mono);">${r.timeOut ? new Date(r.timeOut).toLocaleTimeString() : '<span class="status-pill warning">Shift Active</span>'}</td>
                  <td><span class="status-pill success">${r.confidence}% Verified</span></td>
                  <td><span class="status-pill ${r.timeOut ? 'success' : 'warning'}">${r.status}</span></td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  renderAuditTable(logs) {
    return `
      <div class="table-container">
        <div class="table-toolbar"><div style="font-weight: 700; color: #fff;">Real-Time Biometric Audit Trail</div></div>
        <table class="custom-table">
          <thead><tr><th>Timestamp</th><th>Event</th><th>Subject</th><th>Confidence</th><th>Details</th></tr></thead>
          <tbody>
            ${logs.length === 0 ? `<tr><td colspan="5" style="text-align:center; padding:2rem; color: var(--text-muted);">No security events recorded.</td></tr>` :
              logs.map(l => `
                <tr>
                  <td style="font-family: var(--font-mono); font-size: 0.8rem;">${new Date(l.createdAt).toLocaleString()}</td>
                  <td><span class="status-pill ${l.type === 'ACCESS_GRANTED' ? 'success' : (l.type.includes('DENIED') || l.type.includes('ALERT') || l.type.includes('LOCKOUT') ? 'danger' : 'warning')}">${l.type}</span></td>
                  <td style="font-weight: 600;">${l.employee?.name || 'Unknown Subject'}</td>
                  <td style="font-family: var(--font-mono);">${l.confidence != null ? l.confidence + '%' : '—'}</td>
                  <td style="color: var(--text-muted); font-size: 0.85rem;">${l.notes}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  renderDirectory(employees) {
    return `
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.25rem;">
        ${employees.map(emp => `
          <div class="kpi-card" style="padding: 1.5rem;">
            <div style="display: flex; gap: 1rem; align-items: center;">
              <div style="width: 58px; height: 58px; border-radius: 50%; overflow: hidden; border: 2px solid var(--cyan-primary); background: #000;">
                <img src="${emp.avatarUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'}" style="width: 100%; height: 100%; object-fit: cover;" alt="${emp.name}">
              </div>
              <div>
                <h3 style="font-size: 1.05rem; font-weight: 700; color: #fff;">${emp.name}</h3>
                <div style="font-size: 0.8rem; color: var(--cyan-primary); font-weight: 600;">${emp.role}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">${emp.department}</div>
              </div>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap;">
              <span class="meta-chip">ID: ${emp.employeeCode}</span>
              <span class="meta-chip">${emp.clearance || 'Level 1'}</span>
              <span class="meta-chip" style="color: var(--emerald-success);">${emp._count?.embeddings ?? 0} Samples</span>
              <span class="meta-chip" style="color: ${emp.active ? 'var(--emerald-success)' : 'var(--ruby-danger)'};">${emp.active ? 'Active' : 'Deactivated'}</span>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 1.25rem; border-top: 1px solid var(--border-subtle); padding-top: 1rem;">
              <button class="btn-secondary delete-emp-btn" data-id="${emp.id}" style="flex: 1; justify-content: center; font-size: 0.8rem; color: var(--ruby-danger);">
                <i data-lucide="alert-circle"></i> Deactivate
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  /* --- Camera & Detection Pipeline (UX only) --- */

  async startCamera() {
    const video = document.getElementById('webcamVideo');
    if (!video) return;

    try {
      if (this.videoStream) this.stopCamera();

      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });

      video.srcObject = this.videoStream;
      await video.play();

      this.isCameraActive = true;
      this.startFaceDetectionLoop();
    } catch (err) {
      console.warn('Webcam access error:', err);
      this.isCameraActive = false;
      this.updateGuidance('Camera permission required to continue.');
      this.showToast('Camera access blocked. Check browser permissions.', 'warning');
    }
  }

  stopCamera() {
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
      this.videoStream = null;
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.isCameraActive = false;
  }

  startFaceDetectionLoop() {
    const video = document.getElementById('webcamVideo');
    const canvas = document.getElementById('faceCanvas');
    const reticle = document.getElementById('targetReticle');
    if (!video || !canvas) return;

    let lastTime = performance.now();
    let frameCount = 0;

    const detectLoop = async () => {
      if (!this.isCameraActive) return;

      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
      }

      frameCount++;
      const now = performance.now();
      if (now - lastTime >= 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastTime));
        frameCount = 0;
        lastTime = now;
        const fpsEl = document.getElementById('fpsDisplay');
        if (fpsEl) fpsEl.textContent = `FPS: ${fps}`;
      }

      try {
        const detection = await faceService.detectFace(video);

        if (detection) {
          const alignment = faceService.evaluateAlignment(detection.landmarks, video.videoWidth, video.videoHeight, detection.detection.box);
          if (reticle) reticle.className = `hud-target-reticle ${alignment.status === 'GOOD' ? 'aligned' : 'warning'}`;

          faceService.checkLivenessForUI(detection.landmarks);

          if (this.currentView === 'login' && this.autoScan && !this.employeeSession && alignment.status === 'GOOD') {
            const timeSinceLastAttempt = Date.now() - this.lastVerifyAttemptTime;
            if (timeSinceLastAttempt > 1500 && !this.verifyInFlight) {
              this.lastVerifyAttemptTime = Date.now();
              this.runFaceVerification(video);
            }
          }

          faceService.drawBiometricOverlay(canvas, detection, {
            isMatched: Boolean(this.employeeSession),
            matchName: this.employeeSession ? this.employeeSession.name : null,
            isScanning: !this.employeeSession,
            showLandmarks: this.showLandmarks,
            scanTime: Date.now()
          });

          if (!this.employeeSession) {
            if (this.loginMessage) {
              this.updateGuidance(this.loginMessage);
            } else if (alignment.status !== 'GOOD') {
              this.updateGuidance(alignment.message);
            } else {
              this.updateGuidance('Face acquired. Verifying with secure server...');
            }
          }
        } else {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (reticle) reticle.className = 'hud-target-reticle';
          this.updateGuidance('Position face inside the biometric frame');
        }
      } catch (err) {
        console.warn('Detect loop error:', err);
      }

      this.animationFrameId = requestAnimationFrame(detectLoop);
    };

    detectLoop();
  }

  /* --- Server-side verification --- */

  async captureVerificationBurst(videoElement, count = 3, intervalMs = 180) {
    const frames = [];
    for (let i = 0; i < count; i++) {
      frames.push(faceService.captureFrameBase64(videoElement));
      if (i < count - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return frames;
  }

  async runFaceVerification(videoElement) {
    this.verifyInFlight = true;
    try {
      this.updateGuidance('Hold still — capturing verification burst...');
      const frames = await this.captureVerificationBurst(videoElement);
      const result = await api.verifyFace(frames);

      this.employeeSession = result.employee;
      this.matchConfidence = result.confidence;
      this.loginMessage = null;

      soundSystem.playAccessGranted();
      soundSystem.speak(`Identity verified. Welcome back, ${result.employee.name}. Access granted!`, true);
      confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });

      const matchCardContent = document.getElementById('matchCardContent');
      if (matchCardContent) {
        matchCardContent.innerHTML = this.getMatchedProfileHTML(result.employee, result.confidence);
        this.bindMatchCardEvents();
        this.initLucideIcons();
      }

      this.showToast(`Access Granted: ${result.employee.name} (${result.confidence}%)`, 'success');
    } catch (err) {
      this.loginMessage = err.message;
      // Only play denial sound/voice for genuine denials, not transient "no face detected"
      if (!/no face detected/i.test(err.message)) {
        soundSystem.playAccessDenied();
        soundSystem.speak(err.message);
        this.showToast(err.message, 'error');
      }
    } finally {
      this.verifyInFlight = false;
    }
  }

  /* --- Event Handlers --- */

  bindHeaderEvents() {
    document.getElementById('navTabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-pill-btn');
      if (btn) this.switchView(btn.dataset.view);
    });

    document.getElementById('brandLogoBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.switchView('login');
    });

    document.getElementById('toggleVoiceBtn')?.addEventListener('click', (e) => {
      soundSystem.voiceEnabled = !soundSystem.voiceEnabled;
      const btn = e.currentTarget;
      btn.classList.toggle('active-state', soundSystem.voiceEnabled);
      btn.innerHTML = `<i data-lucide="${soundSystem.voiceEnabled ? 'volume-2' : 'volume-x'}"></i>`;
      this.initLucideIcons();
      if (soundSystem.voiceEnabled) soundSystem.speak('Voice guidance enabled.');
      else soundSystem.stopSpeaking();
    });

    document.getElementById('adminAuthBtn')?.addEventListener('click', () => {
      if (api.isAdminLoggedIn()) {
        api.adminLogout();
        this.showToast('Admin signed out.', 'success');
        this.refreshAdminIcon();
        this.render();
      } else {
        this.switchView('adminLogin');
      }
    });
  }

  /** Update just the admin lock icon, without rebuilding the whole header
   * (renderSkeleton() recreates the model-loading overlay, which would get
   * stuck visible since models are already loaded and nothing hides it again). */
  refreshAdminIcon() {
    const btn = document.getElementById('adminAuthBtn');
    if (btn) {
      btn.innerHTML = `<i data-lucide="${api.isAdminLoggedIn() ? 'lock' : 'user-check'}"></i>`;
      this.initLucideIcons();
    }
  }

  bindLoginEvents() {
    document.getElementById('manualScanBtn')?.addEventListener('click', async () => {
      soundSystem.playLaserSweep();
      const video = document.getElementById('webcamVideo');
      if (!video || this.verifyInFlight) return;
      this.runFaceVerification(video);
    });

    document.getElementById('toggleMeshBtn')?.addEventListener('click', (e) => {
      this.showLandmarks = !this.showLandmarks;
      storage.updateSettings({ showLandmarks: this.showLandmarks });
      e.currentTarget.classList.toggle('active-state', this.showLandmarks);
      this.showToast(this.showLandmarks ? 'Landmark mesh enabled' : 'Landmark mesh disabled');
    });

    document.getElementById('autoScanToggle')?.addEventListener('change', (e) => {
      this.autoScan = e.target.checked;
      storage.updateSettings({ autoScan: this.autoScan });
      this.showToast(this.autoScan ? 'Continuous scan enabled' : 'Manual scan mode');
    });
  }

  bindMatchCardEvents() {
    document.getElementById('enterDashboardBtn')?.addEventListener('click', () => this.switchView('dashboard'));
    document.getElementById('scanAgainBtn')?.addEventListener('click', () => {
      this.employeeSession = null;
      this.matchConfidence = 0;
      this.loginMessage = null;
      api.employeeLogout();
      faceService.resetLiveness();
      this.render();
    });
  }

  bindCaptureControlsEvents() {
    document.getElementById('captureSampleBtn')?.addEventListener('click', async () => {
      const video = document.getElementById('webcamVideo');
      if (!video) return;

      soundSystem.playCameraSnap();
      const detection = await faceService.detectFace(video);
      if (!detection) {
        this.showToast('No face detected. Please face the camera directly.', 'error');
        soundSystem.speak('No face detected. Please face the camera.');
        return;
      }

      const frame = faceService.captureFrameBase64(video);
      this.capturedSamples.push(frame);

      soundSystem.playTargetLock();
      const idx = this.capturedSamples.length;
      this.showToast(`Sample ${idx}/3 captured!`, 'success');
      if (idx === 1) soundSystem.speak('Sample 1 captured. Now turn your head slightly for sample 2.');
      else if (idx === 2) soundSystem.speak('Sample 2 captured. Now smile naturally for sample 3.');
      else soundSystem.speak('All samples captured! Complete the form to enroll.');

      this.refreshRegisterCaptureUI();
    });

    document.getElementById('resetSamplesBtn')?.addEventListener('click', () => {
      this.capturedSamples = [];
      this.refreshRegisterCaptureUI();
      this.showToast('Biometric samples reset.');
    });
  }

  bindRegisterEvents() {
    this.bindCaptureControlsEvents();

    document.getElementById('employeeRegisterForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (this.capturedSamples.length === 0) {
        this.showToast('Please capture at least 1 face sample first!', 'error');
        soundSystem.speak('Please capture a facial sample before enrolling.');
        return;
      }

      const payload = {
        employeeCode: document.getElementById('empId').value.trim(),
        name: document.getElementById('empFullName').value.trim(),
        email: document.getElementById('empEmail').value.trim(),
        department: document.getElementById('empDepartment').value,
        role: document.getElementById('empRole').value.trim(),
        clearance: document.getElementById('empClearance').value,
        images: this.capturedSamples
      };

      try {
        const { employee } = await api.enrollEmployee(payload);
        soundSystem.playAccessGranted();
        soundSystem.speak(`Congratulations, ${employee.name}. Biometric profile registered.`, true);
        confetti({ particleCount: 100, spread: 80, origin: { y: 0.5 } });
        this.showToast(`Enrolled ${employee.name} successfully!`, 'success');
        this.capturedSamples = [];
        setTimeout(() => this.switchView('dashboard'), 1200);
      } catch (err) {
        soundSystem.speak(err.message);
        this.showToast(err.message, 'error');
      }
    });
  }

  bindDashboardEvents() {
    this.updateClock();

    document.getElementById('clockOutBtn')?.addEventListener('click', async () => {
      try {
        await api.clockOut();
        soundSystem.playTargetLock();
        soundSystem.speak('Shift clocked out. Have a wonderful rest of your day!');
        this.showToast('Clocked out successfully!', 'success');
        this.loadDashboardData();
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('logoutBtn')?.addEventListener('click', () => {
      api.employeeLogout();
      this.employeeSession = null;
      soundSystem.speak('Session locked. Goodbye.');
      this.showToast('Logged out securely.', 'success');
      this.switchView('login');
    });

    document.querySelectorAll('.subtab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentSubTab = btn.dataset.subtab;
        this.render();
      });
    });
  }

  /* --- Navigation --- */

  switchView(newView) {
    if (this.currentView === newView) return;

    if (newView === 'dashboard' || newView === 'adminLogin') this.stopCamera();

    this.currentView = newView;
    this.render();

    if (newView === 'login' || newView === 'register') this.startCamera();
  }

  /* --- Helpers --- */

  updateGuidance(text) {
    const el = document.getElementById('guidanceText');
    if (el) {
      el.innerHTML = `<i data-lucide="sparkles" style="color: var(--cyan-primary)"></i> <span>${text}</span>`;
      this.initLucideIcons();
    }
  }

  updateClock() {
    const clockEl = document.getElementById('liveDigitalClock');
    if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  exportAttendanceCSV(records) {
    if (!records || records.length === 0) {
      this.showToast('No attendance records to export.', 'warning');
      return;
    }
    const headers = ['Employee Code', 'Employee Name', 'Department', 'Date', 'Time In', 'Time Out', 'Confidence', 'Status'];
    const rows = records.map(r => [
      r.employee?.employeeCode, `"${r.employee?.name}"`, `"${r.employee?.department}"`,
      r.date, new Date(r.timeIn).toLocaleTimeString(), r.timeOut ? new Date(r.timeOut).toLocaleTimeString() : 'Active',
      `${r.confidence}%`, r.status
    ]);
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Attendance CSV downloaded.', 'success');
  }

  showModelLoader(statusText) {
    const loader = document.getElementById('modelLoader');
    if (loader) loader.style.display = 'flex';
    this.updateModelLoader(statusText);
  }

  updateModelLoader(text) {
    const el = document.getElementById('loaderStatusText');
    if (el) el.textContent = text;
  }

  hideModelLoader() {
    const loader = document.getElementById('modelLoader');
    if (loader) {
      loader.style.opacity = '0';
      loader.style.transition = 'opacity 0.5s ease';
      setTimeout(() => loader.style.display = 'none', 500);
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <i data-lucide="${type === 'success' ? 'check-circle-2' : (type === 'error' ? 'alert-circle' : 'sparkles')}"></i>
      <span>${message}</span>
    `;

    container.appendChild(toast);
    this.initLucideIcons();

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  initLucideIcons() {
    createIcons({ icons });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new BiometricApp();
});
