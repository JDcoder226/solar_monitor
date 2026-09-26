---
name: Solar Telemetry Interface
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#534434'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#867461'
  outline-variant: '#d8c3ad'
  surface-tint: '#855300'
  primary: '#855300'
  on-primary: '#ffffff'
  primary-container: '#f59e0b'
  on-primary-container: '#613b00'
  inverse-primary: '#ffb95f'
  secondary: '#a73a00'
  on-secondary: '#ffffff'
  secondary-container: '#fd651e'
  on-secondary-container: '#571a00'
  tertiary: '#006c49'
  on-tertiary: '#ffffff'
  tertiary-container: '#30c88f'
  on-tertiary-container: '#004e34'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffddb8'
  primary-fixed-dim: '#ffb95f'
  on-primary-fixed: '#2a1700'
  on-primary-fixed-variant: '#653e00'
  secondary-fixed: '#ffdbce'
  secondary-fixed-dim: '#ffb599'
  on-secondary-fixed: '#370e00'
  on-secondary-fixed-variant: '#7f2b00'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  display:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  title-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: 0em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  metric-value-lg:
    fontFamily: JetBrains Mono
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.03em
  metric-value-md:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.02em
  metric-unit:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-sm: 0.75rem
  gutter-lg: 1.5rem
  margin: 1.5rem
  margin-mobile: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

This design system establishes a high-density, performance-driven telemetry aesthetic that merges the functional utility of enterprise observability suites (Grafana) with the modern typographic discipline and crisp precision of cloud developer consoles (Vercel). Built for renewable energy operators, field engineers, and asset managers, the interface prioritizes immediate comprehension, operational calmness, and high data density without visual fatigue.

The style is defined as **Industrial Clean-Tech**:
- Grounded, flat surfaces using cold-neutral slate tones rather than generic gray.
- Crisp boundary delineation with subtle 1px structural borders, avoiding heavy dropped shadows.
- High-contrast typography optimized for rapid scanning of tabular metrics and streaming time-series.
- Functional color distribution: vivid solar hues reserved for generation and active load metrics, emerald for operational stability, and precise diagnostic hues for multi-stream analytics.

## Colors

The palette balances clinical precision with industrial solar energy metaphors:

- **Primary (`#F59E0B`) & Secondary (`#EA580C`)**: Solar Amber and Radiant Orange serve as focal indicators for active generation, power output (kW/MW), instantaneous current, and high-priority operational state.
- **Tertiary (`#10B981`)**: Emerald Green strictly communicates system health, normal grid connection states, and optimal photovoltaic conversion efficiency.
- **Neutrals (`#0F172A` text, `#F8FAFC` base background, `#FFFFFF` surface container, `#E2E8F0` borders)**: Crisp, low-reflectance structural tones that construct structural hierarchy without muddying visual clarity.

### Diagnostic & Telemetry Series Colors
For multi-trace metric visualizations and sensor differentiation:
- **Power & Current**: Primary Solar Amber (`#F59E0B`)
- **Grid & Inverter Voltage**: Electric Indigo/Blue (`#3B82F6`)
- **Thermal & Heat Dissipation**: Rose/Crimson (`#F43F5E`)
- **Irradiance & Luminosity**: Sky Cyan (`#0EA5E9`)
- **Auxiliary System / Battery State**: Violet (`#8B5CF6`)

## Typography

Typography relies on a dual-engine architecture:
- **Inter** handles narrative, structural labeling, tooltips, navigation, and tabular headers. Tight negative letter-spacing ensures a modern, clean-tech display profile.
- **JetBrains Mono** governs all numerical stream outputs, electrical unit identifiers, telemetry readouts, timestamps, and status codes. Its fixed-width character bounding guarantees that rapidly shifting numbers do not cause layout jank or jitter during real-time updates.

## Layout & Spacing

The layout is built on a 12-column fluid grid system optimized for modular telemetry panes, metric strips, and data-dense interactive charting modules.

- **Desktop (1200px+)**: 12-column fluid grid, 24px (`space-xl`) outer canvas margins, 16px (`gutter`) inter-card gutters. Top summary rows typically span 3 columns (4 cards per row) or 4 columns (3 cards per row).
- **Tablet (768px - 1199px)**: 6 or 8-column responsive reflow, 16px (`gutter`) gutters, collapsing multi-metric chart blocks to stacked vertical units.
- **Mobile (< 768px)**: 1-column linear flow, 12px outer margin (`margin-mobile`), 12px card gap (`gutter-sm`), with horizontal scrollbars for granular multi-series time legends and data tables.
- **Internal Density**: Component internal padding is strict and compact (`space-md` for standard card bodies; `space-xs` and `space-sm` for inline metric groupings).

