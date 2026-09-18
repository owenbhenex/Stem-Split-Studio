/**
 * API Client — Stem Splitter Studio
 * Handles upload with progress, resilient status polling, and stem download helpers.
 */

export class ApiClient {
  /**
   * Upload audio file with progress tracking
   * @param {File} file - The audio file to upload
   * @param {string} quality - "fast" | "precision" | "extended"
   * @param {Function} onProgress - Callback with { loaded, total, percent, speedMBs }
   * @returns {Promise<{ job_id: string }>}
   */
  static uploadAudio(file, quality, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);

      let lastLoaded = 0;
      let lastTime = performance.now();
      let smoothedSpeed = 0;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const now = performance.now();
          const dt = (now - lastTime) / 1000;
          if (dt > 0.25) {
            const bytesPerSec = (event.loaded - lastLoaded) / dt;
            const currentSpeed = bytesPerSec / (1024 * 1024);
            smoothedSpeed = smoothedSpeed === 0 ? currentSpeed : smoothedSpeed * 0.7 + currentSpeed * 0.3;
            lastLoaded = event.loaded;
            lastTime = now;
          }

          const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
          if (onProgress) {
            onProgress({
              loaded: event.loaded,
              total: event.total,
              percent,
              speedMBs: smoothedSpeed.toFixed(1),
            });
          }
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.job_id) {
              resolve(data);
            } else {
              reject(new Error(data.message || 'Missing job_id in server response'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse upload response: ${xhr.responseText}`));
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.message || `Upload failed with HTTP ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed with HTTP ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => {
        reject(new Error('Network error during upload. Please check your connection.'));
      };

      const formData = new FormData();
      formData.append('file', file);
      formData.append('quality', quality);

      xhr.send(formData);
    });
  }

  /**
   * Resiliently poll job status until completed or error
   * @param {string} jobId
   * @param {Function} onUpdate - Callback with status data
   * @param {Function} onError - Callback with error string
   * @returns {() => void} Function to cancel polling
   */
  static pollJobStatus(jobId, onUpdate, onError) {
    let cancelled = false;
    let timer = null;
    let pollInterval = 1800;
    let consecutiveFailures = 0;

    const check = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/status/${encodeURIComponent(jobId)}`);
        if (!res.ok) {
          throw new Error(`HTTP error ${res.status}`);
        }
        const data = await res.json();
        consecutiveFailures = 0;
        pollInterval = 1800; // Reset interval on success

        if (cancelled) return;

        if (onUpdate) onUpdate(data);

        if (data.status === 'completed') {
          return;
        } else if (data.status === 'error') {
          if (onError) onError(data.error || 'Separation failed on server.');
          return;
        } else if (data.status === 'unknown') {
          if (onError) onError('Session not found or expired on server.');
          return;
        } else {
          timer = setTimeout(check, pollInterval);
        }
      } catch (err) {
        consecutiveFailures++;
        // Jittered exponential backoff (up to 8s)
        pollInterval = Math.min(8000, 1800 * Math.pow(1.4, consecutiveFailures));
        if (consecutiveFailures > 10) {
          if (onError) onError('Lost connection to server after multiple retries.');
          return;
        }
        timer = setTimeout(check, pollInterval);
      }
    };

    check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }

  /**
   * Fetch list of completed jobs from server
   * @returns {Promise<Array<{ id: string, name: string, quality: string, stem_count: number, timestamp: number }>>}
   */
  static async getRecentJobs() {
    try {
      const res = await fetch('/api/jobs');
      if (res.ok) {
        const data = await res.json();
        return data.jobs || [];
      }
    } catch {
      // Endpoint may not be available on older server instance
    }
    return [];
  }

  /**
   * Generate download URL for full stem ZIP
   * @param {string} jobId
   * @returns {string}
   */
  static getDownloadZipUrl(jobId) {
    return `/api/download/${encodeURIComponent(jobId)}`;
  }

  /**
   * Generate download URL for an individual stem WAV file
   * @param {string} jobId
   * @param {string} filename
   * @returns {string}
   */
  static getStemDownloadUrl(jobId, filename) {
    return `/api/download/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
  }
}
