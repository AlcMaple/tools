# Design System Specification: Daybreak Core

## 1. Overview & Creative North Star: "The Ethereal Workspace"
This design system is a departure from the heavy, rigid structures of traditional desktop utilities. Its Creative North Star is **"The Ethereal Workspace"**—a digital environment that mimics the atmosphere of a Shinkai-inspired morning: high-clarity, emotionally resonant, and filled with "air."

To move beyond a "template" look, we reject the grid-locked box. Instead, we use **intentional asymmetry** and **tonal layering**. Elements should feel as though they are floating in a luminous space rather than being anchored to a cold, grey technical grid. This is achieved through wide margins, overlapping "frosted" surfaces, and a radical reduction of structural lines.

---

## 2. Colors & Surface Philosophy
The palette is built on high-chroma light neutrals and a signature soft rose accent. It prioritizes legibility while maintaining a "dreamlike" professional polish.

### The "No-Line" Rule
**Explicit Instruction:** Do not use `1px` solid borders for sectioning or layout containment. 
Structural boundaries must be defined solely through background color shifts. For example, a sidebar should be defined by the transition from `surface` (#F8F9FA) to `surface-container-low` (#F3F4F5), never by a grey line.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers—stacked sheets of fine paper or glass. 
*   **Base:** `background` (#F8F9FA)
*   **Main Content Areas:** `surface-container-lowest` (#FFFFFF)
*   **Secondary Utility Panels:** `surface-container` (#EDEEEF)
*   **Global Navigation:** `surface-bright` (#F8F9FA) with 80% opacity and `backdrop-blur: 20px`.

### The "Glass & Gradient" Rule
To add "soul" to the professional utility, use **Glassmorphism** for all floating elements (modals, dropdowns, and toast notifications). 
*   **Token Usage:** Use `surface-container-lowest` at 70% opacity + `backdrop-blur: 16px`.
*   **Signature Gradients:** For primary Call-to-Actions (CTAs) or Hero headers, use a subtle linear gradient: `primary` (#94464F) to `primary-container` (#F09199) at a 135-degree angle. This prevents the "flat-toy" look of single-hex buttons.

---

## 3. Typography: Editorial Utility
We pair the clinical precision of **Inter** with the technical character of **Space Grotesk** to create a "High-End Manual" aesthetic.

*   **Display & Headlines (Inter):** Use `display-lg` and `headline-md` with tight tracking (-0.02em) and `on-surface` (#191C1D). This creates an authoritative, editorial feel.
*   **Body (Inter):** `body-md` is the workhorse. Maintain a generous line-height (1.6) to preserve the "airy" personality.
*   **Labels & Metadata (Space Grotesk):** All technical data, timestamps, and micro-copy must use `label-md`. This differentiates "content" from "system information," giving the UI a sophisticated, specialized feel.

---

## 4. Elevation & Depth: Tonal Layering
Traditional shadows are often too "dirty" for a Shinkai-inspired palette. We use **Tonal Layering** and **Ambient Light**.

*   **The Layering Principle:** Place a `surface-container-lowest` card on a `surface-container-low` section. The contrast in value creates a natural lift without the need for CSS box-shadows.
*   **Ambient Shadows:** If a floating effect is mandatory (e.g., a dragged item), use an extra-diffused shadow: `box-shadow: 0 12px 40px rgba(148, 70, 79, 0.06);`. Note the use of the `primary` color in the shadow to keep the "glow" clean and branded.
*   **The Ghost Border Fallback:** For accessibility in high-density data, use a "Ghost Border": `outline-variant` (#D9C1C1) at **15% opacity**. It should be felt, not seen.

---

## 5. Components & Interaction

### Buttons
*   **Primary:** Gradient fill (`primary` to `primary-container`), white text, `ROUND_FOUR` (0.5rem) corners.
*   **Secondary:** `surface-container-highest` background with `on-surface` text. No border.
*   **Tertiary/Ghost:** `on-surface` text with a background that appears only on `:hover` (using `surface-variant` at 40% opacity).

### Cards & Lists
*   **Prohibition:** Never use divider lines between list items. 
*   **Solution:** Use vertical white space (`spacing-3`) or alternating subtle backgrounds. For high-density lists, use a 4px left-accent bar of `primary_fixed` to indicate selection/focus.

### Input Fields
*   **Soft Focus:** Default state is `surface-container-low`. On focus, transition to `surface-container-lowest` with a `primary` "Ghost Border" (20% opacity). 
*   **Labels:** Use `label-md` (Space Grotesk) in `secondary` color, positioned 4px above the input.

### Glass Modals
Modals should never be 100% opaque. They must allow the "Daybreak" light to pass through. 
*   **Specs:** Background: `surface-container-lowest` (alpha 0.8), Blur: 24px, Border: 1px solid `white` (alpha 0.3).

---

## 6. Do’s and Don’ts

### Do:
*   **Use Asymmetric Padding:** Allow headers to have significantly more top-padding than bottom-padding to create an "upward" energy.
*   **Leverage Negative Space:** If a screen feels cluttered, increase the `spacing` token rather than adding a border.
*   **Contextual Accents:** Use the `tertiary` (#166C45) tokens for success states or "healthy" data points—it pairs beautifully with the rose primary.

### Don’t:
*   **No Black:** Never use `#000000`. Use `on-surface` (#191C1D) for the darkest elements to keep the palette soft.
*   **No Hard Shadows:** Avoid the default Material Design "Elevation" shadows; they are too heavy for this "Daybreak" aesthetic.
*   **No Standard Grids:** Avoid perfectly centered, symmetrical dashboard tiles. Offset one or two elements to create a more bespoke, "designed" feel.

---

## 7. Token Reference Summary

| Token Name | Value | Usage |
| :--- | :--- | :--- |
| **Primary** | #94464F | Active states, Branding |
| **Surface** | #F8F9FA | Main application background |
| **Surface Lowest**| #FFFFFF | Cards, Content containers |
| **On Surface** | #191C1D | Primary text |
| **Secondary** | #586062 | Technical labels, Secondary text |
| **Radius-MD** | 0.75rem | Standard container roundness |
| **Spacing-3** | 1rem | Standard gutter/internal padding |