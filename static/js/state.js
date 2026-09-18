/**
 * State Management & Session Store — Stem Splitter Studio
 * Manages active application view, job metadata, recent splits history, and URL synchronization.
 */

export class StudioStore {
  constructor() {
    this.state = {
      view: 'upload', // 'upload' | 'processing' | 'studio' | 'error'
      quality: 'fast', // 'fast' | 'precision' | 'extended'
      currentJobId: null,
      jobDetails: null,
      errorMsg: null,
      recentJobs: this.loadRecentJobs(),
    };

    this.listeners = new Set();
  }

  /**
   * Subscribe to state mutations
   * @param {Function} callback
   * @returns {() => void} Unsubscribe function
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Update state and notify subscribers
   * @param {Partial<StudioStore['state']>} partial
   */
  setState(partial) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  /**
   * Set active view mode
   * @param {'upload' | 'processing' | 'studio' | 'error'} view
   */
  setView(view) {
    this.setState({ view });
  }

  /**
   * Record a completed job in localStorage history
   * @param {string} id
   * @param {string} title
   * @param {string} quality
   * @param {number} stemCount
   */
  recordJobHistory(id, title, quality, stemCount) {
    const list = this.loadRecentJobs().filter((j) => j.id !== id);
    list.unshift({
      id,
      title: title || 'Untitled Track',
      quality,
      stemCount,
      timestamp: Date.now(),
    });
    const trimmed = list.slice(0, 10);
    try {
      localStorage.setItem('stem_splitter_recent', JSON.stringify(trimmed));
    } catch {}
    this.setState({ recentJobs: trimmed });
  }

  /**
   * Load history from localStorage
   * @returns {Array<{ id: string, title: string, quality: string, stemCount: number, timestamp: number }>}
   */
  loadRecentJobs() {
    try {
      const raw = localStorage.getItem('stem_splitter_recent');
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  }

  /**
   * Sync active job ID with URL search param
   * @param {string|null} jobId
   */
  syncUrl(jobId) {
    const url = new URL(window.location.href);
    if (jobId) {
      url.searchParams.set('job', jobId);
    } else {
      url.searchParams.delete('job');
    }
    window.history.replaceState({}, '', url.toString());
  }
}
