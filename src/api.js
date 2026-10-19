/**
 * Backend API client. All face matching, liveness enforcement, and data
 * storage now happen server-side — this module is just a thin HTTP wrapper.
 */

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000/api';

const TOKEN_KEYS = {
  ADMIN: 'sentinel_admin_token',
  EMPLOYEE: 'sentinel_employee_token'
};

function getToken(key) {
  return localStorage.getItem(key);
}

function setToken(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error('Cannot reach the biometric server. Is the backend running?');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  // --- Admin auth ---
  getAdminToken: () => getToken(TOKEN_KEYS.ADMIN),
  setAdminToken: (t) => setToken(TOKEN_KEYS.ADMIN, t),
  isAdminLoggedIn: () => Boolean(getToken(TOKEN_KEYS.ADMIN)),

  async adminLogin(email, password) {
    const data = await request('/auth/admin/login', { method: 'POST', body: { email, password } });
    this.setAdminToken(data.token);
    return data.admin;
  },

  adminLogout() {
    this.setAdminToken(null);
  },

  // --- Employee session (set after a successful face verify) ---
  getEmployeeToken: () => getToken(TOKEN_KEYS.EMPLOYEE),
  setEmployeeToken: (t) => setToken(TOKEN_KEYS.EMPLOYEE, t),

  async getMe() {
    return request('/me', { token: this.getEmployeeToken() });
  },

  employeeLogout() {
    this.setEmployeeToken(null);
  },

  // --- Face verification (login) ---
  // `images` is a short burst of 2+ frames — the server rejects identical
  // frames (static photo replay) and checks identity consistency across them.
  async verifyFace(imagesBase64) {
    const data = await request('/verify', { method: 'POST', body: { images: imagesBase64 } });
    this.setEmployeeToken(data.token);
    return data;
  },

  async clockOut() {
    return request('/attendance/clock-out', { method: 'POST', token: this.getEmployeeToken() });
  },

  // --- Admin-only management ---
  async enrollEmployee(payload) {
    return request('/enroll', { method: 'POST', body: payload, token: this.getAdminToken() });
  },

  async listEmployees() {
    return request('/employees', { token: this.getAdminToken() });
  },

  async deactivateEmployee(id) {
    return request(`/employees/${id}`, { method: 'DELETE', token: this.getAdminToken() });
  },

  async listAttendance() {
    return request('/attendance', { token: this.getAdminToken() });
  },

  async listAudit() {
    return request('/audit', { token: this.getAdminToken() });
  }
};