## Elevation & Depth

This design system avoids decorative drop shadows and skeuomorphic blurs, relying instead on **low-contrast outlines** and **tonal layering**:

- **Canvas (Level 0)**: Background `#F8FAFC`. Completely flat.
- **Surface Cards (Level 1)**: Pure white `#FFFFFF` surface bounded by a crisp 1px border of `#E2E8F0`. 
- **Sub-Panels & Data Traces (Level 2)**: Nested card compartments, metric slots, and table headers use `#F1F5F9` with matching `#E2E8F0` separation dividers.
- **Hover & Focus States**: Subtle transformation via border color shifting to `#CBD5E1` or `#F59E0B` (primary), accompanied by a micro ambient elevation: `0 1px 3px 0 rgba(15, 23, 42, 0.05)`.
- **Flyouts & Overlays**: Modals, filter sheets, and dropdowns use a sharp `0 4px 12px rgba(15, 23, 42, 0.08)` border-shadow combination with `#FFFFFF` background and `#CBD5E1` border.

## Shapes

The design system enforces a **Soft (`1`)** shape language:
- Standard UI elements (cards, input fields, buttons, chart containers) use `4px` (0.25rem) corner radiuses.
- Larger parent canvas containers and modal dialogs scale to `8px` (0.5rem).
- Metric chips, status pills, and telemetry badges use `2px` or `4px` subtle corners rather than rounded pills, reinforcing the calibrated, dashboard-instrument aesthetic.

## Components

### Buttons
- **Primary Button**: Solid `#F59E0B` fill, `#0F172A` high-contrast text, 4px border radius, 32px height in standard mode. Hover transitions to `#D97706`. Focus uses a 2px offset ring of `#F59E0B`.
- **Secondary Button**: Pure `#FFFFFF` surface, 1px `#E2E8F0` border, `#0F172A` text. Hover changes background to `#F8FAFC` and border to `#CBD5E1`.
- **Tertiary / Destructive**: Flat transparent button with `#DC2626` text on warning, `#64748B` on neutral ghost actions.

### Telemetry Cards & Metric Blocks
- Structured with an upper metadata bar (`title-sm` left, system status badge right), a central metric block (`metric-value-lg` accompanied by `metric-unit` in baseline alignment), and a sparkline or time-comparison indicator at the base.
- Sparkline charts are rendered directly into the bottom card surface with 1px stroke weight and zero vertical margin.

### Status Badges & Chips
- Crisp, low-saturation backgrounds paired with high-contrast text and a 6px pulsing or steady dot:
  - **Nominal / Healthy**: `#ECFDF5` background, `#065F46` text, `#10B981` indicator.
  - **Generating / Active**: `#FEF3C7` background, `#92400E` text, `#F59E0B` indicator.
  - **Inverter Warning / Derated**: `#FFEDD5` background, `#9A3412` text, `#EA580C` indicator.
  - **Critical Fault**: `#FEE2E2` background, `#991B1B` text, `#EF4444` indicator.

### Input Fields & Controls
- Height constrained to 32px or 36px for dashboard efficiency.
- 1px `#E2E8F0` border, `#FFFFFF` background, `#0F172A` text in `body-md`. Focus initiates an immediate 1px `#F59E0B` border without glowing drop-shadows.

### Checkboxes & Radio Buttons
- 16px square (checkbox) or circular (radio) with 1px `#CBD5E1` border. Checked state uses solid `#F59E0B` with white tick/inner pip.

### Data Tables
- Header uses `#F8FAFC` background with all-caps `label-mono-sm` text in `#64748B`.
- Row height fixed at 40px for tabular clarity. Numerical cells right-aligned in `JetBrains Mono`. Alternating row borders use 1px solid `#F1F5F9`.

### Chart Panels & Time-Series Graphs
- Cartesian grid lines use dotted `#E2E8F0`. 
- Tooltips display an active hover crosshair (1px `#94A3B8` dashed) and a floating `#0F172A` dark container with white mono values and colored trace swatches.