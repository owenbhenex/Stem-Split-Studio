/**
 * Waveform Renderer — Stem Splitter Studio
 * Precomputes min/max audio peaks and draws high-DPI retina waveforms
 * with dual-color played/unplayed progress shaders.
 */

export class WaveformRenderer {
  /**
   * Precompute min/max amplitude peaks from AudioBuffer
   * @param {AudioBuffer} audioBuffer
   * @param {number} numBuckets
   * @returns {Float32Array} [min0, max0, min1, max1, ...]
   */
  static computePeaks(audioBuffer, numBuckets = 1600) {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
    const length = ch0.length;
    const bucketSize = Math.max(1, Math.floor(length / numBuckets));
    const peaks = new Float32Array(numBuckets * 2);

    for (let i = 0; i < numBuckets; i++) {
      let min = 1.0;
      let max = -1.0;
      const start = i * bucketSize;
      const end = Math.min(start + bucketSize, length);

      for (let j = start; j < end; j += 4) { // Subsampled for fast parsing
        const val = (ch0[j] + ch1[j]) * 0.5;
        if (val < min) min = val;
        if (val > max) max = val;
      }

      peaks[i * 2] = min === 1.0 ? 0 : min;
      peaks[i * 2 + 1] = max === -1.0 ? 0 : max;
    }

    return peaks;
  }

  /**
   * Parse hex or color string to rgba
   * @param {string} color
   * @param {number} alpha
   * @returns {string}
   */
  static hexToRgba(color, alpha = 1.0) {
    if (!color) return `rgba(148, 163, 184, ${alpha})`;
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
    return color;
  }

  /**
   * Draw animated/shimmer placeholder while audio is loading
   * @param {HTMLCanvasElement} canvas
   * @param {string} color
   */
  static drawLoadingSkeleton(canvas, color = '#6366f1') {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 300;
    const height = canvas.clientHeight || canvas.parentElement?.clientHeight || 48;
    if (width === 0 || height === 0) return;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Subtle guide line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Pulse bars
    const barWidth = 2;
    const step = 4;
    const midY = height / 2;
    ctx.fillStyle = WaveformRenderer.hexToRgba(color, 0.15);

    for (let x = 0; x < width; x += step) {
      const pseudoAmp = Math.sin(x * 0.04) * 0.25 + 0.35;
      const barH = Math.max(4, pseudoAmp * (height * 0.6));
      ctx.fillRect(x, midY - barH / 2, barWidth, barH);
    }
    ctx.restore();
  }

  /**
   * Draw waveform onto canvas
   * @param {HTMLCanvasElement} canvas
   * @param {Float32Array} peaks
   * @param {string} color - Hex color
   * @param {number} progress - 0.0 to 1.0
   */
  static drawWaveform(canvas, peaks, color, progress = 0) {
    if (!canvas || !peaks) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
    const height = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;

    if (width === 0 || height === 0) return;

    // Adjust canvas dimensions for retina
    const targetWidth = Math.floor(width * dpr);
    const targetHeight = Math.floor(height * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const numBuckets = peaks.length / 2;
    const midY = height / 2;
    const progressX = Math.max(0, Math.min(width, progress * width));

    // Center guideline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // DAW-grade bar styling: crisp vertical bars
    const barWidth = 1.6;
    const step = 2.6; // High resolution with 1px micro-gap
    const activeColor = WaveformRenderer.hexToRgba(color, 0.95);
    const inactiveColor = WaveformRenderer.hexToRgba(color, 0.24);

    for (let x = 0; x < width; x += step) {
      const bucketIdx = Math.min(numBuckets - 1, Math.floor((x / width) * numBuckets));
      const min = peaks[bucketIdx * 2];
      const max = peaks[bucketIdx * 2 + 1];
      const amp = Math.max(0.04, (Math.abs(min) + Math.abs(max)) * 0.5);
      const barHeight = Math.min(height * 0.94, amp * height * 0.94);

      ctx.fillStyle = x < progressX ? activeColor : inactiveColor;
      ctx.fillRect(x, midY - barHeight / 2, barWidth, barHeight);
    }

    // Active playhead needle with subtle glow
    if (progressX > 0 && progressX <= width) {
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 4;
      ctx.fillRect(progressX - 0.75, 0, 1.5, height);
    }

    ctx.restore();
  }
}
