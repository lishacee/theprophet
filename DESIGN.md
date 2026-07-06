---
name: The Prophet
description: A playful, competitive football prediction pool played in virtual points — a floodlit night pitch on the phone.
colors:
  accent-lime: "#9fe85f"
  accent-ink: "#0a160e"
  accent-violet: "#7c3aed"
  bg-pitch: "#0c1611"
  surface: "#14241b"
  surface-raised: "#1b2d23"
  input-well: "#0c1812"
  ink: "#e9f7ee"
  muted: "#8ba89a"
  muted-quiet: "#5f7669"
  cyan-line: "#52c7e6"
  win: "#84e07a"
  lose: "#ff6b78"
  gold: "#f2c43d"
  candy-bg: "#ddd0ec"
  candy-surface: "#ffffff"
  candy-ink: "#281d3d"
typography:
  display:
    fontFamily: "Outfit, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "0.3px"
  title:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.5px"
  body:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "1px"
rounded:
  sm: "10px"
  input: "12px"
  md: "13px"
  card: "20px"
  pill: "999px"
spacing:
  xs: "5px"
  sm: "8px"
  md: "13px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent-lime}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "13px 18px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "13px 18px"
  button-sm:
    backgroundColor: "{colors.accent-lime}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 13px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  chip-lime:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.accent-lime}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  input:
    backgroundColor: "{colors.input-well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.input}"
    padding: "12px 13px"
---

# Design System: The Prophet

## 1. Overview

**Creative North Star: "The Floodlit Pitch"**

The Prophet is a night match under stadium floodlights, held in the hand. The default theme (**Neon Pitch**) is a near-black pitch-green field lit by a single electric-lime glow; the alternate theme (**Candy Pop**) is the same match played in daylight, lavender and violet. It is a *game*, not a bookmaker — the energy is a group of friends leaning over a phone arguing about a scoreline, not a casino floor pushing the next bet.

The layout is deliberately narrow (max 540px) and thumb-first: this lives on a phone around kickoff. Density is high but breathing — rounded 20px cards float on a dark field with soft shadow and a faint accent glow, never flat gray panels. Color is functional, not decorative: lime means *action / your points*, green means *win*, coral means *loss*, gold means *streak / reward*. The interface should feel alive and a little competitive — badges, streaks, and a public leaderboard are the point.

It explicitly rejects four things (from PRODUCT.md): the blinking, nagging, dark-pattern surface of **real-money sportsbooks**; the **gray, uniform card-grid of template SaaS admins**; the **eyebrow-and-gradient-text grammar of AI landing pages**; and the **navy-and-gold stiffness of serious fintech**. Points are play. Keep it warm and characterful.

**Key Characteristics:**
- Mobile-first single column, ≤540px, generous bottom padding for a sticky nav.
- Dark "Neon Pitch" default; light "Candy Pop" alternate — both first-class, both must pass contrast.
- One electric accent (lime / violet) carrying action, plus a fixed win/lose/gold semantic set.
- Soft glow and shadow for depth; rounded, tactile cards; no flat gray.
- Vietnamese UI copy, casual and a little cheeky.

## 2. Colors

A dark pitch-green field lit by one electric accent, with a strict semantic set for outcomes. The alternate light theme swaps the field to lavender and the accent to violet, keeping every role identical.

### Primary
- **Electric Lime** (`#9fe85f`, dark theme): the single action color — primary buttons, your points balance, selected odds, focus rings, chips. In Candy Pop it becomes **Vivid Violet** (`#7c3aed`). One accent carries action; do not add a second competing hue.
- **Accent Ink** (`#0a160e` dark / `#ffffff` light): text that sits *on* the accent (button labels). Never put muted gray on the accent.

### Secondary
- **Signal Cyan** (`#52c7e6` dark / `#0e95b0` light): a secondary line/marker color for odds movement and subtle emphasis. Used sparingly, never competing with the lime for "action".

