/**
 * Typed fetch helpers for the dashboard.
 *
 * Every call funnels through `request` so a failed API call surfaces the
 * server's own error message instead of a bare "Failed to fetch".
 */

import type {
  JobManifest,
  JobOptions,
  JobRow,
  JobStats,
  LiveProgress,
  LogEntry,
  ScrapeInput,
} from '@/types/dashboard';
import type { ValidationReport } from '@/lib/validation/uploadSchema';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type for string bodies. A FormData body MUST set
  // its own `multipart/form-data; boundary=…` header — forcing application/json
  // here strips the boundary and the server can no longer parse the upload.
  const isJsonBody = typeof init?.body === 'string';

  const response = await fetch(url, {
    ...init,
    headers: {
      ...(isJsonBody ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  const body = text ? safeParse(text) : null;

  if (!response.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : null) ?? `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type JobSummary = JobManifest & { stats: JobStats };

export const api = {
  listJobs: () => request<{ jobs: JobSummary[]; activeJobId: string | null }>('/api/jobs'),

  getJob: (jobId: string) =>
    request<{
      job: JobManifest;
      stats: JobStats;
      progress: LiveProgress | null;
      isActive: boolean;
      activeJobId: string | null;
    }>(`/api/jobs/${jobId}`),

  createJob: (payload: { name: string; rows: ScrapeInput[]; options?: Partial<JobOptions> }) =>
    request<{ job: JobManifest; stats: JobStats }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteJob: (jobId: string) => request<{ deleted: boolean }>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  control: (jobId: string, action: 'start' | 'resume' | 'pause' | 'stop') =>
    request<{ ok: true; pending?: number; stats: JobStats }>(`/api/jobs/${jobId}/control`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  rows: (jobId: string, params: URLSearchParams) =>
    request<{ rows: JobRow[]; total: number; matched: number; offset: number; limit: number }>(
      `/api/jobs/${jobId}/rows?${params.toString()}`,
    ),

  logs: (jobId: string, params?: URLSearchParams) =>
    request<{ entries: LogEntry[]; total: number }>(
      `/api/jobs/${jobId}/logs${params ? `?${params.toString()}` : ''}`,
    ),

  analytics: (jobId: string) => request<AnalyticsPayload>(`/api/jobs/${jobId}/analytics`),

  validateUpload: (file: File, thresholdFile: File, targetSeller: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('thresholdFile', thresholdFile);
    form.append('targetSeller', targetSeller);
    return request<{ filename: string; report: ValidationReport }>('/api/upload', {
      method: 'POST',
      body: form,
    });
  },

  retryRows: (jobId: string, indexes: number[]) =>
    request<{ requeued: number }>(`/api/jobs/${jobId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ indexes }),
    }),
};

export interface AnalyticsPayload {
  outcome: { name: string; value: number }[];
  failureReasons: { reason: string; count: number }[];
  sellers: { seller: string; total: number; succeeded: number; failed: number }[];
  perHour: { hour: string; completed: number; succeeded: number; failed: number }[];
  durations: { bucket: string; count: number }[];
  averageMs: number | null;
  medianMs: number | null;
}
