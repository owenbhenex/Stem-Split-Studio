# 🎨 Design System: Cyber-Analog Studio Console

**Design Theme**: Cyber-Analog Audio Workstation  
**Design Principles**:
1. **Studio Precision**: High-contrast, dark-mode first, evoking professional analog mixing desks and cutting-edge digital audio workstations.
2. **Tactile Hierarchy**: Clear separation between master transport, channel strips, metering, and configuration controls.
3. **Chromatic Stem Identity**: Distinct, vibrant, luminous color assignments for all 11 stems that carry consistently through waveforms, channel badges, and meters.
4. **Fluid Responsiveness**: Micro-animations, smooth hover states, reactive glowing toggles, and zero visual stutter.

---

## 1. Color Palette Tokens

### 1.1 Neutral & Console Surfaces
```css
:root {
  /* Surface Backdrops */
  --surface-void: #07090e;        /* Deepest background */
  --surface-base: #0c0f17;        /* Primary console body */
  --surface-panel: #131824;       /* Modular card/strip container */
  --surface-raised: #1a2233;      /* Elevated buttons, fader troughs */
  --surface-hover: #222c42;       /* Interactive hover state */
  --surface-active: #2a3753;      /* Pressed / active element */

  /* Borders & Dividers */
  --border-subtle: #1f2738;
  --border-medium: #2e3b54;
  --border-strong: #45567a;
  --border-focus: #6366f1;

  /* Typography Colors */
  --text-bright: #f8fafc;        /* High-emphasis headers and values */
  --text-primary: #e2e8f0;       /* Standard copy */
  --text-secondary: #94a3b8;     /* Labels, units, metadata */
  --text-muted: #64748b;         /* Disabled, hints, shortcuts */
}
```

### 1.2 Brand & Status Colors
```css
:root {
  --brand-primary: #6366f1;       /* Indigo beam */
  --brand-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #ec4899 100%);
  --brand-glow: rgba(99, 102, 241, 0.35);

  --status-success: #10b981;      /* Emerald */
  --status-warning: #f59e0b;      /* Amber */
  --status-danger: #ef4444;       /* Crimson */
  --status-info: #0ea5e9;         /* Sky */
}
```

### 1.3 Chromatic Stem Signatures
Each stem possesses a dedicated, high-luminance hex identity with paired alpha glow and subtle fill backgrounds:

| Stem Key | Instrument | Hex Color | Glow RGB / CSS Var | Purpose & Character |
| :--- | :--- | :--- | :--- | :--- |
| `vocals` | **Vocals** | `#f43f5e` | `rgba(244, 63, 94, 0.35)` | Neon Rose / Red: Centerpiece, lead vocal prominence |
| `bass` | **Bass** | `#06b6d4` | `rgba(6, 182, 212, 0.35)` | Electric Cyan: Sub-bass clarity, low-end punch |
| `drums` | **Drums** | `#f59e0b` | `rgba(245, 158, 11, 0.35)` | Amber Gold: Transients, rhythmic percussive energy |
| `guitar` | **Guitar** | `#10b981` | `rgba(16, 185, 129, 0.35)` | Emerald Mint: Electric/acoustic string resonance |
| `piano` | **Piano** | `#a855f7` | `rgba(168, 85, 247, 0.35)` | Royal Amethyst: Harmonic fullness, acoustic keys |
| `synth` | **Synth** | `#00f5d4` | `rgba(0, 245, 212, 0.35)` | Vivid Aquamarine: Electronic leads, modern textures |
| `strings` | **Strings** | `#ec4899` | `rgba(236, 72, 153, 0.35)` | Magenta Bloom: Orchestral sweeping textures |
| `brass` | **Brass** | `#eab308` | `rgba(234, 179, 8, 0.35)` | Brass Yellow: Horns, fanfares, punchy stabs |
| `organ` | **Organ** | `#7c3aed` | `rgba(124, 58, 237, 0.35)` | Cathedral Violet: Deep warm organ reeds |
| `keys` | **Keys** | `#14b8a6` | `rgba(20, 184, 166, 0.35)` | Seafoam Teal: Rhodes, Wurlitzer, electric pianos |
| `other` | **Other** | `#94a3b8` | `rgba(148, 163, 184, 0.35)` | Cool Silver: Residual backing and sound FX |

---

## 2. Typography Hierarchy