### Tertiary (semantic outcomes — fixed, never repurposed)
- **Win Green** (`#84e07a` dark / `#16a34a` light): winning bets, positive net, up-ticks.
- **Loss Coral** (`#ff6b78` dark / `#e23b5a` light): losing bets, negative net, destructive actions.
- **Streak Gold** (`#f2c43d` dark / `#e8920c` light): badges, streaks, rewards.

### Neutral
- **Pitch Black-Green** (`#0c1611`): the page field (dark theme), carried by a faint radial lime glow at the top. Candy Pop field is **Lavender** (`#ddd0ec`).
- **Surface** (`#14241b`) / **Surface Raised** (`#1b2d23`): card and nested-chip backgrounds. Candy Pop uses white (`#ffffff`) / `#f4eefc`.
- **Ink** (`#e9f7ee` dark / `#281d3d` light): body and heading text.
- **Muted** (`#8ba89a`) / **Muted Quiet** (`#5f7669`): secondary labels and hints. The quiet step is for non-essential meta only.
- **Input Well** (`#0c1812` dark / `#f5f0fc` light): field backgrounds, slightly darker/cooler than the surface.

### Named Rules
**The One Accent Rule.** Exactly one action color per theme (lime, or violet in Candy Pop). If something needs to stand out and isn't an action, use weight, size, or a semantic outcome color — never a second bright hue.

**The Semantic Lock.** Green/coral/gold mean win/loss/reward *only*. Never use win-green as a decorative accent or loss-coral for anything but a real loss or a destructive control.

**The Contrast Floor Rule.** Muted text must clear 4.5:1 on its own surface. `muted-quiet` (`#5f7669`) and Candy Pop's muted (`#7d7596`) are borderline on their fields — use them only for large or non-essential text, and bump toward ink when in doubt.

## 3. Typography

**Display / Body / Label Font:** Outfit (with `system-ui, -apple-system, Segoe UI, Roboto, sans-serif`).

**Character:** A single geometric sans across the whole system, differentiated by weight, not by family. Outfit's heavy weights (800–900) are confident and sporty for headings and numbers; 400 keeps body readable at 15px. No second font — contrast comes from the weight jump (400 body → 900 heading), which suits a compact scoreboard UI.

### Hierarchy
- **Display** (900, 22px, line-height ~1.1, letter-spacing 0.3px): screen titles and the points balance. This app has no oversized hero — 22px is the ceiling; it's a dense tool, not a landing page.
- **Title** (900, 19px, letter-spacing 0.5px): the brand mark and section heads.
- **Body** (400, 15px, line-height ~1.5): all reading text. Lines stay short by the 540px column.
- **Label** (600–800, 10.5–12px, letter-spacing ~1px, often uppercase): *data* labels — points-pill captions, pool selector keys, stat tiles. These are functional micro-labels, not decorative section eyebrows.

### Named Rules
**The One Family Rule.** Outfit only. Hierarchy is weight (400 → 800 → 900) and size, never a second typeface.

**The Functional Caps Rule.** Uppercase tracked text is allowed only as a genuine data label (a stat caption, a pill key). It is forbidden as a decorative eyebrow above section headings.

## 4. Elevation

A lifted, glowing system — not flat. Depth comes from soft ambient shadow plus a faint accent glow, which is core to the "floodlit" feel. Surfaces layer tonally (field → surface → surface-raised) and lift with shadow.

### Shadow Vocabulary
- **Card ambient** (`box-shadow: 0 10px 26px rgba(0,0,0,.32)` dark / `0 10px 26px rgba(110,70,170,.14)` light): the resting shadow on every card. Tinted toward the theme, not pure black in light mode.
- **Accent glow** (`box-shadow: 0 6px 16px rgba(159,232,95,.18)`): under primary buttons and active elements — the "lit" signal. Rare, tied to action.
- **Focus ring** (`box-shadow: 0 0 0 3px rgba(159,232,95,.18)` + lime border): input and control focus.
- **Toast / nav lift** (`0 8px 24px rgba(0,0,0,.22)` / `0 14px 40px`): the sticky topbar and floating toast.

### Named Rules
**The Lit-Not-Flat Rule.** Cards rest with soft ambient shadow; action elements add an accent glow. A dead-flat card with no shadow reads as a broken/template surface here.

