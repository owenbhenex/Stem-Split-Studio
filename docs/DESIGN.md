# Stem Splitter Studio — Design System v1.0

> Base: **Linear** design language (dark-native, precision engineering aesthetic),
> adapted for an audio production tool. All measurements below are canonical.

## 1. Atmosphere

Near-black canvas where content emerges through calibrated luminance steps, not
color. The studio metaphor: a mixing console in a dark room — tracks glow, the
room stays dark. One chromatic accent (indigo-violet) reserved for interactive
elements. Stem colors are the exception: each stem owns one hue, used only in
its waveform, dot, and active states.

## 2. Color Tokens

### Surfaces (elevation = luminance steps, never shadows)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#08090a` | App canvas |
| `--panel` | `#0f1011` | Sidebar, header, main panels |
| `--surface` | `#191a1b` | Elevated: cards, dropdowns, track rows |
| `--surface-2` | `#28282c` | Hover states, active list items |
| `--btn-bg` | `rgba(255,255,255,0.02)` | Ghost button background |
| `--btn-bg-hover` | `rgba(255,255,255,0.05)` | — |

### Text
| Token | Value | Use |
|---|---|---|
| `--text` | `#f7f8f8` | Primary (never pure white) |
| `--text-2` | `#d0d6e0` | Body, descriptions |
| `--text-3` | `#8a8f98` | Muted, metadata |
| `--text-4` | `#62666d` | Timestamps, disabled |

### Brand & Status
| Token | Value | Use |
|---|---|---|
| `--accent` | `#5e6ad2` | Primary CTA backgrounds |
| `--accent-2` | `#7170ff` | Interactive accents, active states, links |
| `--accent-hover` | `#828fff` | Accent hover |
| `--success` | `#10b981` | Completed status |
| `--processing` | `#f2c94c` | Processing status |
| `--error` | `#eb5757` | Failed status |
| `--overlay` | `rgba(0,0,0,0.85)` | Modal backdrop |

### Stem Colors (the studio palette — 11 stems)
| Stem | Value | Hue family |
|---|---|---|
| vocals | `#f43f5e` | rose |
| drums | `#f59e0b` | amber |
| bass | `#0ea5e9` | sky |
| guitar | `#22c55e` | green |
| piano | `#a855f7` | purple |
| synth | `#06b6d4` | cyan |
| strings | `#ec4899` | pink |
| brass | `#eab308` | yellow |
| organ | `#8b5cf6` | violet |
| keys | `#14b8a6` | teal |
| other | `#94a3b8` | slate (neutral — residual) |

### Borders
| Token | Value |
|---|---|
| `--border` | `rgba(255,255,255,0.08)` standard |
| `--border-subtle` | `rgba(255,255,255,0.05)` default |
| `--border-solid` | `#23252a` solid when needed |

## 3. Typography

**Inter** (Google Fonts; the original uses Inter Variable with `cv01`,`ss03` —
approximated via feature-settings). Mono: **JetBrains Mono**.

```css
font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
font-feature-settings: "cv01", "ss03";
```

| Role | Size | Weight | Line | Tracking |
|---|---|---|---|---|
| Display | 48px | 510 | 1.0 | −1.056px |
| H1 | 32px | 510 | 1.13 | −0.704px |
| H2 / panel title | 24px | 510 | 1.33 | −0.288px |
| H3 / track name | 16px | 590 | 1.33 | −0.24px |
| Body | 15px | 400 | 1.6 | −0.165px |
| Body emphasis | 15px | 510 | 1.6 | −0.165px |
| Caption | 13px | 510 | 1.5 | −0.13px |
| Label / button | 13px | 510 | 1.4 | normal |
| Micro | 11px | 510 | 1.4 | normal |
| Mono time | 13px | 500 | 1.5 | normal |

Weights: 400 (read), **510 (workhorse — buttons, labels, nav)**, 590 (announce).
**Never 700.**

## 4. Spacing & Radius

Base unit **8px**. Scale: 4, 8, 12, 16, 24, 32, 48, 80.

| Radius | Value | Use |
|---|---|---|
| micro | 2px | badges, toolbar buttons |
| standard | 4px | list items |
| comfortable | 6px | buttons, inputs |
| card | 8px | cards, dropdowns |
| panel | 12px | panels, featured containers |
| pill | 9999px | chips, status tags |
| circle | 50% | icon buttons, status dots |

## 5. Elevation Model

| Level | Treatment | Use |
|---|---|---|
| 0 | none, `--bg` | canvas |
| 1 | `rgba(0,0,0,0.03) 0 1.2px 0` | toolbar buttons |
| 2 | `--surface` bg + `--border` | cards, inputs |
| 2b | `rgba(0,0,0,0.2) 0 0 12px inset` | recessed panels (waveform wells) |
| 4 | `rgba(0,0,0,0.4) 0 2px 4px` | floating elements |
| 5 | multi-layer stack | modals, command palette |

Depth on dark = luminance steps + whisper borders, **never drop shadows** (except
floating level 4/5).

## 6. Components

### Button
- Primary: `--accent` bg, white text, 6px radius, `6px 14px`, weight 510, 13px.
  Hover: `--accent-hover`.
- Ghost: `--btn-bg` bg, `1px solid --border`, `#e2e4e7` text. Hover: bg → 0.05.
- Icon: 28–32px circle, `--btn-bg`, `--border` border.

### Status Pill
- Transparent bg, pill radius, `1px solid --border-solid`, 12px/510.
- Dot variant: 6px circle in status color + label.

### Track Row (signature component)
- Height ~52px, `--panel` bg, `--border-subtle` bottom divider.
- Layout: `[color dot + name (120px)] [waveform canvas (flex)] [vol slider] [M] [S]`
- Hover: bg → `rgba(255,255,255,0.02)`.
- Waveform well: `--bg` bg, 4px radius, inset shadow (level 2b).

### Quality Cards
- `--surface` bg, `--border` border, 12px radius, `16px` padding.
- Selected: border → `--accent-2`, bg → `rgba(94,106,210,0.12)`.
- Title 15px/590, meta 12px/400 `--text-3`.

### Waveform (canvas)
- Played portion: stem color at 100%. Unplayed: stem color at 20% opacity (`33` hex suffix).
- Min bar height 1px; bucket peaks min/max averaged.

### Transport Bar
- `--panel` bg, top `--border-subtle` divider, sticky.
- Play button: 40px circle, `--accent` gradient, white glyph.

## 7. Motion

- Transitions: 150ms ease for interactive states.
- View swaps: 250ms fade + 6px translateY.
- Waveform playhead: no CSS transition — rAF-driven, must feel instant.
- No decorative animation. Motion communicates state, nothing else.

## 8. Do's & Don'ts

**Do**
- `font-feature-settings: "cv01", "ss03"` on everything
- Weight 510 as default emphasis; 590 to announce
- Negative tracking on display sizes
- Elevation via luminance steps
- Reserve indigo for interactive elements

**Don't**
- Pure white text or backgrounds
- Solid button backgrounds (except primary CTA)
- Drop shadows for elevation on dark surfaces
- Weight 700
- Positive letter-spacing at display sizes
- Warm colors in UI chrome (stems excepted)

## 9. Responsive

| Breakpoint | Layout |
|---|---|
| <768px | single column, track rows collapse (name above waveform) |
| 768–1024px | sidebar → icon rail |
| ≥1024px | full layout: sidebar + main |

Section padding: 80px → 48px on mobile.
