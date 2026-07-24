---
name: Frontend HTML to React Integration
description: Standard operating procedure and best practices for converting raw HTML/Tailwind mockup files into modular React pages within the Maple Tools project.
---

# Frontend HTML to React Integration

This skill documents the systematic approach to translating a static HTML mockup (usually containing raw Tailwind CSS) into a fully functional and integrated React page in the Maple Tools (SoraIndex) ecosystem.

## 1. Anatomy of the Mockup
Before writing code, analyze the provided `.html` file:
- **Discard Global Elements**: The mockup often contains navigation bars (`SideNavBar` / `TopNavBar`). Identify these and **ignore them**, as the main app layout (`Sidebar.tsx`, `App.tsx`) already handles global navigation.
- **Identify State Boundaries**: Look for inline `onclick` handlers, modals, or tab switching. These will need to be translated into `useState` hooks.

## 2. Component Creation
Create a new TypeScript React file (e.g., `src/renderer/src/pages/[PageName].tsx`).
- Copy the core `<main>` or content wrapper from the HTML.
- Convert `class` to `className`.
- Ensure self-closing tags (e.g., `<input />`, `<img />`, `<br />`) are properly closed to satisfy JSX syntax rules.
- Replace generic `onclick="document.getElementById(...).classList.add(...)"` with React state logic (`onClick={() => setIsOpen(true)}`).

## 3. Style and Token Adaptation (Crucial)
The project relies heavily on the **Daybreak Core** design system (Light/Dark mode tokens). Mockups may contain hardcoded specific colors or non-standard utility classes (like `bg-neutral-900` or `text-rose-300`). 

Map them to Project Semantic CSS Variables:
- **Backgrounds**: Use `bg-background` for the main canvas. Use `bg-surface-container`, `bg-surface-container-low`, `bg-surface-container-highest` for cards and modals.
- **Text**: Use `text-on-surface` for primary text and headings. Use `text-on-surface-variant` for secondary readouts, subtitles, or metadata.
- **Brand/Accent**: Replace arbitrary pink/red styling with `text-primary`, `bg-primary`, `shadow-primary/20`.
- **Borders/Dividers**: Use `border-outline-variant/30` or `bg-outline-variant/30` rather than `border-white/10`.

## 4. Reusing Shared Components
Do not reinvent the wheel if the mockup introduces a repeating UI pattern:
- **Search and Top Bar**: If the page features a top search bar, do not code a custom input field. Import the shared `<TopBar />` component from `src/components/TopBar.tsx`. Mount it at the top of the new page and supply it with `placeholder` and `onSearch` props.
- Let the shared component handle common logic (e.g., "Enter" keypress handling, theme toggling, quick stats).

## 5. Integrating Layout and Overlays
- **Positioning**: The global layout inside `App.tsx` has a left margin for the sidebar (`ml-64`) and acts as a scroll container. Your new page should generally be wrapped in a `<div className="relative min-h-full bg-background">`.
- **TopBar Spacer**: Because the `TopBar` component is `fixed top-0` and visually occupies `h-16`, add `pt-16` or `pt-24` padding to the top of your page wrapper to prevent content from hiding beneath the header.

## 6. Routing Hookup
- Add the component import and the `<Route />` definition in `src/renderer/src/App.tsx`.
- Open `src/renderer/src/components/Sidebar.tsx` and append a new `NavItem` to the `navItems` array to expose the page in the app menu. Order the items according to user requirement (e.g., move it to `"/"` to make it the designated home page).