**The Glow Belongs To Action Rule.** The lime glow is reserved for interactive/active elements (primary button, selected odds, focus). Don't scatter glow on static decoration.

## 5. Components

### Buttons
- **Shape:** rounded 13px (`{rounded.md}`); the small variant is 10px (`{rounded.sm}`).
- **Primary:** lime fill, accent-ink label, weight 800, `padding: 13px 18px`, accent-glow shadow. Presses down (`translateY(1px) scale(.99)`) on `:active`.
- **Ghost:** transparent, ink label, 1px `line2` border, no shadow, weight 700 — secondary actions.
- **Small:** the primary style at 8px 13px / 13px radius — inline admin actions ("Reload odds", "Reload giờ trận").
- **Disabled:** opacity 0.4, `not-allowed`.

### Chips
- **Style:** pill (`999px`), `padding: 5px 11px`, weight 700, 12.5px. `chip.lime` = raised-surface bg + lime text + accent border; `chip.gold` = gold tint; `chip.glass` = muted text + hairline border (neutral status).
- **State:** used for status ("chờ KQ", "đã xong"), badges, and counts — not as buttons.

### Cards / Containers
- **Corner:** rounded 20px (`{rounded.card}`) — soft and tactile.
- **Background:** `surface` (`#14241b`), or the `headcard` gradient for the wallet/summary header.
- **Shadow:** the Card ambient shadow (see Elevation); never flat.
- **Border:** 1px hairline `line` (`rgba(255,255,255,.07)`).
- **Padding:** 16px (`{spacing.lg}`); 13px bottom margin between stacked cards. **Never nest a card inside a card** — use `surface-raised` panels instead.

### Inputs / Fields
- **Style:** `input-well` bg, 1px `line2` border, rounded 12px, 15px text, full width.
- **Focus:** lime border + 3px accent glow ring.
- **Checkbox:** `accent-color: lime`.

### Navigation
- **Topbar:** sticky, `z-index: 50`, gradient header (`topbar-bg`), rounded bottom corners (`0 0 22px 22px`), soft lift shadow. Holds the brand mark, points pill, pool selector, and icon buttons. Chips on the topbar invert to read on the colored header.
- **Account menu rows:** full-width 52px rows, raised-surface bg, 14px radius, icon + label + chevron; danger rows use loss-coral.

### Signature — Settlement Queue (admin)
The admin match-settling panel (`sq-*`): a match row that expands to a **multi-select checklist** of outcomes. Each option is a full-width row with a tick box (`sq-box`) that fills lime when a winning outcome is selected; points apply optimistically and are editable until locked. This is the product's most distinctive custom surface — full-width checkable rows, not a card grid, with a "🔒 Chốt" (lock) affordance to finalize.

## 6. Do's and Don'ts

### Do:
- **Do** keep one action color per theme (lime dark / violet light); express other emphasis with weight, size, or a semantic color.
- **Do** reserve green/coral/gold for win/loss/reward only.
- **Do** give cards the ambient shadow and action elements the accent glow — lit, never flat.
- **Do** keep body text at `ink` and verify muted text clears 4.5:1; push `muted-quiet` toward ink for anything readable.
- **Do** design mobile-first inside the 540px column, thumb-reachable, with the primary matchday action (place a bet, check the board) one tap away.
- **Do** use uppercase tracked type only as functional data labels.

### Don't:
- **Don't** adopt real-money sportsbook patterns — no blinking, no nagging "bet now" nudges, no sleaze. Points are play.
- **Don't** ship the gray, uniform card-grid of template SaaS admins, or repeat identical icon+heading+text cards.
- **Don't** use AI-landing grammar: no tiny uppercase eyebrow above every section, no `background-clip:text` gradient text, no hero-metric template.
- **Don't** drift toward navy-and-gold fintech stiffness — keep the playful, competitive warmth.
- **Don't** nest a card inside a card; use a `surface-raised` panel instead.
- **Don't** use `border-left`/`border-right` > 1px as a colored accent stripe; use a full hairline border or a background tint.
- **Don't** put muted gray text on the lime/violet accent — use `accent-ink`.
