import axios from 'axios';
import { API_BASE } from './constants';

const apiClient = axios.create();

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('fx_access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const { data } = await axios.post(
          `${API_BASE.AUTH}/auth/refresh`,
          {},
          { withCredentials: true }
        );
        localStorage.setItem('fx_access_token', data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return apiClient(original);
      } catch {
        localStorage.removeItem('fx_access_token');
        localStorage.removeItem('fx_user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;