- **UI & Controls Font**: `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`
- **Monospace Readout Font**: `'JetBrains Mono', 'Fira Code', ui-monospace, monospace`

| Style Name | Font Family | Size | Weight | Line Height | Tracking | Usage |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Display Title** | Inter | 24px (1.5rem) | 800 (Extrabold) | 1.2 | -0.03em | Studio header, main hero |
| **Section Title** | Inter | 16px (1.0rem) | 700 (Bold) | 1.3 | -0.02em | Master bus header, track strip title |
| **Track Name** | Inter | 13px (0.8125rem) | 600 (Semibold) | 1.2 | -0.01em | Stem track titles |
| **Control Label** | Inter | 11px (0.6875rem) | 700 (Bold) | 1.1 | +0.06em (Uppercase) | MUTE, SOLO, PAN, VOL, PRESET |
| **Timecode Main** | JetBrains Mono | 20px (1.25rem) | 700 (Bold) | 1.0 | +0.02em | Transport counter (`02:45.120`) |
| **Timecode Sub** | JetBrains Mono | 12px (0.75rem) | 500 (Medium) | 1.0 | 0 | Total duration, loop points |
| **Meter dB** | JetBrains Mono | 10px (0.625rem) | 600 (Semibold) | 1.0 | 0 | Peak meter decibels (`-3.2 dB`) |

---

## 3. UI Component Anatomy & Tokens

### 3.1 Channel Strip Component
Each stem track is rendered inside a modular, horizontal channel strip:
- **Header Section (Left, 140px)**:
  - Stem color pill & instrument icon.
  - Stem label & download icon button.
  - Mini RMS/Peak LED VU meter.
- **Waveform Canvas (Center, Flexible Flex-1, Height: 52px)**:
  - High-resolution HTML5 Canvas rendering dual-sided mirrored amplitude envelope.
  - Dynamic opacity gradient (active played section glowing in stem color, unplayed section in 30% dimmed tone).
  - Synchronized vertical playhead needle with smooth animated movement.
  - Hover time cursor showing exact timestamp on mouseover.
- **Mixer Section (Right, 240px)**:
  - **Pan Pot**: Dual-direction slider (-100% Left, Center 0, +100% Right) with numeric feedback tooltip.
  - **Solo Button (S)**: Toggles glowing Yellow (`#eab308`), activates solo routing.
  - **Mute Button (M)**: Toggles glowing Crimson (`#ef4444`), mutes channel output.
  - **Volume Fader**: Sleek horizontal fader with numeric readout (`0 dB`, `-6 dB`, `-inf`).
  - **Quick Download Button (WAV)**: Downloads isolated stem directly.

### 3.2 Master Transport Bar
Positioned at bottom or top with high accessibility:
- **Play / Pause Button**: 48px circle with gradient glow and clear play/pause icon states.
- **Return to Zero (⏮)**: Clears playhead to `00:00.00`.
- **Loop Selector (🔁)**: Enables A-B loop mode with visual marker highlights.
- **Global Timecode Counter**: Digital 7-segment-inspired monospace readout.
- **Master Volume & Master Limiter LED**: Prevents ear fatigue and digital clipping.
- **Global Action Hub**: "Download Stems (.ZIP)", "Mute All", "Clear Solos", "New Split".

### 3.3 Separation Pipeline Tracker Card
During upload and processing:
- **Step Visualizer**: Horizontal 3-stage progress pills (Pass 1 Vocal Ensemble ➔ Pass 2 Instrumental Split ➔ Pass 3 Extended Peeling).
- **Active Stage Pulse**: Glowing LED pulsing indicator next to current execution stage.
- **Live Percentage & Elapsed Timer**: High-precision progress bar with smooth CSS transitions.

---

## 4. Micro-Interactions & Animation Specs

- **Button Press**: `transform: scale(0.96); transition: transform 0.1s cubic-bezier(0.4, 0, 0.2, 1);`
- **Solo/Mute Toggle**: Instant color shift with box-shadow glow transition `box-shadow 0.15s ease`.
- **Waveform Hover**: Instant vertical cursor bar tracking mouse X with semi-transparent time bubble.
- **Progress Pulse**: CSS `@keyframes pulseGlow` with easing cycle between 0.35 and 0.8 opacity.
- **Transitions**: Standard easing curves: `cubic-bezier(0.16, 1, 0.3, 1)` for panels and modals.
